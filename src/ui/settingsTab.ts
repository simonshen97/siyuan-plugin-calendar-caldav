import type { Plugin } from "siyuan";
import type {
    AvSyncConfig,
    CalDavAccount,
    CalendarInfo,
    CalendarSource,
    PluginSettings,
    TSyncDirection,
} from "../types";
import type { SettingsStore } from "../settings";
import type { MappingStore } from "../state/mapping";
import { newAccountId } from "../settings";
import { button, checkbox, checkboxInput, closeAllDialogs, exportLogToFile, field, openDialog, openLogDialog, select, textInput } from "./dialog";
import { logger } from "../util/logger";
import { testAccount } from "./dock";
import { detectAttributeView } from "../siyuan/avStore";
import { t } from "../util/i18n";

export interface SettingsDialogOptions {
    plugin: Plugin;
    store: SettingsStore;
    /** 用于在删除账户时一并清理同步映射 */
    mappings: MappingStore;
    onChanged: () => Promise<void> | void;
    /** 调试模式：删除本插件写入的数据库行，返回删除条数 */
    onPurgeDatabaseRows: () => Promise<number>;
    /** 调试模式：清空全部同步映射，返回清理条数 */
    onPurgeMappings: () => Promise<number>;
    /** 导出配置：落盘保存，返回是否成功（失败时由调用方复制到剪贴板） */
    onExportConfig: (json: string) => Promise<boolean>;
    /** 导入配置：就地覆盖设置，返回结果 */
    onImportConfig: (json: string) => Promise<{ ok: boolean; message?: string }>;
}

