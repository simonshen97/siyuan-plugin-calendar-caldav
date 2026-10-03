import type { Custom, IPluginDockTab, Plugin } from "siyuan";
import type {
    CalDavAccount,
    CalendarEvent,
    CalendarInfo,
    PluginSettings,
    SyncReport,
    TCalendarViewMode,
} from "../types";
import { CalendarStore } from "../state/store";
import { MappingStore } from "../state/mapping";
import { CalDavClient, type CalDavCredentials, type RemoteCalendar } from "../caldav/client";
import { mergeManualCalendars } from "../caldav/manual";
import { CalDavSourceAdapter } from "../caldav/adapter";
import { LocalDocumentAdapter, SiYuanQuerySourceAdapter, newEventUid, projectionHash, type LocalDocumentItem } from "../siyuan/localStore";
import { SiYuanAttributeViewSourceAdapter, attributeViewCalendarId } from "../siyuan/avStore";
import { buildIcs } from "../caldav/ics";
import type { SettingsStore } from "../settings";
import { SyncEngine, type LocalLink, type LocalSyncStore } from "../sync/engine";
import { CalendarView } from "./calendarview";
import { button, checkbox, checkboxInput, closeAllDialogs, openEventEditor } from "./dialog";
import { t } from "../util/i18n";
import { getLocalTimeZone, MS_MINUTE } from "../util/date";
import { hashString } from "../util/misc";
import { logger } from "../util/logger";
import { pushErrMsg, pushMsg, request, getDocInfo, putFile, renderAttributeView } from "../kernel/api";
import { buildAvLocalStore, detectAttributeView, type AvLocalStore } from "../siyuan/avLocalStore";
import { AvRowStore } from "../siyuan/avRowStore";
import { parseRenderPayload } from "../siyuan/avStore";
import { openSettingsDialog } from "./settingsTab";

/** 插件在工作空间里的存储目录名（与 plugin.json 的 name 一致） */
const PLUGIN_STORAGE_NAME = "siyuan-plugin-calendar-caldav";

/**
 * 从属性视图的行单元格里取出某一列的**纯文本值**。
 *
 * 内核读回形态：文本/主键在 `block.content` 或 `text.content`，
 * 单选/多选在 `mSelect[0].content`。这里都要兼容，否则清理与识别会漏掉行。
 */
function readCellText(cells: unknown, keyID: string): string | undefined {
    if (!Array.isArray(cells)) {
        return undefined;
    }
    for (const raw of cells) {
        const cell = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
        const value = cell?.value && typeof cell.value === "object" ? (cell.value as Record<string, unknown>) : undefined;
        if (!value || value.keyID !== keyID) {
            continue;
        }
        const candidates: unknown[] = [
            (value.block as Record<string, unknown> | undefined)?.content,
            (value.text as Record<string, unknown> | undefined)?.content,
            typeof value.content === "string" ? value.content : undefined,
            Array.isArray(value.mSelect)
                ? ((value.mSelect as Array<Record<string, unknown>>)[0]?.content as unknown)
                : undefined,
        ];
        for (const candidate of candidates) {
            if (typeof candidate === "string" && candidate) {
                return candidate;
            }
        }
    }
    return undefined;
}

export interface CalendarDockOptions {
    plugin: Plugin;
    settingsStore: () => SettingsStore;
    settings: () => PluginSettings;
    mappings: MappingStore;
    onSyncStateChange?: (state: { syncing: boolean; lastReport?: SyncReport; lastSyncAt?: number }) => void;
}

interface DockState {
    syncing: boolean;
    lastSyncAt?: number;
    lastReport?: SyncReport;
}

/**
 * 日历停靠栏控制器：数据源装配、事件读写、同步调度与视图刷新。
 */
export class CalendarDock {
    private readonly store: CalendarStore;
    private readonly view: CalendarView;
    private readonly state: DockState = { syncing: false };
    private readonly adapters = new Map<string, CalDavSourceAdapter>();
    private readonly syncTokens = new Map<string, string | undefined>();
    private readonly accountClients = new Map<string, CalDavClient>();
    /** 数据库块的列类型缓存（key = avID|viewID） */
    private readonly avFieldTypes = new Map<string, Record<string, string>>();
    private container?: HTMLElement;
    private statusElement?: HTMLElement;
    private sidebarElement?: HTMLElement;
    private viewHostElement?: HTMLElement;
    private unsubscribe?: () => void;
    private reloadTimer: ReturnType<typeof setTimeout> | null = null;
    private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
    /** 递增的刷新令牌：用于丢弃过期的异步渲染结果 */
    private reloadToken = 0;

    constructor(private readonly options: CalendarDockOptions) {
        this.store = new CalendarStore({
            settings: options.settings,
            mappings: options.mappings,
            log: (...args) => this.log(...args),
            // 日历启用/停用必须持久化，否则重启后被停用的日历会全部「复活」
            onVisibilityChange: (hiddenIds) => {
                void options.settingsStore().update((target) => {
                    target.hiddenCalendars = hiddenIds;
                });
            },
        });
        // 恢复上次的停用状态（在首次渲染前完成）
        this.store.restoreHidden(options.settings().hiddenCalendars ?? []);
        this.view = new CalendarView({
            store: this.store,
            settings: options.settings,
            zone: getLocalTimeZone(),
            onOpenEvent: (event) => void this.openEvent(event),
            onCreateEvent: (start, end, allDay) => void this.createEvent(start, end, allDay),
            onMoveEvent: (event, newStart) => void this.moveEvent(event, newStart),
            onNavigate: () => this.scheduleReload(),
            onToggleCalendar: (id) => this.toggleCalendar(id),
        });
    }