const TABS = [
    { id: "accounts", label: () => t("addAccount") },
    { id: "sources", label: () => t("sourcesTitle") },
    { id: "database", label: () => t("avSyncTitle") },
    { id: "sync", label: () => t("settingsSync") },
    { id: "view", label: () => t("settingsView") },
    { id: "advanced", label: () => t("settingsAdvanced") },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * 插件设置面板：账户管理（含 CalDAV 发现）、思源数据源、同步策略、视图与高级选项。
 * 采用「即时保存」策略：控件变更即写入 `SettingsStore`，关闭时统一刷新视图。
 */
export function openSettingsDialog(options: SettingsDialogOptions): void {
    closeAllDialogs();
    let activeTab: TabId = "accounts";
    const body = document.createElement("div");
    body.className = "cc-form";
    const tabsBar = document.createElement("div");
    tabsBar.className = "cc-toolbar__group";
    const content = document.createElement("div");
    content.className = "cc-form";

    const renderTabs = () => {
        tabsBar.innerHTML = "";
        for (const tab of TABS) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = `cc-tab${tab.id === activeTab ? " cc-tab--active" : ""}`;
            btn.textContent = tab.label();
            btn.addEventListener("click", () => {
                activeTab = tab.id;
                renderTabs();
                void render();
            });
            tabsBar.append(btn);
        }
    };

    const render = async (): Promise<void> => {
        content.innerHTML = "";
        const settings = options.store.value;
        if (activeTab === "accounts") {
            content.append(...renderAccounts(settings));
        } else if (activeTab === "sources") {
            content.append(...renderSources(settings));
        } else if (activeTab === "database") {
            content.append(...renderDatabase(settings));
        } else if (activeTab === "sync") {
            content.append(...renderSync(settings));
        } else if (activeTab === "view") {
            content.append(...renderView(settings));
        } else {
            content.append(...renderAdvanced(settings));
        }
    };

    /* —— 账户 —— */

    const renderAccounts = (settings: PluginSettings): HTMLElement[] => {
        const nodes: HTMLElement[] = [];
        for (const account of settings.accounts) {
            const card = document.createElement("div");
            card.className = "cc-account-card";
            const head = document.createElement("div");
            head.className = "cc-account-card__head";
            const title = document.createElement("strong");
            title.textContent = account.name || account.serverUrl;
            // 复用统一的复选框实现（自绘方框），不要手写裸 input
            const enabledHolder = checkbox(account.enabled, t("enabled"));
            const enabledInput = checkboxInput(enabledHolder);
            enabledInput.addEventListener("change", () => {
                void updateAccount(account.id, (item) => {
                    item.enabled = enabledInput.checked;
                });
            });
            head.append(title, enabledHolder);
            card.append(head);

            const urlInput = textInput(account.serverUrl, "url");
            urlInput.placeholder = "https://cloud.example.com/remote.php/dav";
            urlInput.addEventListener("change", () => {
                void updateAccount(account.id, (item) => {
                    item.serverUrl = urlInput.value.trim();
                });
            });
            card.append(field(t("serverUrl"), urlInput, t("serverUrlHint")));

            const row = document.createElement("div");
            row.className = "cc-form cc-form--row";
            const nameInput = textInput(account.name);
            nameInput.addEventListener("change", () => {
                void updateAccount(account.id, (item) => {
                    item.name = nameInput.value.trim();
                });
            });
            const userInput = textInput(account.username);
            userInput.addEventListener("change", () => {
                void updateAccount(account.id, (item) => {
                    item.username = userInput.value.trim();
                });
            });
            row.append(field(t("accountName"), nameInput), field(t("username"), userInput));
            card.append(row);

            const secretNameInput = textInput(account.passwordSecret ?? "");
            secretNameInput.addEventListener("change", () => {
                void updateAccount(account.id, (item) => {
                    item.passwordSecret = secretNameInput.value.trim() || undefined;
                });
            });
            card.append(field(t("passwordSecretName"), secretNameInput, t("passwordSecretHint")));

            const passwordInput = textInput(account.password ?? "", "password");
            passwordInput.addEventListener("change", () => {
                void updateAccount(account.id, (item) => {
                    item.password = passwordInput.value || undefined;
                });
            });
            card.append(field(t("password"), passwordInput));

            const authSelect = select(
                [
                    { value: "basic", label: "Basic（推荐）" },
                    { value: "bearer", label: "Bearer" },
                ],
                account.authType ?? "basic",
            );
            authSelect.addEventListener("change", () => {
                void updateAccount(account.id, (item) => {
                    item.authType = authSelect.value as CalDavAccount["authType"];
                });
            });
            card.append(
                field(
                    t("authType"),
                    authSelect,
                    "内核转发不支持 Digest 挑战；Digest 服务器请使用「应用专用密码」或反向代理开启 Basic。",
                ),
            );

            const directionSelect = select(
                [
                    { value: "both", label: t("directionBoth") },
                    { value: "pull", label: t("directionPull") },
                    { value: "push", label: t("directionPush") },
                    { value: "off", label: t("directionOff") },
                ],
                account.syncDirection ?? settings.sync.direction,
            );
            directionSelect.addEventListener("change", () => {
                void updateAccount(account.id, (item) => {
                    item.syncDirection = directionSelect.value as TSyncDirection;
                });
            });
            card.append(field(t("direction"), directionSelect));

            const actionRow = document.createElement("div");
            actionRow.className = "cc-dialog__actions";
            const testButton = button(t("testConnection"));
            const discoverButton = button(t("discover"), "primary");
            const removeButton = button(t("deleteAccount"), "danger");
            const status = document.createElement("span");
            status.className = "cc-field__hint";
            actionRow.append(removeButton, status, testButton, discoverButton);
            card.append(actionRow);

            const runDiscovery = async (): Promise<void> => {
                discoverButton.disabled = true;
                status.textContent = t("discovering");
                const secret = resolveSecret(options.plugin, account);
                const result = await testAccount(account, secret, settings.advanced.requestTimeoutMs);
                discoverButton.disabled = false;
                if (!result.ok) {
                    status.textContent = `${t("discoverFailed")}: ${result.message ?? ""}`;
                    status.classList.add("cc-hint--warn");
                    await updateAccount(account.id, (item) => {
                        item.lastError = result.message;
                    });
                    return;
                }
                status.classList.remove("cc-hint--warn");
                const merged = mergeCalendars(account.calendars ?? [], result.calendars);
                if (merged.length) {
                    status.textContent = t("discoverOk", { n: String(merged.length) });
                    setStatus(t("discoverOk", { n: String(merged.length) }));
                } else {
                    // 服务端返回了 207 但没有任何日历集合。QQ 邮箱等实现属于这种情况：
                    // 它不是「连不上」，而是不通过 PROPFIND 暴露集合，需要在下方手动填写集合地址。
                    status.classList.add("cc-hint--warn");
                    status.textContent = t("noCalendarsFound");
                    setStatus(t("discoverEmptyHint"), true);
                }
                await updateAccount(account.id, (item) => {
                    item.calendars = merged;
                    item.lastError = undefined;
                    item.homeSet = result.homeSet ?? item.homeSet;
                });
                await render();
                await options.onChanged();
            };

            discoverButton.addEventListener("click", () => void runDiscovery());
            testButton.addEventListener("click", async () => {
                testButton.disabled = true;
                status.textContent = t("discovering");
                const secret = resolveSecret(options.plugin, account);
                const result = await testAccount(account, secret, settings.advanced.requestTimeoutMs);
                testButton.disabled = false;
                status.classList.toggle("cc-hint--warn", !result.ok);
                status.textContent = result.ok
                    ? `${t("testOk")}（${result.calendars.length}）`
                    : `${t("testFailed")}: ${result.message ?? ""}`;
            });
            removeButton.addEventListener("click", async () => {
                // 先清理该账户下所有日历的同步映射，避免留下孤立的映射与属性
                for (const info of account.calendars ?? []) {
                    if (info.source.kind === "caldav") {
                        options.mappings.deleteByCalendar(info.source.calendarUrl);
                    }
                }
                await options.mappings.flush().catch(() => undefined);
                await options.store.removeAccount(account.id);
                await render();
                await options.onChanged();
            });

            const calendars = account.calendars ?? [];
            const manualInput = document.createElement("textarea");
            manualInput.className = "b3-text-field cc-textarea";
            manualInput.rows = 2;
            manualInput.placeholder = "https://dav.qq.com/calendar/你的邮箱%40qq.com/日历名/";
            manualInput.value = (account.manualCalendarUrls ?? []).join("\n");
            manualInput.addEventListener("change", () => {
                void updateAccount(account.id, (item) => {
                    item.manualCalendarUrls = manualInput.value
                        .split(/\r?\n/)
                        .map((line) => line.trim())
                        .filter(Boolean);
                });
                setStatus(t("manualCalendarsSaved"));
                void render();
                void options.onChanged();
            });
            card.append(
                field(
                    t("manualCalendars"),
                    manualInput,
                    "发现日历为空、或服务端不返回日历集合时填写（每行一个）。QQ 邮箱属于这种情况。",
                ),
            );
            if (calendars.length) {
                const picker = document.createElement("div");
                picker.className = "cc-calendar-picker";
                for (const info of calendars) {
                    const item = document.createElement("label");
                    item.className = "cc-calendar-picker__item";
                    // 勾选 = 允许写入（readOnly 的反面）；用统一的自绘复选框，避免白字/白框问题
                    const checkWrap = checkbox(!info.readOnly, "");
                    const input = checkboxInput(checkWrap);
                    input.title = t("readOnly");
                    input.addEventListener("change", () => {
                        void updateAccount(account.id, (target) => {
                            target.calendars = (target.calendars ?? []).map((entry) => {
                                if (entry.id !== info.id || entry.source.kind !== "caldav") {
                                    return entry;
                                }
                                return {
                                    ...entry,
                                    readOnly: !input.checked,
                                    source: { ...entry.source, readOnly: !input.checked },
                                };
                            });
                        });
                        void options.onChanged();
                    });
                    const dot = document.createElement("span");
                    dot.className = "cc-sidebar__dot";
                    dot.style.background = info.color ?? "var(--cc-accent)";
                    const label = document.createElement("span");
                    label.className = "cc-sidebar__name";
                    label.textContent = info.name;
                    const badge = document.createElement("span");
                    badge.className = info.readOnly ? "cc-badge" : "cc-badge cc-badge--on";
                    badge.textContent = info.readOnly ? t("readOnly") : t("enabled");
                    item.append(checkWrap, dot, label, badge);
                    picker.append(item);
                }
                card.append(field(t("view"), picker));
            }
            nodes.push(card);
        }

        const addButton = button(t("addAccount"), "primary");
        addButton.addEventListener("click", async () => {
            const account: CalDavAccount = {
                id: newAccountId(),
                name: "CalDAV",
                serverUrl: "",
                username: "",
                enabled: true,
            };
            await options.store.upsertAccount(account);
            setStatus(t("accountAdded"));
            await render();
        });
        nodes.push(addButton);
        return nodes;
    };

    const updateAccount = async (id: string, mutator: (account: CalDavAccount) => void): Promise<void> => {
        await options.store.update((settings) => {
            const account = settings.accounts.find((item) => item.id === id);
            if (account) {
                mutator(account);
            }
        });
    };

    /* —— 数据源 —— */

    const renderSources = (settings: PluginSettings): HTMLElement[] => {
        const nodes: HTMLElement[] = [];
        const hint = document.createElement("div");
        hint.className = "cc-field__hint";
        hint.textContent = t("avHint");
        nodes.push(hint);

        // 索引需要与设置数组下标保持一致，因此用显式循环
        settings.localSources.forEach((source, index) => {
            if (source.kind === "av") {
                nodes.push(renderAvSource(source, index));
                return;
            }
            if (source.kind !== "query") {
                return;
            }
            const card = document.createElement("div");
            card.className = "cc-account-card";
            const label = textInput(source.label ?? "", "text");
            label.addEventListener("change", () => {
                void updateSource(index, (target) => {
                    if (target.kind === "query") {
                        target.label = label.value.trim();
                    }
                });
            });
            const dateAttr = textInput(source.dateAttr);
            dateAttr.placeholder = "due";
            dateAttr.addEventListener("change", () => {
                void updateSource(index, (target) => {
                    if (target.kind === "query") {
                        target.dateAttr = dateAttr.value.trim();
                    }
                });
            });
            const endAttr = textInput(source.endDateAttr ?? "");
            endAttr.addEventListener("change", () => {
                void updateSource(index, (target) => {
                    if (target.kind === "query") {
                        target.endDateAttr = endAttr.value.trim() || undefined;
                    }
                });
            });
            const stmt = document.createElement("textarea");
            stmt.className = "b3-text-field cc-textarea";
            stmt.rows = 3;
            stmt.value = source.stmt ?? "";
            stmt.addEventListener("change", () => {
                void updateSource(index, (target) => {
                    if (target.kind === "query") {
                        target.stmt = stmt.value.trim();
                    }
                });
            });
            const removeButton = button(t("delete"), "danger");
            removeButton.addEventListener("click", async () => {
                await options.store.update((target) => {
                    target.localSources.splice(index, 1);
                });
                await render();
                await options.onChanged();
            });
            card.append(
                field(t("accountName"), label),
                field(t("queryDateAttr"), dateAttr),
                field(t("queryEndAttr"), endAttr),
                field(t("querySql"), stmt),
                removeButton,
            );
            nodes.push(card);
        });

        const addQuery = button(t("addQuerySource"));
        addQuery.addEventListener("click", async () => {
            await options.store.update((settingsTarget) => {
                const source: CalendarSource = {
                    kind: "query",
                    stmt: "",
                    dateAttr: "due",
                    titleField: "content",
                    label: "自定义属性日程",
                    color: "#8b5cf6",
                };
                settingsTarget.localSources.push(source);
            });
            await render();
            await options.onChanged();
        });
        const addAv = button(t("addAvSource"));
        addAv.addEventListener("click", async () => {
            await options.store.update((settingsTarget) => {
                const source: CalendarSource = {
                    kind: "av",
                    avID: "",
                    blockID: "",
                    label: "数据库日历",
                };
                settingsTarget.localSources.push(source);
            });
            await render();
            await options.onChanged();
        });
        nodes.push(addAv);
        return nodes;
    };

    /** 数据源卡片：数据库（属性视图）日历 */
    const renderAvSource = (source: Extract<CalendarSource, { kind: "av" }>, index: number): HTMLElement => {
        const card = document.createElement("div");
        card.className = "cc-account-card";
        const status = document.createElement("span");
        status.className = "cc-field__hint";

        const avIDInput = textInput(source.avID);
        avIDInput.placeholder = "20240118120204-kwyzf77";
        const labelInput = textInput(source.label ?? "");
        const dateSelect = select(
            [{ value: source.dateKeyID ?? "", label: source.dateKeyID || t("detect") }],
            source.dateKeyID ?? "",
        );
        const titleSelect = select(
            [{ value: source.titleKeyID ?? "", label: source.titleKeyID || "（自动）" }],
            source.titleKeyID ?? "",
        );

        const fillFieldOptions = (fields: { id: string; name: string; type: string }[]): void => {
            const options = fields.map((field) => ({
                value: field.id,
                label: `${field.name}（${field.type || "?"}）`,
            }));
            const rebuild = (element: HTMLSelectElement, current: string, emptyLabel: string): void => {
                element.innerHTML = "";
                element.append(new Option(emptyLabel, ""));
                for (const option of options) {
                    element.append(new Option(option.label, option.value));
                }
                element.value = current && options.some((option) => option.value === current) ? current : "";
            };
            rebuild(dateSelect, source.dateKeyID ?? "", "（自动检测）");
            rebuild(titleSelect, source.titleKeyID ?? "", "（自动）");
        };

        avIDInput.addEventListener("change", () => {
            void updateSource(index, (target) => {
                if (target.kind === "av") {
                    target.avID = avIDInput.value.trim();
                    // 块 ID 与属性视图 ID 可能相同，先原样记录，检测后再校正
                    target.blockID = avIDInput.value.trim();
                }
            });
        });
        labelInput.addEventListener("change", () => {
            void updateSource(index, (target) => {
                if (target.kind === "av") {
                    target.label = labelInput.value.trim();
                }
            });
        });
        dateSelect.addEventListener("change", () => {
            void updateSource(index, (target) => {
                if (target.kind === "av") {
                    target.dateKeyID = dateSelect.value || undefined;
                }
            });
        });
        titleSelect.addEventListener("change", () => {
            void updateSource(index, (target) => {
                if (target.kind === "av") {
                    target.titleKeyID = titleSelect.value || undefined;
                }
            });
        });

        const detectButton = button(t("detect"), "primary");
        detectButton.addEventListener("click", async () => {
            const id = avIDInput.value.trim();
            if (!id) {
                status.textContent = t("avHint");
                status.classList.add("cc-hint--warn");
                return;
            }
            detectButton.disabled = true;
            status.textContent = t("discovering");
            const detected = await detectAttributeView(id, source.viewID);
            detectButton.disabled = false;
            if (!detected || !detected.fields.length) {
                status.classList.add("cc-hint--warn");
                status.textContent = `${t("discoverFailed")}：未读取到字段，请确认 ID 为属性视图 ID（avID）。`;
                return;
            }
            status.classList.remove("cc-hint--warn");
            status.textContent = `${detected.name} · ${detected.fields.length} 个字段${
                detected.viewType ? ` · ${detected.viewType}` : ""
            }`;
            fillFieldOptions(detected.fields);
            await updateSource(index, (target) => {
                if (target.kind !== "av") {
                    return;
                }
                target.viewID = detected.viewID ?? target.viewID;
                target.label = target.label || detected.name;
                if (!target.dateKeyID) {
                    target.dateKeyID =
                        detected.calendarDateKeyID ??
                        detected.fields.find((field) => field.type === "date")?.id;
                }
                if (!target.titleKeyID) {
                    target.titleKeyID = detected.fields.find(
                        (field) => field.id !== target.dateKeyID && (field.type === "text" || field.type === "block"),
                    )?.id;
                }
            });
            dateSelect.value = options.store.value.localSources[index]?.kind === "av"
                ? ((options.store.value.localSources[index] as { dateKeyID?: string }).dateKeyID ?? "")
                : "";
            await render();
        });
        const removeButton = button(t("delete"), "danger");
        removeButton.addEventListener("click", async () => {
            await options.store.update((target) => {
                target.localSources.splice(index, 1);
            });
            await render();
            await options.onChanged();
        });

        const actions = document.createElement("div");
        actions.className = "cc-dialog__actions";
        actions.append(removeButton, status, detectButton);

        card.append(
            field(t("avID"), avIDInput, t("avHint")),
            field(t("accountName"), labelInput),
            field(t("dateField"), dateSelect, "留空则自动选择 date/created/updated 字段"),
            field(t("titleField"), titleSelect),
            actions,
        );
        return card;
    };

    /* —— 数据库块（属性视图）同步 —— */

    /**
     * 「数据库块」配置页。
     *
     * 交互与「数据源」页签一致：填数据库块 ID → 点「读取字段」→ 自动列出所有列，
     * 再用下拉框逐项匹配（日期列必填，其余可选）。未绑定的列不会被写入。
     */
    const renderDatabase = (settings: PluginSettings): HTMLElement[] => {
        const nodes: HTMLElement[] = [];
        const config = settings.avSync;

        const hint = document.createElement("div");
        hint.className = "cc-field__hint";
        hint.textContent = t("avSyncHint");
        nodes.push(hint);

        // 配置看似完整但开关是关的 → 必须显眼提示：否则同步跑得好好的却「什么都不写」，
        // 日志里只有一行 `target=read-only`，很难自己发现（实测踩过）。
        if (config?.avID && config.dateKeyID && !config.enabled) {
            const warn = document.createElement("div");
            warn.className = "cc-field__hint cc-hint--warn";
            warn.textContent = t("avSyncDisabledWarning");
            nodes.push(warn);
        }

        const card = document.createElement("div");
        card.className = "cc-account-card";

        const avIDInput = textInput(config?.avID ?? "");
        avIDInput.placeholder = "20240118120204-kwyzf77";
        const enabledWrap = checkbox(config?.enabled ?? true, t("avSyncEnabled"));
        const directionSelect = select(
            [
                { value: "pull", label: t("avSyncPullOnly") },
                { value: "both", label: t("avSyncBoth") },
            ],
            config?.direction ?? "pull",
        );

        /** 列 keyID → 下拉框；未检测到字段时给出占位项 */
        type BindingKey =
            | "dateKeyID"
            | "titleKeyID"
            | "endKeyID"
            | "descriptionKeyID"
            | "locationKeyID"
            | "calendarKeyID"
            | "uidKeyID"
            | "markerKeyID"
            | "statusKeyID";
        const taskKeys: BindingKey[] = [
            "endKeyID",
            "descriptionKeyID",
            "locationKeyID",
            "calendarKeyID",
            "uidKeyID",
            "markerKeyID",
            "statusKeyID",
        ];
        const selectors = new Map<BindingKey, HTMLSelectElement>();
        const mkSelect = (key: BindingKey, label: string, emptyLabel: string): void => {
            const element = select([{ value: config?.[key] ?? "", label: config?.[key] ?? emptyLabel }], config?.[key] ?? "");
            element.disabled = true;
            element.addEventListener("change", () => {
                void patchAvSync((target) => {
                    const value = element.value;
                    if (key === "dateKeyID") {
                        target.dateKeyID = value;
                    } else if (value) {
                        target[key] = value;
                    } else {
                        delete target[key];
                    }
                });
            });
            selectors.set(key, element);
            nodes.push(field(label, element));
        };

        const patchAvSync = async (mutator: (target: AvSyncConfig) => void): Promise<void> => {
            await options.store.update((target) => {
                const base: AvSyncConfig = target.avSync ?? {
                    avID: "",
                    enabled: true,
                    dateKeyID: "",
                    direction: "pull",
                };
                target.avSync = base;
                mutator(base);
            });
            await options.onChanged();
        };

        avIDInput.addEventListener("change", () => {
            const value = avIDInput.value.trim();
            void patchAvSync((target) => {
                // 输入框里放的是「块 ID」，改了它就意味着换库：
                // 旧的 avID / viewID / 字段绑定全部作废（否则内核会报 `view not found`）。
                const changed = value !== (target.blockID ?? target.avID ?? "");
                target.blockID = value || undefined;
                if (value && !target.avID) {
                    target.avID = value;
                }
                if (changed) {
                    target.viewID = undefined;
                    for (const key of taskKeys) {
                        delete target[key];
                    }
                    delete target.titleKeyID;
                    target.dateKeyID = "";
                    logger.log(`数据库块 ID 已改为 ${value || "（空）"}：请点「读取字段」重新绑定`);
                }
            });
        });
        checkboxInput(enabledWrap).addEventListener("change", () => {
            void patchAvSync((target) => {
                target.enabled = checkboxInput(enabledWrap).checked;
            });
        });
        directionSelect.addEventListener("change", () => {
            void patchAvSync((target) => {
                target.direction = directionSelect.value === "both" ? "both" : "pull";
            });
        });

        const detectButton = button(t("avSyncDetect"), "primary");
        const status = document.createElement("span");
        status.className = "cc-field__hint";

        /**
         * 用检测到的字段刷新所有下拉框。
         * 类型不匹配的列会被标注出来（例如把「日期」列选到标题上），但不强制拦截。
         */
        const fillSelectors = (fields: Array<{ id: string; name: string; type: string }>): void => {
            for (const [key, element] of selectors) {
                const current = element.value;
                element.innerHTML = "";
                element.disabled = false;
                element.append(new Option(key === "dateKeyID" ? t("avSyncPickDate") : t("avSyncPickNone"), ""));
                for (const item of fields) {
                    element.append(new Option(`${item.name}（${item.type || "?"}）`, item.id));
                }
                element.value = current && fields.some((item) => item.id === current) ? current : "";
            }
        };

        detectButton.addEventListener("click", async () => {
            const id = avIDInput.value.trim();
            if (!id) {
                status.classList.add("cc-hint--warn");
                status.textContent = t("avSyncNeedID");
                return;
            }
            detectButton.disabled = true;
            status.classList.remove("cc-hint--warn");
            status.textContent = t("discovering");
            logger.log(`数据库同步：读取字段 avID/blockID=${id}`);
            const detected = await detectAttributeView(id, config?.viewID);
            detectButton.disabled = false;
            if (!detected || !detected.fields.length) {
                status.classList.add("cc-hint--warn");
                status.textContent = t("avSyncDetectFailed");
                logger.error(`读取数据库字段失败：${id}（未返回任何列）`);
                return;
            }
            status.textContent = `${detected.name} · ${detected.fields.length} ${t("avSyncFields")}${
                detected.viewType ? ` · ${detected.viewType}` : ""
            }`;
            // 把字段清单（名称/类型/keyID）写进日志：绑定错列时可直接对照
            logger.log(`数据库字段：${detected.fieldsSummary ?? ""}`);
            logger.log(`解析出的 avID=${detected.resolvedAvID ?? id}，viewID=${detected.viewID ?? "（默认）"}`);
            fillSelectors(detected.fields);
            // 自动推断：日期列优先用日历布局绑定的那列，其次第一个 date 列；标题列用第一个文本列。
            //
            // 关键：**换数据库时必须清空旧绑定**。旧数据库的 keyID 在新库里不存在或含义不同，
            // 留着会写出错误数据（甚至因为维度不匹配而写入失败）。
            await patchAvSync((target) => {
                const switched = Boolean(target.avID) && Boolean(detected.resolvedAvID) && target.avID !== detected.resolvedAvID;
                if (switched) {
                    for (const key of taskKeys) {
                        delete target[key];
                    }
                    delete target.titleKeyID;
                    target.dateKeyID = "";
                    logger.log(
                        `数据库已切换（${target.avID} → ${detected.resolvedAvID}）：已清空原字段绑定，请重新选择列`,
                    );
                }
                // 块 ID 与属性视图 ID 不同：写入内核接口要用解析出的 avID，
                // 写行属性要用块 ID，两个都记下来
                target.blockID = id;
                if (detected.resolvedAvID) {
                    target.avID = detected.resolvedAvID;
                }
                // 视图 ID 必须跟着当前数据库：旧的 viewID 在库里不存在会让内核抛 `view not found`
                target.viewID = detected.viewID;
                if (!target.dateKeyID) {
                    target.dateKeyID =
                        detected.calendarDateKeyID ?? detected.fields.find((item) => item.type === "date")?.id ?? "";
                }
                if (!target.titleKeyID) {
                    target.titleKeyID = detected.fields.find(
                        (item) => item.id !== target.dateKeyID && (item.type === "text" || item.type === "block"),
                    )?.id;
                }
            });
            for (const [key, element] of selectors) {
                const value = options.store.value.avSync?.[key] ?? "";
                element.value = value && detected.fields.some((item) => item.id === value) ? value : "";
            }
            // 读取成功且已有日期列 → 自动启用落库同步。
            // 否则用户很容易停在「绑定好了但 enabled=false」的状态：同步日志显示 target=read-only、
            // 什么都不写，且界面上没有明显提示（v0.6.5 的换库清空逻辑加重了这一点）。
            const finalConfig = options.store.value.avSync;
            if (finalConfig?.avID && finalConfig.dateKeyID && !finalConfig.enabled) {
                await patchAvSync((target) => {
                    target.enabled = true;
                });
                logger.log("数据库落库同步已自动启用（读取字段成功且已绑定日期列）");
            }
            if (!options.store.value.avSync?.enabled) {
                status.classList.add("cc-hint--warn");
                status.textContent = `${status.textContent} · ${t("avSyncStillDisabled")}`;
                logger.warn("数据库落库同步仍处于停用状态：同步不会写入数据库");
            }
        });

        const actions = document.createElement("div");
        actions.className = "cc-dialog__actions";
        actions.append(status, detectButton);

        card.append(
            field(t("avSyncBlockID"), avIDInput, t("avSyncBlockIDHint")),
            enabledWrap,
            field(t("avSyncDirection"), directionSelect),
            actions,
        );
        nodes.push(card);

        const fieldsTitle = document.createElement("div");
        fieldsTitle.className = "cc-field__hint";
        fieldsTitle.textContent = t("avSyncFieldsHint");
        nodes.push(fieldsTitle);

        mkSelect("dateKeyID", t("avSyncFieldDate"), t("avSyncPickDate"));
        mkSelect("titleKeyID", t("avSyncFieldTitle"), t("avSyncPickNone"));
        mkSelect("endKeyID", t("avSyncFieldEnd"), t("avSyncPickNone"));
        mkSelect("descriptionKeyID", t("avSyncFieldDescription"), t("avSyncPickNone"));
        mkSelect("locationKeyID", t("avSyncFieldLocation"), t("avSyncPickNone"));
        mkSelect("calendarKeyID", t("avSyncFieldCalendar"), t("avSyncPickNone"));
        mkSelect("uidKeyID", t("avSyncFieldUid"), t("avSyncPickNone"));
        mkSelect("markerKeyID", t("avSyncFieldMarker"), t("avSyncPickNone"));
        mkSelect("statusKeyID", t("avSyncFieldStatus"), t("avSyncPickNone"));

        const footer = document.createElement("div");
        footer.className = "cc-field__hint";
        footer.textContent = t("avSyncFooterHint");
        nodes.push(footer);

        // 已有配置时（例如重启插件后重新打开设置）立即尝试读取一次字段，
        // 让下拉框直接可用，不必每次手动点「读取字段」。
        if (config?.avID && config.dateKeyID) {
            void detectAttributeView(config.avID, config.viewID)                .then((detected) => {
                    if (detected?.fields.length) {
                        fillSelectors(detected.fields);
                        for (const [key, element] of selectors) {
                            const value = options.store.value.avSync?.[key] ?? "";
                            element.value = value && detected.fields.some((item) => item.id === value) ? value : "";
                        }
                        status.textContent = `${detected.name} · ${detected.fields.length} ${t("avSyncFields")}`;
                    }
                })
                .catch(() => undefined);
        }
        return nodes;
    };

    const updateSource = async (index: number, mutator: (source: CalendarSource) => void): Promise<void> => {
        await options.store.update((settings) => {
            const source = settings.localSources[index];
            if (source) {
                mutator(source);
            }
        });
        await options.onChanged();
    };

    /* —— 同步 —— */

    const renderSync = (settings: PluginSettings): HTMLElement[] => {
        const nodes: HTMLElement[] = [];
        const directionSelect = select(
            [
                { value: "both", label: t("directionBoth") },
                { value: "pull", label: t("directionPull") },
                { value: "push", label: t("directionPush") },
                { value: "off", label: t("directionOff") },
            ],
            settings.sync.direction,
        );
        directionSelect.addEventListener("change", () => {
            void patchSync((sync) => {
                sync.direction = directionSelect.value as TSyncDirection;
            });
        });
        nodes.push(field(t("defaultDirection"), directionSelect));

        const conflictSelect = select(
            [
                { value: "remote", label: t("conflictRemote") },
                { value: "local", label: t("conflictLocal") },
                { value: "duplicate", label: t("conflictDuplicate") },
                { value: "skip", label: t("conflictSkip") },
            ],
            settings.sync.conflictPolicy,
        );
        conflictSelect.addEventListener("change", () => {
            void patchSync((sync) => {
                sync.conflictPolicy = conflictSelect.value as PluginSettings["sync"]["conflictPolicy"];
            });
        });
        nodes.push(field(t("conflictPolicy"), conflictSelect));

        const pastInput = numberInput(settings.sync.pastDays);
        pastInput.addEventListener("change", () => {
            void patchSync((sync) => {
                sync.pastDays = clampInt(pastInput.value, 0, 3650, 90);
            });
        });
        const futureInput = numberInput(settings.sync.futureDays);
        futureInput.addEventListener("change", () => {
            void patchSync((sync) => {
                sync.futureDays = clampInt(futureInput.value, 0, 3650, 180);
            });
        });
        nodes.push(field(t("pastDays"), pastInput), field(t("futureDays"), futureInput));

        const intervalInput = numberInput(settings.sync.intervalMinutes);
        intervalInput.addEventListener("change", () => {
            void patchSync((sync) => {
                sync.intervalMinutes = clampInt(intervalInput.value, 0, 1440, 15);
            });
            void options.onChanged();
        });
        nodes.push(field(t("interval"), intervalInput));

        const pathInput = textInput(settings.sync.pathTemplate);
        pathInput.addEventListener("change", () => {
            void patchSync((sync) => {
                sync.pathTemplate = pathInput.value.trim() || "/日历/${yyyy}/${MM}";
            });
        });
        nodes.push(field(t("pathTemplate"), pathInput));

        const pushWrap = checkbox(settings.sync.pushLocalChanges, t("pushLocalChanges"));
        checkboxInput(pushWrap).addEventListener("change", () => {
            void patchSync((sync) => {
                sync.pushLocalChanges = checkboxInput(pushWrap).checked;
            });
        });
        nodes.push(pushWrap);

        const deleteWrap = checkbox(
            settings.sync.deleteLocalWhenRemoteDeleted,
            t("deleteLocalWhenRemoteDeleted"),
        );
        checkboxInput(deleteWrap).addEventListener("change", () => {
            void patchSync((sync) => {
                sync.deleteLocalWhenRemoteDeleted = checkboxInput(deleteWrap).checked;
            });
        });
        nodes.push(deleteWrap);

        const notebookSelect = buildNotebookSelect(settings.sync.targetNotebook);
        notebookSelect.addEventListener("change", () => {
            void patchSync((sync) => {
                sync.targetNotebook = notebookSelect.value;
            });
        });
        nodes.push(field(t("targetNotebook"), notebookSelect));

        // 未选择目标笔记本时明确告知：同步不会在思源里落库，
        // 避免用户误以为「事件会写进我自己绑定的数据库」。
        const notebookHint = document.createElement("div");
        notebookHint.className = "cc-field__hint";
        notebookHint.textContent = t("docSyncDisabled");
        nodes.push(notebookHint);

        const attrInput = textInput(settings.sync.attrPrefix);
        attrInput.addEventListener("change", () => {
            void patchSync((sync) => {
                sync.attrPrefix = attrInput.value.trim().replace(/^custom-/, "") ? `custom-${attrInput.value.trim().replace(/^custom-/, "")}` : "custom-";
            });
        });
        nodes.push(field(t("attrPrefix"), attrInput));

        const selfSigned = document.createElement("div");
        selfSigned.className = "cc-field__hint";
        selfSigned.textContent = t("selfSignedHint");
        nodes.push(selfSigned);
        return nodes;
    };

    const patchSync = async (mutator: (sync: PluginSettings["sync"]) => void): Promise<void> => {
        await options.store.update((settings) => {
            mutator(settings.sync);
        });
    };

    /* —— 视图 —— */

    const renderView = (settings: PluginSettings): HTMLElement[] => {
        const nodes: HTMLElement[] = [];
        const modeSelect = select(
            [
                { value: "month", label: t("monthView") },
                { value: "week", label: t("weekView") },
                { value: "day", label: t("dayView") },
                { value: "agenda", label: t("agendaTitle") },
            ],
            settings.view.defaultMode,
        );
        modeSelect.addEventListener("change", () => {
            void options.store.update((target) => {
                target.view.defaultMode = modeSelect.value as PluginSettings["view"]["defaultMode"];
            });
            void options.onChanged();
        });
        nodes.push(field(t("defaultMode"), modeSelect));

        const weekStartSelect = select(
            [0, 1, 2, 3, 4, 5, 6].map((value) => ({
                value: String(value),
                label: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][value],
            })),
            String(settings.view.weekStart),
        );
        weekStartSelect.addEventListener("change", () => {
            void options.store.update((target) => {
                target.view.weekStart = parseInt(weekStartSelect.value, 10) as PluginSettings["view"]["weekStart"];
            });
            void options.onChanged();
        });
        nodes.push(field(t("weekStart"), weekStartSelect));

        nodes.push(
            toggleField(settings.view.showLunar, t("showLunar"), async (checked) => {
                await options.store.update((target) => {
                    target.view.showLunar = checked;
                });
                await options.onChanged();
            }),
            toggleField(settings.view.showWeekNumber, t("showWeekNumber"), async (checked) => {
                await options.store.update((target) => {
                    target.view.showWeekNumber = checked;
                });
                await options.onChanged();
            }),
            toggleField(settings.view.showTimeInMonth, t("showTimeInMonth"), async (checked) => {
                await options.store.update((target) => {
                    target.view.showTimeInMonth = checked;
                });
                await options.onChanged();
            }),
            toggleField(settings.view.highlightToday, t("highlightToday"), async (checked) => {
                await options.store.update((target) => {
                    target.view.highlightToday = checked;
                });
                await options.onChanged();
            }),
        );

        const hourSelect = select(
            [
                { value: "24", label: t("hour24") },
                { value: "12", label: t("hour12") },
            ],
            String(settings.view.hourCycle),
        );
        hourSelect.addEventListener("change", () => {
            void options.store.update((target) => {
                target.view.hourCycle = hourSelect.value === "12" ? 12 : 24;
            });
            void options.onChanged();
        });
        nodes.push(field(t("hourCycle"), hourSelect));

        const densitySelect = select(
            [
                { value: "comfortable", label: t("densityComfortable") },
                { value: "compact", label: t("densityCompact") },
            ],
            settings.view.density,
        );
        densitySelect.addEventListener("change", () => {
            void options.store.update((target) => {
                target.view.density = densitySelect.value === "compact" ? "compact" : "comfortable";
            });
            void options.onChanged();
        });
        nodes.push(field(t("density"), densitySelect));

        const durationInput = numberInput(settings.view.defaultDuration);
        durationInput.addEventListener("change", () => {
            void options.store.update((target) => {
                target.view.defaultDuration = clampInt(durationInput.value, 5, 1440, 60);
            });
        });
        nodes.push(field(t("defaultDuration"), durationInput));
        return nodes;
    };

    /* —— 高级 —— */

    const renderAdvanced = (settings: PluginSettings): HTMLElement[] => {
        const nodes: HTMLElement[] = [];
        const timeoutInput = numberInput(settings.advanced.requestTimeoutMs);
        timeoutInput.addEventListener("change", () => {
            void options.store.update((target) => {
                target.advanced.requestTimeoutMs = clampInt(timeoutInput.value, 3_000, 300_000, 30_000);
            });
        });
        const concurrencyInput = numberInput(settings.advanced.concurrency);
        concurrencyInput.addEventListener("change", () => {
            void options.store.update((target) => {
                target.advanced.concurrency = clampInt(concurrencyInput.value, 1, 16, 4);
            });
        });
        nodes.push(
            field(t("requestTimeout"), timeoutInput),
            field(t("concurrency"), concurrencyInput),
            toggleField(settings.advanced.debug, t("debug"), async (checked) => {
                await options.store.update((target) => {
                    target.advanced.debug = checked;
                });
                logger.setEnabled(checked);
            }),
            toggleField(settings.advanced.acceptInsecureTLS, t("acceptInsecureTLS"), async (checked) => {
                await options.store.update((target) => {
                    target.advanced.acceptInsecureTLS = checked;
                });
            }),
        );
        // 日志查看入口放在最容易找到的地方之一，并提供复制按钮（便于反馈问题）
        const actions = document.createElement("div");
        actions.className = "cc-dialog__actions";
        const viewLogs = button(t("viewLogs"));
        viewLogs.addEventListener("click", () => openLogDialog(options.plugin));
        const systemLog = button(t("openSystemLog"));
        systemLog.addEventListener("click", () => {
            options.plugin.addSystemLogItem();
            setStatus(t("systemLogHint"));
        });
        actions.append(viewLogs, systemLog);
        // 日志导出到文件：日志很大时（含请求体）比复制更可靠
        const exportLogs = button(t("logsExport"));
        exportLogs.addEventListener("click", () => {
            void exportLogToFile(options.plugin).then((path) => {
                setStatus(path ? t("logsExported", { path }) : t("logsExportFailed"), !path);
            });
        });
        actions.append(exportLogs);
        nodes.push(actions);
        const hint = document.createElement("div");
        hint.className = "cc-field__hint";
        hint.textContent = t("selfSignedHint");
        nodes.push(hint);

        /* —— 调试模式（默认关闭，开启后才有清理能力） —— */

        nodes.push(toggleField(settings.advanced.debugMode, t("debugMode"), async (checked) => {
            await options.store.update((target) => {
                target.advanced.debugMode = checked;
                // 打开调试模式时顺带打开详细日志，便于定位
                if (checked) {
                    target.advanced.debug = true;
                }
            });
            logger.setEnabled(options.store.value.advanced.debug);
            void render();
        }));
        const debugHint = document.createElement("div");
        debugHint.className = "cc-field__hint";
        debugHint.textContent = t("debugModeHint");
        nodes.push(debugHint);

        if (settings.advanced.debugMode) {
            const cleanup = document.createElement("div");
            cleanup.className = "cc-dialog__actions";

            const purgeRows = button(t("purgeDatabaseRows"), "danger");
            purgeRows.addEventListener("click", async () => {
                const config = options.store.value.avSync;
                if (!config?.avID) {
                    setStatus(t("purgeNeedConfig"), true);
                    return;
                }
                purgeRows.disabled = true;
                setStatus(t("working"));
                try {
                    const purged = await options.onPurgeDatabaseRows();
                    setStatus(
                        purged > 0 ? t("purgeRowsDone", { n: String(purged) }) : t("purgeRowsNone"),
                    );
                    logger.log(`调试模式：清理数据库行 ${purged} 条`);
                } catch (error) {
                    setStatus(`${t("purgeFailed")}: ${String(error)}`, true);
                } finally {
                    purgeRows.disabled = false;
                }
            });

            const purgeMappings = button(t("purgeMappings"), "danger");
            purgeMappings.addEventListener("click", async () => {
                purgeMappings.disabled = true;
                setStatus(t("working"));
                try {
                    const removed = await options.onPurgeMappings();
                    setStatus(t("purgeMappingsDone", { n: String(removed) }));
                    logger.log(`调试模式：清理同步映射 ${removed} 条`);
                } catch (error) {
                    setStatus(`${t("purgeFailed")}: ${String(error)}`, true);
                } finally {
                    purgeMappings.disabled = false;
                }
            });

            cleanup.append(purgeRows, purgeMappings);
            nodes.push(cleanup);
            const purgeHint = document.createElement("div");
            purgeHint.className = "cc-field__hint cc-hint--warn";
            purgeHint.textContent = t("purgeHint");
            nodes.push(purgeHint);
        }

        /* —— 配置导入导出 —— */

        const ioTitle = document.createElement("div");
        ioTitle.className = "cc-field__hint";
        ioTitle.textContent = t("configIoHint");
        nodes.push(ioTitle);

        const ioActions = document.createElement("div");
        ioActions.className = "cc-dialog__actions";
        const exportButton = button(t("exportConfig"));
        exportButton.addEventListener("click", async () => {
            const json = JSON.stringify(options.store.value, null, 2);
            const saved = await options.onExportConfig(json);
            setStatus(saved ? t("exportDone") : t("exportCopied"));
        });
        const copyButton = button(t("copyConfig"));
        copyButton.addEventListener("click", async () => {
            await options.onExportConfig(JSON.stringify(options.store.value));
            setStatus(t("exportCopied"));
        });
        ioActions.append(exportButton, copyButton);
        nodes.push(ioActions);

        const importArea = document.createElement("textarea");
        importArea.className = "b3-text-field cc-textarea";
        importArea.rows = 6;
        importArea.placeholder = t("importPlaceholder");
        const importButton = button(t("importConfig"), "primary");
        importButton.addEventListener("click", async () => {
            const text = importArea.value.trim();
            if (!text) {
                setStatus(t("importEmpty"), true);
                return;
            }
            setStatus(t("working"));
            const result = await options.onImportConfig(text);
            if (result.ok) {
                importArea.value = "";
                setStatus(t("importDone"));
                void render();
            } else {
                setStatus(`${t("importFailed")}: ${result.message ?? ""}`, true);
            }
        });
        const importRow = document.createElement("div");
        importRow.className = "cc-dialog__actions";
        importRow.append(importArea, importButton);
        nodes.push(importRow);
        return nodes;
    };

    const footer = document.createElement("div");
    footer.className = "cc-dialog__actions";
    // 底部状态提示：任何操作都给出反馈，避免「点了没反应」的错觉
    const statusHint = document.createElement("span");
    statusHint.className = "cc-dialog__status";
    const setStatus = (message: string, warn = false): void => {
        statusHint.textContent = message;
        statusHint.classList.toggle("cc-hint--warn", warn);
    };
    const closeButton = button(t("save"), "primary");
    footer.append(statusHint, closeButton);

    const handle = openDialog({
        title: `${options.plugin.displayName || options.plugin.name} · ${t("settingsView")}`,
        content: body,
        footer,
        width: 640,
        onClose: () => {
            void options.onChanged();
        },
    });
    closeButton.addEventListener("click", () => {
        handle.close();
    });

    body.append(tabsBar, content);
    renderTabs();
    void render();
    setStatus(t("settingsHint"));
}

function numberInput(value: number): HTMLInputElement {    const input = document.createElement("input");
    input.type = "number";
    input.className = "b3-text-field cc-input";
    input.value = String(value);
    return input;
}

function clampInt(value: string, min: number, max: number, fallback: number): number {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}

function toggleField(
    value: boolean,
    label: string,
    onChange: (checked: boolean) => Promise<void> | void,
): HTMLElement {
    const wrap = checkbox(value, label);
    const input = checkboxInput(wrap);
    input.addEventListener("change", () => void onChange(input.checked));
    return wrap;
}

function resolveSecret(plugin: Plugin, account: CalDavAccount): string {
    const secretName = account.passwordSecret?.trim();
    if (secretName) {
        const value = plugin.getSecret(secretName);
        if (value) {
            return value;
        }
    }
    return account.password ?? "";
}

/** 合并新发现的日历与已有配置，保留用户已调整的颜色/只读设置 */
function mergeCalendars(previous: CalendarInfo[], discovered: CalendarInfo[]): CalendarInfo[] {
    const byUrl = new Map(
        previous
            .filter((item) => item.source.kind === "caldav")
            .map((item) => [(item.source as { calendarUrl: string }).calendarUrl, item]),
    );
    return discovered.map((info) => {
        const url = info.source.kind === "caldav" ? info.source.calendarUrl : "";
        const old = byUrl.get(url);
        if (!old) {
            return info;
        }
        return {
            ...info,
            color: old.color ?? info.color,
            readOnly: old.readOnly ?? info.readOnly,
            source:
                old.source.kind === "caldav" && info.source.kind === "caldav"
                    ? { ...info.source, readOnly: old.source.readOnly ?? info.source.readOnly }
                    : info.source,
        };
    });
}

function buildNotebookSelect(current: string): HTMLSelectElement {
    const options: { value: string; label: string }[] = [
        { value: "", label: "（不在思源文档中落库）" },
    ];
    for (const notebook of window.siyuan?.notebooks ?? []) {
        if (notebook.closed) {
            continue;
        }
        options.push({ value: notebook.id, label: notebook.name });
    }
    return select(options, current);
}