    /* —— 生命周期 —— */

    async init(custom: Custom): Promise<void> {
        this.container = custom.element;
        this.container.classList.add("cc-dock");
        this.container.innerHTML = "";
        // 侧栏（顶部）与状态栏（底部，含「设置」按钮）固定高度，视图占据剩余空间：
        // 这样底部按钮不会被日历本体挤出可视区域。
        this.sidebarElement = document.createElement("div");
        this.sidebarElement.className = "cc-sidebar";
        this.viewHostElement = document.createElement("div");
        this.viewHostElement.className = "cc-viewhost";
        this.viewHostElement.append(this.view.element);
        this.statusElement = document.createElement("div");
        this.statusElement.className = "cc-statusbar";
        this.container.append(this.sidebarElement, this.viewHostElement, this.statusElement);
        this.unsubscribe = this.store.subscribe(() => this.renderChrome());
        await this.rebuildSources();
        this.renderChrome();
        await this.reload(true);
        this.setupAutoSync();
    }

    destroy(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
            this.reloadTimer = null;
        }
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }
        closeAllDialogs();
        this.view.destroy();
        this.store.clearAdapters();
        this.adapters.clear();
        this.accountClients.clear();
        this.container = undefined;
        this.sidebarElement = undefined;
        this.statusElement = undefined;
    }

    get currentAnchor(): number {
        return this.view.currentAnchor;
    }

    get currentMode(): TCalendarViewMode {
        return this.view.currentMode;
    }

    /** 设置变更后重建自动同步定时器 */
    setupAutoSync(): void {
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }
        const minutes = this.options.settings().sync.intervalMinutes;
        if (minutes > 0) {
            this.autoSyncTimer = setInterval(() => void this.syncNow(), minutes * 60_000);
        }
    }

    /* —— 数据源装配 —— */

    async rebuildSources(): Promise<void> {
        this.store.clearAdapters();
        this.adapters.clear();
        const settings = this.options.settings();

        for (const account of settings.accounts) {
            if (!account.enabled) {
                continue;
            }
            for (const info of this.calendarsForAccount(account)) {
                if (info.source.kind !== "caldav") {
                    continue;
                }
                const adapter = new CalDavSourceAdapter({
                    accountId: account.id,
                    calendar: this.remoteFromInfo(info),
                    info,
                    client: () => this.clientFor(account),
                    zone: this.store.zone,
                    syncToken: () => this.syncTokens.get(info.id),
                    onSyncToken: (token) => this.syncTokens.set(info.id, token),
                    log: (...args) => this.log(...args),
                });
                this.adapters.set(info.id, adapter);
                this.store.registerAdapter(adapter, info);
            }
        }

        for (const source of settings.localSources) {
            if (source.kind === "query") {
                const info: CalendarInfo = {
                    id: `query:${hashString(JSON.stringify(source))}`,
                    name: source.label || source.dateAttr || "SQL",
                    color: source.color || "#8b5cf6",
                    readOnly: true,
                    source,
                };
                this.store.registerLocalAdapter(
                    new SiYuanQuerySourceAdapter({ source, info, zone: this.store.zone }),
                    info,
                );
            } else if (source.kind === "av") {
                const info: CalendarInfo = {
                    id: attributeViewCalendarId(source),
                    name: source.label || source.avID,
                    color: "#0ea5e9",
                    readOnly: true,
                    source,
                };
                this.store.registerLocalAdapter(
                    new SiYuanAttributeViewSourceAdapter({ source, info, zone: this.store.zone }),
                    info,
                );
            }
        }

        // 清理已不存在日历的增量同步令牌，避免长期累积
        const activeIds = new Set(this.store.listCalendars().map((item) => item.id));
        for (const id of [...this.syncTokens.keys()]) {
            if (!activeIds.has(id)) {
                this.syncTokens.delete(id);
            }
        }
        this.view.setCalendars(this.store.listCalendars());
    }

    /**
     * 合并「自动发现的日历」与「手动填写的日历 URL」。
     * 逻辑见 `src/caldav/manual.ts`（有独立单测）。
     */
    private calendarsForAccount(account: CalDavAccount): CalendarInfo[] {
        return mergeManualCalendars(account);
    }

    private remoteFromInfo(info: CalendarInfo): RemoteCalendar {
        const source = info.source;
        const url = source.kind === "caldav" ? source.calendarUrl : "";
        return {
            url,
            displayName: info.name,
            color: info.color,
            readOnly: info.readOnly ?? false,
            components: source.kind === "caldav" ? (source.components ?? ["VEVENT"]) : ["VEVENT"],
            syncToken: this.syncTokens.get(info.id),
        };
    }

    private clientFor(account: CalDavAccount): CalDavClient {
        const cached = this.accountClients.get(account.id);
        if (cached) {
            return cached;
        }
        const client = new CalDavClient({
            account,
            credentials: this.credentialsFor(account),
            timeoutMs: this.options.settings().advanced.requestTimeoutMs,
            log: (...args) => this.log(...args),
            // 调试模式打开时连响应体一起记录，便于排查「返回了但内容不对」
            verbose: this.options.settings().advanced.debugMode,
        });
        this.accountClients.set(account.id, client);
        return client;
    }

    private credentialsFor(account: CalDavAccount): CalDavCredentials {
        const secretName = account.passwordSecret?.trim();
        let secret = secretName ? this.options.plugin.getSecret(secretName) || "" : "";
        if (!secret) {
            secret = account.password ?? "";
        }
        return { username: account.username, secret, authType: account.authType ?? "basic" };
    }

    /* —— 渲染 —— */

    private renderChrome(): void {
        if (!this.container || !this.sidebarElement) {
            return;
        }
        this.sidebarElement.innerHTML = "";
        const all = this.store.listCalendars();
        // 界面上方只显示「已启用」的日历；被取消勾选的收进下方折叠区，便于再次启用
        const calendars = all.filter((info) => this.store.isVisible(info.id));
        const hiddenCalendars = all.filter((info) => !this.store.isVisible(info.id));
        if (!all.length) {
            const empty = document.createElement("div");
            empty.className = "cc-empty";
            empty.textContent = t("noCalendars");
            const hint = document.createElement("div");
            hint.className = "cc-field__hint";
            hint.textContent = t("noCalendarsHint");
            const action = button(t("addAccount"), "primary");
            action.addEventListener("click", () => this.openSettings());
            this.sidebarElement.append(empty, hint, action);
        }
        for (const info of calendars) {
            const row = document.createElement("label");
            row.className = "cc-sidebar__item";
            // 用统一的复选框（自绘方框 + 固定前景色），避免原生勾选框在部分终端发白
            const checkWrap = checkbox(this.store.isVisible(info.id), "");
            const check = checkboxInput(checkWrap);
            check.addEventListener("change", () => {
                this.store.setVisible(info.id, check.checked);
                void this.reload(true);
            });
            const dot = document.createElement("span");
            dot.className = "cc-sidebar__dot";
            dot.style.background = info.color ?? "var(--cc-accent)";
            const name = document.createElement("span");
            name.className = "cc-sidebar__name";
            name.textContent = info.name;
            name.title = info.error ?? info.name;
            const badge = document.createElement("span");
            badge.className = "cc-sidebar__badge";
            badge.textContent = info.error ? t("error") : info.count === undefined ? "" : String(info.count);
            row.append(checkWrap, dot, name, badge);
            this.sidebarElement.append(row);
        }
        if (hiddenCalendars.length) {
            const details = document.createElement("details");
            details.className = "cc-sidebar__hidden";
            const summary = document.createElement("summary");
            summary.textContent = `${t("hiddenCalendars")}（${hiddenCalendars.length}）`;
            details.append(summary);
            for (const info of hiddenCalendars) {
                const row = document.createElement("label");
                row.className = "cc-sidebar__item cc-sidebar__item--muted";
                const checkWrap = checkbox(false, "");
                const check = checkboxInput(checkWrap);
                check.addEventListener("change", () => {
                    this.store.setVisible(info.id, check.checked);
                    void this.reload(true);
                });
                const name = document.createElement("span");
                name.className = "cc-sidebar__name";
                name.textContent = info.name;
                row.append(checkWrap, name);
                details.append(row);
            }
            this.sidebarElement.append(details);
        }
        this.renderStatus();
    }

    private renderStatus(): void {
        if (!this.statusElement) {
            return;
        }
        const errors = this.store
            .listCalendars()
            .map((info) => this.store.errorOf(info.id))
            .filter((message): message is string => !!message);
        this.statusElement.innerHTML = "";
        const left = document.createElement("span");
        left.className = "cc-statusbar__hint";
        left.textContent = this.state.syncing
            ? t("syncing")
            : this.state.lastSyncAt
              ? `${t("lastSync")}: ${new Date(this.state.lastSyncAt).toLocaleTimeString()}`
              : `${t("lastSync")}: ${t("never")}`;
        const actions = document.createElement("span");
        actions.className = "cc-toolbar__group";
        if (this.options.settings().advanced.debugMode) {
            // 调试模式：把同步拆成三个按钮，便于分段排查
            const pullButton = button(t("syncPullOnly"));
            pullButton.title = t("syncPullOnlyHint");
            pullButton.disabled = this.state.syncing;
            pullButton.addEventListener("click", () => void this.runSync("pull"));
            const pushButton = button(t("syncPushOnly"));
            pushButton.title = t("syncPushOnlyHint");            pushButton.disabled = this.state.syncing;
            pushButton.addEventListener("click", () => void this.runSync("push"));
            const bothButton = button(this.state.syncing ? t("syncing") : t("syncAll"));
            bothButton.disabled = this.state.syncing;
            bothButton.addEventListener("click", () => void this.syncNow());
            actions.append(pullButton, pushButton, bothButton);
        } else {
            const syncButton = button(this.state.syncing ? t("syncing") : t("sync"));
            syncButton.disabled = this.state.syncing;
            syncButton.addEventListener("click", () => void this.syncNow());
            actions.append(syncButton);
        }
        const refreshButton = button(t("refresh"));
        refreshButton.addEventListener("click", () => void this.reload(true));
        // 底部设置入口：面板里唯一能打开配置的地方，必须始终可见
        const settingsButton = button(t("settingsView"), "primary");
        settingsButton.classList.add("cc-btn--settings");
        settingsButton.title = t("settingsView");
        settingsButton.prepend(gearIcon());
        settingsButton.addEventListener("click", () => this.openSettings());
        actions.append(refreshButton, settingsButton);
        const right = document.createElement("span");
        if (errors.length) {
            right.className = "cc-statusbar__error";
            right.textContent = errors[0];
            right.title = errors.join("\n");
        } else if (this.state.lastReport) {
            right.textContent = `↓${this.state.lastReport.pulled} ↑${this.state.lastReport.pushed}`;
        }
        this.statusElement.append(left, actions, right);
    }

    /* —— 事件加载 —— */

    private scheduleReload(): void {
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
        }
        this.reloadTimer = setTimeout(() => {
            this.reloadTimer = null;
            void this.reload(false);
        }, 120);
    }

    /**
     * 外部（思源）数据变化：只失效本地数据源的缓存，然后去抖刷新。
     *
     * 关键点：**不能连远端 CalDAV 日历的缓存一起清掉**。思源的 transactions 事件触发很频繁，
     * 若每次都清空全部缓存，就会变成每隔一两秒对所有日历重发 REPORT（实测出现过这种风暴）。
     * 远端内容由「刷新 / 立即同步 / 定时同步」负责更新，不受本地编辑影响。
     */
    handleExternalChange(): void {
        this.store.invalidateLocal();
        this.scheduleReload();
    }

    async reload(force: boolean): Promise<void> {
        const window = this.store.windowFor(this.view.currentAnchor, this.view.currentMode);
        const token = ++this.reloadToken;
        try {
            const events = await this.store.eventsIn(window.start, window.end, { force });
            // 丢弃过期结果：期间可能已经切换到别的日期/视图
            if (token !== this.reloadToken) {
                return;
            }
            const calendars = this.store.listCalendars();
            const byId = new Map(calendars.map((item) => [item.id, item]));
            this.view.setEvents(
                events.map((event) => ({
                    ...event,
                    calendarName: byId.get(event.calendar)?.name,
                    color: byId.get(event.calendar)?.color ?? event.color,
                })),
                calendars,
            );
        } catch (error) {
            this.log("reload failed", error);
        }
        if (token === this.reloadToken) {
            this.renderChrome();
        }
    }

    /* —— 事件交互 —— */

    async openEvent(event: CalendarEvent): Promise<void> {
        if (event.siyuan?.blockID && event.sourceKind !== "caldav") {
            await openSiyuanBlock(event.siyuan.blockID);
            return;
        }
        const calendars = this.store.listCalendars();
        const result = await openEventEditor({
            event,
            calendars: calendars.filter((info) => !info.readOnly).length
                ? calendars.filter((info) => !info.readOnly)
                : calendars,
            timeZone: this.store.zone,
            hourCycle: this.options.settings().view.hourCycle,
            defaultDuration: this.options.settings().view.defaultDuration,
        });
        if (result.action === "cancel" || !result.event) {
            return;
        }
        if (result.action === "delete") {
            if (await this.deleteEvent(event)) {
                await pushMsg(t("deleted"), 3000);
                await this.reload(true);
            }
            return;
        }
        await this.saveEvent(event, result.event);
    }

    /**
     * 新建/编辑对话框里可选的日历。
     *
     * 只列出「组件类型匹配」的日历：日历只声明了 `VTODO`（例如 Vikunja 的任务项目）时，
     * 不允许把日程写进去——服务端会直接报错（实测 HTTP 500）。
     */
    private writableCalendarsFor(isTodo: boolean): CalendarInfo[] {
        return this.store.listCalendars().filter((info) => {
            if (info.readOnly) {
                return false;
            }
            const components = info.source.kind === "caldav" ? info.source.components : undefined;
            if (!components?.length) {
                return true;
            }
            return isTodo ? components.includes("VTODO") : components.includes("VEVENT");
        });
    }

    async createEvent(start: number, end: number, allDay: boolean): Promise<void> {
        const calendars = this.writableCalendarsFor(false);
        if (!calendars.length) {
            await pushErrMsg(t("messageNoWritableCalendar"), 5000);
            return;
        }
        const template: CalendarEvent = {
            uid: newEventUid(),
            calendar: calendars[0].id,
            calendarName: calendars[0].name,
            color: calendars[0].color,
            sourceKind: calendars[0].source.kind,
            title: "",
            start,
            end,
            allDay,
            tzid: allDay ? undefined : this.store.zone,
        };
        const result = await openEventEditor({
            event: template,
            calendars,
            timeZone: this.store.zone,
            hourCycle: this.options.settings().view.hourCycle,
            defaultDuration: this.options.settings().view.defaultDuration,
            isNew: true,
        });
        if (result.action !== "save" || !result.event) {
            return;
        }
        if (await this.createRemote({ ...template, ...result.event })) {
            await pushMsg(t("created"), 3000);
            await this.reload(true);
        }
    }

    private async saveEvent(original: CalendarEvent, patch: Partial<CalendarEvent> & { calendar: string }): Promise<void> {
        // 编辑器允许切换日历：目标日历以 patch.calendar 为准（可能就是 original.calendar）
        const targetCalendar = patch.calendar || original.calendar;
        const adapter = this.adapters.get(targetCalendar);
        const merged: CalendarEvent = { ...original, ...patch, calendar: targetCalendar };
        if (!adapter || !adapter.isWritable()) {
            await pushErrMsg(t("messageNoWritableCalendar"), 5000);
            return;
        }
        const moved = targetCalendar !== original.calendar;
        try {
            const ics = buildIcs({ ...merged, uid: original.uid }, { includeTimezone: true });
            const oldAdapter = this.adapters.get(original.calendar);
            const previous = oldAdapter ? this.options.mappings.get(oldAdapter.remote.url, original.uid) : undefined;
            // 换日历 = 在新日历创建 + 删除旧日历里的资源（CalDAV 不支持跨集合移动）
            if (moved && oldAdapter && previous?.href) {
                const created = await adapter.createRemote(original.uid, ics);
                await oldAdapter.deleteRemote(previous.href, previous.etag).catch(() => undefined);
                this.options.mappings.delete(previous.calendarUrl, previous.uid);
                this.options.mappings.set({
                    uid: original.uid,
                    calendarUrl: adapter.remote.url,
                    href: created.url,
                    etag: created.etag,
                    remoteHash: undefined,
                    localHash: projectionHash(merged),
                    start: merged.start,
                    syncedAt: Date.now(),
                    lastDirection: "create-remote",
                });
            } else if (!moved && previous?.href) {
                const result = await adapter.putRemote(previous.href, ics, previous.etag);
                previous.etag = result.etag ?? previous.etag;
                previous.localHash = projectionHash(merged);
                // 远端哈希作废，下轮同步重新计算，避免跨来源比较
                previous.remoteHash = undefined;
                previous.start = merged.start;
                previous.syncedAt = Date.now();
                previous.lastDirection = "push";
                this.options.mappings.set(previous);
            } else {
                const created = await adapter.createRemote(original.uid, ics);
                this.options.mappings.set({
                    uid: original.uid,
                    calendarUrl: adapter.remote.url,
                    href: created.url,
                    etag: created.etag,
                    remoteHash: undefined,
                    localHash: projectionHash(merged),
                    start: merged.start,
                    syncedAt: Date.now(),
                    lastDirection: "create-remote",
                });
            }
            await this.options.mappings.flush();
            await pushMsg(t("messageUpdated"), 3000);
            await this.reload(true);
        } catch (error) {
            await pushErrMsg(`${t("messageSaveFailed")}: ${errorMessage(error)}`, 6000);
        }
    }

    private async createRemote(event: CalendarEvent): Promise<boolean> {
        const adapter = this.adapters.get(event.calendar);
        if (!adapter || !adapter.isWritable()) {
            await pushErrMsg(t("messageNoWritableCalendar"), 5000);
            return false;
        }
        try {
            const ics = buildIcs({ ...event, uid: event.uid }, { includeTimezone: true });
            const created = await adapter.createRemote(event.uid, ics);
            this.options.mappings.set({
                uid: event.uid,
                calendarUrl: adapter.remote.url,
                href: created.url,
                etag: created.etag,
                remoteHash: undefined,
                localHash: projectionHash(event),
                start: event.start,
                syncedAt: Date.now(),
                lastDirection: "create-remote",
            });
            await this.options.mappings.flush();
            return true;
        } catch (error) {
            await pushErrMsg(`${t("messageSaveFailed")}: ${errorMessage(error)}`, 6000);
            return false;
        }
    }

    private async deleteEvent(event: CalendarEvent): Promise<boolean> {
        const adapter = this.adapters.get(event.calendar);
        const mapping = adapter ? this.options.mappings.get(adapter.remote.url, event.uid) : undefined;
        if (!adapter || !mapping?.href) {
            if (mapping) {
                this.options.mappings.delete(mapping.calendarUrl, mapping.uid);
                await this.options.mappings.flush();
                return true;
            }
            await pushErrMsg(t("messageNoMapping"), 4000);
            return false;
        }
        try {
            await adapter.deleteRemote(mapping.href, mapping.etag);
            this.options.mappings.delete(mapping.calendarUrl, mapping.uid);
            await this.options.mappings.flush();
            return true;
        } catch (error) {
            await pushErrMsg(`${t("messageSaveFailed")}: ${errorMessage(error)}`, 6000);
            return false;
        }
    }

    /** 拖动事件到新日期：保持原时刻，仅替换日期部分 */
    private async moveEvent(event: CalendarEvent, newStart: number): Promise<void> {
        const adapter = this.adapters.get(event.calendar);
        if (!adapter || !adapter.isWritable()) {
            return;
        }
        const duration = Math.max(MS_MINUTE, event.end - event.start);
        await this.saveEvent(event, { ...event, start: newStart, end: newStart + duration });
    }

    /* —— 同步 —— */

    /** 轻量刷新：重新拉取所有可见日历 */
    async refreshAll(): Promise<void> {
        const window = this.store.windowFor(this.view.currentAnchor, this.view.currentMode);
        await this.store.refreshAll(window.start, window.end);
        await this.reload(false);
    }

    /** 完整同步：拉取 + 双向引擎（需要可写入的思源笔记本作为落库目标） */
    async syncNow(): Promise<SyncReport | undefined> {
        return this.runSync("both");
    }

    /**
     * 分段同步（调试模式使用）：
     * - `pull`：只把 CalDAV / 思源数据源的内容拉进数据库（或文档）；
     * - `push`：只把日程推回远端；
     * - `both`：完整双向同步。
     */
    async runSync(direction: "pull" | "push" | "both"): Promise<SyncReport | undefined> {
        if (this.state.syncing) {
            return undefined;
        }
        const settings = this.options.settings();
        // 未勾选（未启用）的日历不参与同步：既不发请求，也不写入映射
        const adapters = [...this.adapters.entries()]
            .filter(([id]) => this.store.isVisible(id))
            .map(([, adapter]) => adapter)
            .filter((adapter) => {
                const account = settings.accounts.find((item) => item.id === adapter.source.accountId);
                const direction = account?.syncDirection ?? settings.sync.direction;
                return direction !== "off";
            });
        if (!adapters.length) {
            await pushMsg(t("noCalendars"), 3000);
            return undefined;
        }
        this.state.syncing = true;
        this.renderStatus();
        this.options.onSyncStateChange?.({
            syncing: true,
            lastReport: this.state.lastReport,
            lastSyncAt: this.state.lastSyncAt,
        });
        try {
            const local = this.buildLocalStore();
            const store = local ? wrapLocalStore(local) : undefined;
            // 「数据库块」落库：用户显式配置后优先使用，每个日历各自建立行存储
            const avConfig = settings.avSync;
            const avStores = new Map<string, AvLocalStore>();
            if (avConfig?.enabled && avConfig.avID && avConfig.dateKeyID) {
                const types = await this.loadAvFieldTypes(avConfig.avID, avConfig.viewID);
                for (const adapter of adapters) {
                    // 「来源」列写账户名（CalDAV 账户 / 思源数据源在设置里的名称），
                    // 便于在一个数据库里区分 QQ 邮箱、企业微信、Vikunja 等来源
                    const account = settings.accounts.find((item) => item.id === adapter.source.accountId);
                    avStores.set(
                        adapter.info.id,
                        buildAvLocalStore({
                            avID: avConfig.avID,
                            viewID: avConfig.viewID,
                            zone: this.store.zone,
                            attrPrefix: "custom-caldav",
                            label: adapter.info.name,
                            sourceLabel: account?.name || adapter.info.name,
                            fieldTypes: types,
                            log: (...args) => this.log(...args),
                            window: () => ({
                                start: Date.now() - settings.sync.pastDays * 86_400_000,
                                end: Date.now() + settings.sync.futureDays * 86_400_000,
                            }),
                            binding: {
                                dateKeyID: avConfig.dateKeyID,
                                titleKeyID: avConfig.titleKeyID,
                                endKeyID: avConfig.endKeyID,
                                descriptionKeyID: avConfig.descriptionKeyID,
                                locationKeyID: avConfig.locationKeyID,
                                calendarKeyID: avConfig.calendarKeyID,
                                uidKeyID: avConfig.uidKeyID,
                                markerKeyID: avConfig.markerKeyID,
                                statusKeyID: avConfig.statusKeyID,
                            },
                        }),
                    );
                }
            }
            const accounts = new Map(settings.accounts.map((item) => [item.id, item]));
            const engine = new SyncEngine({
                mappings: this.options.mappings,
                adapters: () => adapters,
                local: (adapter) => {
                    if (avStores.has(adapter.info.id)) {
                        return avStores.get(adapter.info.id);
                    }
                    // 数据库同步启用时不再把事件落成文档，避免同一事件出现两份本地条目
                    return avConfig?.enabled ? undefined : store;
                },
                conflictPolicy: () => settings.sync.conflictPolicy,
                deleteLocalWhenRemoteDeleted: () => settings.sync.deleteLocalWhenRemoteDeleted,
                pushLocalChanges: () => settings.sync.pushLocalChanges,
                // 数据库同步模式下不推送「新增条目」：数据库是汇总视图，
                // 每一行都推回远端会产生大量无意义的 PUT
                skipUnmappedPush: () => Boolean(avConfig?.enabled && avStores.size),
                window: () => ({
                    start: Date.now() - settings.sync.pastDays * 86_400_000,
                    end: Date.now() + settings.sync.futureDays * 86_400_000,
                }),
                zone: () => this.store.zone,
                log: (...args) => this.log(...args),
            });
            void accounts;
            // 同步过程也要进日志：否则出错只能看到内核弹窗，插件日志里查不到任何线索
            this.log(
                `sync start: direction=${direction}（配置=${settings.sync.direction}） adapters=${adapters.length}` +
                    (avConfig?.enabled && avConfig.avID
                        ? ` database=${avConfig.avID} date=${avConfig.dateKeyID} title=${avConfig.titleKeyID ?? "-"}`
                        : store
                          ? " target=documents"
                          : " target=read-only"),
            );
            const report = await engine.run(direction);
            this.state.lastReport = report;
            this.state.lastSyncAt = Date.now();
            this.log(
                `sync done: pulled=${report.pulled} pushed=${report.pushed} created=${report.created} ` +
                    `updated=${report.updated} deleted=${report.deleted} skipped=${report.skipped} ` +
                    `conflicts=${report.conflicts} errors=${report.errors.length}`,
            );
            for (const item of report.errors) {
                // 每条错误单独成行，包含日历 ID，便于定位是哪个数据源/哪一步失败
                logger.error(`sync error [${item.calendarId}] ${item.message}`);
            }
            if (report.errors.length) {
                await pushErrMsg(`${t("syncFailed")}: ${report.errors[0].message}`, 6000);
            } else {
                await pushMsg(
                    t("syncDone", {
                        pull: String(report.pulled),
                        push: String(report.pushed),
                        conflicts: String(report.conflicts),
                    }),
                    3000,
                );
            }
            await this.reload(true);
            return report;
        } catch (error) {
            logger.error(`同步失败：${errorMessage(error)}`);
            await pushErrMsg(`${t("syncFailed")}: ${errorMessage(error)}`, 6000);
            return undefined;
        } finally {
            this.state.syncing = false;
            this.renderStatus();
            this.options.onSyncStateChange?.({
                syncing: false,
                lastReport: this.state.lastReport,
                lastSyncAt: this.state.lastSyncAt,
            });
        }
    }

    /** 构造文档本地存储（用于双向同步） */
    /**
     * 构建「落库到思源文档」的适配器。
     *
     * 只有在设置里**显式选择了目标笔记本**时才启用：以前这里会静默回退到「第一个未关闭的笔记本」，
     * 于是用户以为同步会写进自己绑定的数据库（属性视图），实际却在某个笔记本里凭空建了一堆文档。
     * 现在未选择 = 不做文档落库（同步只读远端）。
     */
    private buildLocalStore(): LocalDocumentAdapter | undefined {
        const settings = this.options.settings();
        const notebook = this.targetNotebook();
        if (!notebook) {
            return undefined;
        }
        return new LocalDocumentAdapter({
            zone: this.store.zone,
            target: { notebook, pathTemplate: settings.sync.pathTemplate || "/日历/${yyyy}/${MM}" },
            attrNames: LocalDocumentAdapter.attrsFor(settings.sync.attrPrefix),
        });
    }

    private targetNotebook(): string | undefined {
        return this.options.settings().sync.targetNotebook || undefined;
    }

    /**
     * 读取数据库块的「列 keyID → 列类型」映射。
     *
     * 写入单元格值的形态取决于列类型（日期是毫秒数字、文本是 text 包装等），
     * 因此同步前必须先探测一次；失败时返回空对象，`AvRowStore` 会按文本兜底。
     */
    private async loadAvFieldTypes(avID: string, viewID?: string): Promise<Record<string, string>> {
        const cacheKey = `${avID}|${viewID ?? ""}`;
        const cached = this.avFieldTypes.get(cacheKey);
        if (cached) {
            return cached;
        }
        const detected = await detectAttributeView(avID, viewID).catch(() => undefined);
        const types: Record<string, string> = {};
        for (const item of detected?.fields ?? []) {
            types[item.id] = item.type;
        }
        if (Object.keys(types).length) {
            this.avFieldTypes.set(cacheKey, types);
        }
        return types;
    }

    /* —— 设置入口 —— */

    openSettings(): void {
        openSettingsDialog({
            plugin: this.options.plugin,
            store: this.options.settingsStore(),
            mappings: this.options.mappings,
            onChanged: async () => {
                this.accountClients.clear();
                const advanced = this.options.settings().advanced;
                // 调试模式隐含详细日志
                logger.setEnabled(advanced.debug || advanced.debugMode);
                await this.rebuildSources();
                this.setupAutoSync();
                await this.reload(true);
            },
            onPurgeDatabaseRows: () => this.purgeDatabaseRows(),
            onPurgeMappings: async () => {
                const removed = this.options.mappings.size;
                // 按日历逐条删除（MappingStore 没有整体清空接口）
                const byCalendar = new Map<string, string[]>();
                for (const item of this.options.mappings.all()) {
                    const list = byCalendar.get(item.calendarUrl) ?? [];
                    list.push(item.uid);
                    byCalendar.set(item.calendarUrl, list);
                }
                for (const [calendarUrl, uids] of byCalendar) {
                    for (const uid of uids) {
                        this.options.mappings.delete(calendarUrl, uid);
                    }
                }
                await this.options.mappings.flush();
                return removed;
            },
            onExportConfig: (json) => this.exportConfig(json),
            onImportConfig: (json) => this.importConfig(json),
        });
    }

    /**
     * 调试模式：删除**本插件写入的**数据库行。
     *
     * 判据优先用「插件标识」列（`caldav:<UID>`）；未绑定时退回行块自定义属性。
     * 无论哪条路径，用户自己手写的行都不会被删。
     */
    private async purgeDatabaseRows(): Promise<number> {
        const config = this.options.settings().avSync;
        if (!config?.avID) {
            return 0;
        }
        const avID = config.avID;
        // 视图 ID 可能失效（换过数据库）：去掉它重试一次，避免内核报 `view not found` 导致读到 0 行
        let snapshot = await renderAttributeView(avID, config.viewID, { pageSize: 500 }).catch(() => undefined);
        let view = parseRenderPayload(snapshot, config.viewID);
        if (!view) {
            snapshot = await renderAttributeView(avID, undefined, { pageSize: 500 }).catch(() => undefined);
            view = parseRenderPayload(snapshot, undefined);
            if (view && config.viewID) {
                logger.warn(`配置里的视图 ID ${config.viewID} 无效（可能换过数据库），已改用默认视图`);
            }
        }
        const rows = Array.isArray((view as { rows?: unknown[] } | undefined)?.rows)
            ? ((view as { rows: Array<{ id?: unknown; cells?: unknown[] }> }).rows ?? [])
            : [];
        const store = new AvRowStore({
            avID,
            binding: {
                dateKeyID: config.dateKeyID,
                titleKeyID: config.titleKeyID,
                markerKeyID: config.markerKeyID,
            },
            fieldTypes: {},
        });
        logger.log(
            `调试模式清理：avID=${avID} 读到 ${rows.length} 行，标识列=${config.markerKeyID ?? "（未绑定，将退回行属性）"}`,
        );
        // 优先用「插件标识」列判断：直接看单元格，不需要块属性
        const targets: string[] = [];
        for (const row of rows) {
            const itemID = String(row?.id ?? "");
            if (!itemID) {
                continue;
            }
            if (config.markerKeyID) {
                const marker = readCellText(row.cells, config.markerKeyID);
                if (marker && marker.startsWith("caldav:")) {
                    targets.push(itemID);
                }
            } else {
                const identity = await store.readRowIdentity(itemID);
                if (identity?.uid) {
                    targets.push(itemID);
                }
            }
        }
        logger.log(`调试模式清理：命中插件行 ${targets.length} 条`);
        // 批量删除：内核 `removeAttributeViewBlocks` 支持一次传多个 srcIDs，
        // 比逐行删少很多往返；失败必须让调用方看到（以前失败也报「已删除 N 条」）。
        const batchSize = 50;
        let removed = 0;
        for (let index = 0; index < targets.length; index += batchSize) {
            const batch = targets.slice(index, index + batchSize);
            await store.deleteRows(batch);
            removed += batch.length;
            logger.log(`调试模式清理：已提交删除 ${removed}/${targets.length} 行`);
        }
        return removed;
    }

    /** 导出配置：写入 <工作空间>/data/storage/petal/<插件>/ 下，失败时回退到剪贴板 */
    private async exportConfig(json: string): Promise<boolean> {
        const name = `calendar-caldav-settings-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
        try {
            const file = new File([json], name, { type: "application/json" });
            await putFile(`/data/storage/petal/${PLUGIN_STORAGE_NAME}/${name}`, file);
            logger.log(`已导出配置：data/storage/petal/${PLUGIN_STORAGE_NAME}/${name}`);
            return true;
        } catch (error) {
            logger.warn("导出配置到工作空间失败，已改为复制到剪贴板", error);
            await navigator.clipboard?.writeText(json).catch(() => undefined);
            return false;
        }
    }

    /** 导入配置：整份覆盖设置（保留版本号），并立即生效 */
    private async importConfig(json: string): Promise<{ ok: boolean; message?: string }> {
        let parsed: unknown;
        try {
            parsed = JSON.parse(json);
        } catch (error) {
            return { ok: false, message: `JSON 解析失败：${errorMessage(error)}` };
        }
        if (!parsed || typeof parsed !== "object") {
            return { ok: false, message: "内容不是插件配置对象" };
        }
        const candidate = parsed as Partial<PluginSettings>;
        if (!Array.isArray(candidate.accounts) && !candidate.sync && !candidate.avSync) {
            return { ok: false, message: "缺少 accounts / sync / avSync 字段，可能不是本插件的配置" };
        }
        const store = this.options.settingsStore();
        await store.update((target) => {
            Object.assign(target, candidate);
            target.version = store.value.version;
        });
        this.accountClients.clear();
        // 导入的配置可能带着「已停用日历」列表，立刻应用，避免界面与实际不符
        this.store.restoreHidden(store.value.hiddenCalendars ?? []);
        await this.rebuildSources();
        this.setupAutoSync();
        await this.reload(true);
        return { ok: true };
    }

    private toggleCalendar(id: string): void {
        this.store.setVisible(id, !this.store.isVisible(id));
        void this.reload(true);
    }

    private log(message: string, ...rest: unknown[]): void {
        // 调试开关决定是否写入；日志始终缓存在内存里，并镜像到思源系统日志
        if (this.options.settings().advanced.debug) {
            logger.log(message, ...rest);
        } else {
            logger.debug(message, ...rest);
        }
    }
}

/** 把 LocalDocumentAdapter 适配为 SyncEngine 需要的接口 */
function wrapLocalStore(adapter: LocalDocumentAdapter): LocalSyncStore {
    const toLink = (uid: string, item: LocalDocumentItem): LocalLink => ({
        uid,
        blockID: item.blockID,
        rootID: item.rootID,
        title: item.title,
    });
    return {
        refresh: async () => {
            const items = await adapter.refresh();
            const map = new Map<string, LocalLink>();
            for (const [uid, item] of items) {
                map.set(uid, toLink(uid, item));
            }
            return map;
        },
        create: async (event, meta) => {
            const item = await adapter.create(event, meta);
            return toLink(event.uid, item);
        },
        update: async (link, event, meta) => {
            await adapter.update(
                {
                    uid: link.uid,
                    blockID: link.blockID,
                    rootID: link.rootID,
                    // 索引中的标题仅用于「是否需要重写正文」的比较
                    title: meta.previousTitle ?? link.title ?? "",
                    start: event.start,
                    allDay: event.allDay,
                },
                event,
                meta,
            );
        },
        unlink: async (link) => {
            await adapter.unlink({
                uid: link.uid,
                blockID: link.blockID,
                rootID: link.rootID,
                title: "",
                start: 0,
                allDay: true,
            });
        },
        loadEvent: async (blockID) => adapter.loadEvent(blockID).catch(() => undefined),
        deleteDocument: async (blockID) => {
            await request("/api/block/deleteBlock", { id: blockID }).catch(() => undefined);
        },
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 齿轮图标（用于底部「设置」按钮） */
function gearIcon(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute(
        "d",
        "M19.14 12.94a7.5 7.5 0 0 0 .06-.94 7.5 7.5 0 0 0-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.62l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 12.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L1.71 8.48a.5.5 0 0 0 .12.62l2.03 1.58a7.6 7.6 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.62l1.92 3.32c.12.22.38.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.48 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.62l-2.03-1.58ZM11 15.5A3.5 3.5 0 1 1 14.5 12 3.5 3.5 0 0 1 11 15.5Z",
    );
    svg.append(path);
    return svg;
}

/** 在思源中打开事件对应的文档 */
async function openSiyuanBlock(blockID: string): Promise<void> {
    try {
        const info = await getDocInfo(blockID);
        const rootID = info?.rootID || blockID;
        const openFn = window.openFileByURL;
        if (typeof openFn === "function" && openFn(`siyuan://blocks/${rootID}`)) {
            return;
        }
        await pushMsg(t("jumpToSiYuan"), 3000);
    } catch {
        await pushErrMsg(t("messageBlockMissing"), 3000);
    }
}

/** 便捷函数：连接测试与日历发现（设置界面与插件命令共用） */
export async function testAccount(
    account: CalDavAccount,
    secret: string,
    timeoutMs: number,
): Promise<{ ok: boolean; calendars: CalendarInfo[]; message?: string; homeSet?: string }> {
    const client = new CalDavClient({
        account,
        credentials: { username: account.username, secret, authType: account.authType ?? "basic" },
        timeoutMs,
    });
    try {
        const result = await client.discover();
        const calendars = result.calendars.map((remote) => client.toCalendarInfo(account.id, remote));
        return { ok: true, calendars, homeSet: result.homeSet };
    } catch (error) {
        return { ok: false, calendars: [], message: errorMessage(error) };
    }
}

export function buildDockTabConfig(): IPluginDockTab {
    return {
        position: "RightTop",
        size: { width: 420, height: 0 },
        icon: "iconCalendar",
        title: t("dockTitle"),
        index: 0,
        show: false,
    };
}

/** 判断事件是否为可编辑的远端事件 */
export function isRemoteEvent(event: CalendarEvent): boolean {
    return event.sourceKind === "caldav" && !event.readOnly;
}
