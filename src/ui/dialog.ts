import type { CalendarEvent } from "../types";
import { t } from "../util/i18n";
import { logger } from "../util/logger";
import { putFile } from "../kernel/api";
import { dateKey, dateKeyToTs, formatTime, getLocalTimeZone, MS_MINUTE, partsOf, zonedTimeToTs } from "../util/date";
import type { CalendarInfo } from "../types";

export interface DialogHandle {
    element: HTMLElement;
    close: () => void;
}

/** 已打开的对话框：遮罩元素 → 关闭函数（必须走关闭函数，否则会泄漏 keydown 监听器） */
const openDialogs = new Map<HTMLElement, () => void>();

/** 关闭全部对话框（插件卸载、打开另一个模态框前调用） */
export function closeAllDialogs(): void {
    for (const [element, close] of [...openDialogs]) {
        try {
            close();
        } catch {
            element.remove();
            openDialogs.delete(element);
        }
    }
}

/** 通用模态框：遮罩 + 卡片 + 焦点约束 + Esc 关闭 */
export function openDialog(options: {
    title: string;
    className?: string;
    width?: number;
    content: HTMLElement;
    footer?: HTMLElement;
    onClose?: () => void;
}): DialogHandle {
    const mask = document.createElement("div");
    mask.className = "cc-dialog__mask";
    const body = document.createElement("div");
    body.className = `cc-dialog${options.className ? ` ${options.className}` : ""}`;
    if (options.width) {
        body.style.width = `${options.width}px`;
    }
    const header = document.createElement("div");
    header.className = "cc-dialog__header";
    const title = document.createElement("div");
    title.className = "cc-dialog__title";
    title.textContent = options.title;
    const close = document.createElement("button");
    close.className = "cc-icon-btn";
    close.type = "button";
    close.setAttribute("aria-label", t("cancel"));
    close.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.89 18.3 9.18 12 2.89 5.71 4.3 4.3l6.29 6.29 6.3-6.3z"/></svg>';
    header.append(title, close);

    const content = document.createElement("div");
    content.className = "cc-dialog__content";
    content.append(options.content);

    body.append(header, content);
    if (options.footer) {
        const footer = document.createElement("div");
        footer.className = "cc-dialog__footer";
        footer.append(options.footer);
        body.append(footer);
    }
    mask.append(body);

    const closeDialog = () => {
        if (!openDialogs.has(mask)) {
            return;
        }
        openDialogs.delete(mask);
        mask.remove();
        document.removeEventListener("keydown", onKeydown, true);
        options.onClose?.();
    };

    const onKeydown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            event.stopPropagation();
            closeDialog();
        }
    };

    close.addEventListener("click", closeDialog);
    mask.addEventListener("mousedown", (event) => {
        if (event.target === mask) {
            closeDialog();
        }
    });
    document.addEventListener("keydown", onKeydown, true);
    document.body.append(mask);
    openDialogs.set(mask, closeDialog);
    const focusTarget = content.querySelector<HTMLElement>("input, textarea, select, button");
    focusTarget?.focus();
    return { element: body, close: closeDialog };
}

export function button(label: string, variant: "primary" | "ghost" | "danger" = "ghost"): HTMLButtonElement {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `cc-btn cc-btn--${variant}`;
    el.textContent = label;
    return el;
}

export function field(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "cc-field";
    const label = document.createElement("span");
    label.className = "cc-field__label";
    label.textContent = labelText;
    wrap.append(label, control);
    if (hint) {
        const hintEl = document.createElement("span");
        hintEl.className = "cc-field__hint";
        hintEl.textContent = hint;
        wrap.append(hintEl);
    }
    return wrap;
}

export function textInput(value: string, type: "text" | "password" | "url" = "text"): HTMLInputElement {
    const input = document.createElement("input");
    input.type = type;
    input.className = "b3-text-field cc-input";
    input.value = value;
    return input;
}

export function textArea(value: string, rows = 4): HTMLTextAreaElement {
    const area = document.createElement("textarea");
    area.className = "b3-text-field cc-textarea";
    area.rows = rows;
    area.value = value;
    return area;
}

export function select(
    options: { value: string; label: string }[],
    value: string,
): HTMLSelectElement {
    const el = document.createElement("select");
    el.className = "b3-select cc-select fn__size200";
    for (const option of options) {
        const item = document.createElement("option");
        item.value = option.value;
        item.textContent = option.label;
        el.append(item);
    }
    el.value = value;
    return el;
}

/**
 * 复选框。
 *
 * 不复用思源的 `b3-switch`：它依赖主题变量与 `.fn__flex-inline` 的尺寸约束，
 * 在部分终端（浏览器 / Docker 客户端）会退化成白色方块把标签压住。
 * 这里用自绘方框，颜色一律走带兜底值的主题变量。
 */
export function checkbox(checked: boolean, labelText: string): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "cc-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cc-checkbox__input";
    input.checked = checked;
    const box = document.createElement("span");
    box.className = "cc-checkbox__box";
    box.setAttribute("aria-hidden", "true");
    box.innerHTML =
        '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M9.6 16.4 5 11.8l1.4-1.4 3.2 3.2 8-8L19 7z"/></svg>';
    const span = document.createElement("span");
    span.className = "cc-checkbox__label";
    span.textContent = labelText;
    wrap.append(input, box, span);
    wrap.dataset.checked = checked ? "1" : "0";
    input.addEventListener("change", () => {
        wrap.dataset.checked = input.checked ? "1" : "0";
    });
    return wrap;
}

export function checkboxInput(wrap: HTMLElement): HTMLInputElement {
    return wrap.querySelector("input") as HTMLInputElement;
}

/** datetime-local 值（YYYY-MM-DDTHH:mm）与时间戳互转 */
export function tsToLocalInput(ts: number, timeZone: string = getLocalTimeZone()): string {
    const p = partsOf(ts, timeZone);
    return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function localInputToTs(value: string, timeZone: string = getLocalTimeZone()): number {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
    if (!match) {
        return Date.now();
    }
    return zonedTimeToTs(
        parseInt(match[1], 10),
        parseInt(match[2], 10),
        parseInt(match[3], 10),
        match[4] ? parseInt(match[4], 10) : 0,
        match[5] ? parseInt(match[5], 10) : 0,
        0,
        timeZone,
    );
}

export function dateInputValue(ts: number, timeZone: string = getLocalTimeZone()): string {
    return dateKey(ts, timeZone);
}

export function dateInputToTs(value: string, timeZone: string = getLocalTimeZone()): number {
    return dateKeyToTs(value, timeZone);
}

/** 事件时间摘要（列表/弹出层使用） */
export function eventTimeSummary(event: CalendarEvent, timeZone: string, hourCycle: 24 | 12): string {
    if (event.allDay) {
        const startKey = dateKey(event.start, timeZone);
        const endKey = dateKey(Math.max(event.start, event.end - MS_MINUTE), timeZone);
        if (startKey === endKey) {
            return t("allDay");
        }
        return `${startKey.slice(5)} – ${endKey.slice(5)}`;
    }
    const startLabel = formatTime(event.start, { timeZone, hourCycle });
    const endLabel = formatTime(event.end, { timeZone, hourCycle });
    if (dateKey(event.start, timeZone) === dateKey(event.end, timeZone)) {
        return `${startLabel} – ${endLabel}`;
    }
    return `${startLabel} – ${dateKey(event.end, timeZone).slice(5)} ${endLabel}`;
}

export interface EventEditorResult {
    action: "save" | "delete" | "cancel";
    event?: Partial<CalendarEvent> & { calendar: string };
}

export interface EventEditorContext {
    event: CalendarEvent;
    calendars: CalendarInfo[];
    timeZone: string;
    hourCycle: 24 | 12;
    defaultDuration: number;
    isNew?: boolean;
}

/**
 * 事件编辑器：新建/编辑/删除。
 * 返回的 `event` 只包含需要写回的字段，由调用方决定写入 CalDAV 还是思源条目。
 */
export function openEventEditor(context: EventEditorContext): Promise<EventEditorResult> {
    const { event, calendars } = context;
    const isNew = context.isNew ?? false;
    return new Promise((resolve) => {
        const form = document.createElement("div");
        form.className = "cc-form";

        const titleInput = textInput(event.title ?? "");
        titleInput.placeholder = t("fieldTitle");
        const calendarSelect = select(
            calendars.map((item) => ({
                value: item.id,
                label: item.readOnly ? `${item.name} (${t("readOnly")})` : item.name,
            })),
            event.calendar,
        );
        const allDay = checkbox(event.allDay, t("fieldAllDay"));
        const startInput = document.createElement("input");
        startInput.type = event.allDay ? "date" : "datetime-local";
        startInput.className = "b3-text-field cc-input";
        startInput.value = event.allDay ? dateInputValue(event.start, context.timeZone) : tsToLocalInput(event.start, context.timeZone);
        const endInput = document.createElement("input");
        endInput.type = startInput.type;
        endInput.className = "b3-text-field cc-input";
        endInput.value = event.allDay ? dateInputValue(Math.max(event.start, event.end - MS_MINUTE), context.timeZone) : tsToLocalInput(event.end, context.timeZone);
        const locationInput = textInput(event.location ?? "");
        const urlInput = textInput(event.url ?? "", "url");
        const descInput = textArea(event.description ?? "", 5);
        const repeatSelect = select(
            [
                { value: "", label: t("repeatNone") },
                { value: "DAILY", label: t("repeatDaily") },
                { value: "WEEKLY", label: t("repeatWeekly") },
                { value: "MONTHLY", label: t("repeatMonthly") },
                { value: "YEARLY", label: t("repeatYearly") },
            ],
            (event.rrule ?? "").split(";").find((part) => part.startsWith("FREQ="))?.slice(5) ?? "",
        );
        const alarmSelect = select(
            [
                { value: "", label: t("alarmNone") },
                { value: "0", label: t("alarmAtTime") },
                { value: "5", label: t("alarm5") },
                { value: "15", label: t("alarm15") },
                { value: "30", label: t("alarm30") },
                { value: "60", label: t("alarm60") },
                { value: "1440", label: t("alarm1440") },
            ],
            event.alarms?.length ? String(Math.abs(event.alarms[0].trigger) / MS_MINUTE) : "",
        );

        allDay.querySelector("input")?.addEventListener("change", (changeEvent) => {
            const checked = (changeEvent.target as HTMLInputElement).checked;
            startInput.type = checked ? "date" : "datetime-local";
            endInput.type = startInput.type;
            const startTs = checked ? dateInputToTs(startInput.value, context.timeZone) : localInputToTs(startInput.value, context.timeZone);
            startInput.value = checked ? dateInputValue(startTs, context.timeZone) : tsToLocalInput(startTs, context.timeZone);
            const endTs = startTs + context.defaultDuration * MS_MINUTE;
            endInput.value = checked ? dateInputValue(endTs, context.timeZone) : tsToLocalInput(endTs, context.timeZone);
        });
        form.append(
            field(t("fieldTitle"), titleInput),
            field(t("fieldCalendar"), calendarSelect),
            field("", allDay),
            field(t("fieldStart"), startInput),
            field(t("fieldEnd"), endInput),
            field(t("fieldRepeat"), repeatSelect),
            field(t("fieldAlarm"), alarmSelect),
            field(t("fieldLocation"), locationInput),
            field(t("fieldUrl"), urlInput),
            field(t("fieldDescription"), descInput),
        );

        if (event.isRecurringInstance || event.rrule) {
            const hint = document.createElement("div");
            hint.className = "cc-hint cc-hint--warn";
            hint.textContent = t("recurringHint");
            form.append(hint);
        }

        const cancelButton = button(t("cancel"));
        const saveButton = button(t("save"), "primary");
        const footer = document.createElement("div");
        footer.className = "cc-dialog__actions";
        footer.append(cancelButton);
        if (!isNew && !event.readOnly) {
            const deleteButton = button(t("delete"), "danger");
            deleteButton.addEventListener("click", () => {
                // 必须先 resolve：handle.close() 内部会触发 onClose（resolve cancel），先关会吞掉 delete
                resolve({ action: "delete", event: { calendar: calendarSelect.value, uid: event.uid } });
                handle.close();
            });
            footer.append(deleteButton);
        }
        footer.append(saveButton);

        const handle = openDialog({
            title: isNew ? t("title") : t("editTitle"),
            content: form,
            footer,
            width: 560,
            onClose: () => resolve({ action: "cancel" }),
        });

        cancelButton.addEventListener("click", () => {
            handle.close();
        });

        saveButton.addEventListener("click", () => {
            const isAllDay = (allDay.querySelector("input") as HTMLInputElement).checked;
            const start = isAllDay
                ? dateInputToTs(startInput.value, context.timeZone)
                : localInputToTs(startInput.value, context.timeZone);
            let end = isAllDay
                ? dateInputToTs(endInput.value, context.timeZone)
                : localInputToTs(endInput.value, context.timeZone);
            if (isAllDay) {
                // 全天事件使用「结束日期包含当天」的语义，内部统一为半开区间
                const endDayStart = dateKeyToTs(dateInputValue(end, context.timeZone), context.timeZone);
                end = endDayStart + 86_400_000;
            } else if (end <= start) {
                end = start + context.defaultDuration * MS_MINUTE;
            }
            const freq = repeatSelect.value;
            const alarmMinutes = alarmSelect.value === "" ? undefined : parseInt(alarmSelect.value, 10);
            const payload: Partial<CalendarEvent> & { calendar: string } = {
                calendar: calendarSelect.value,
                uid: event.uid,
                title: titleInput.value.trim() || "(未命名)",
                start,
                end,
                allDay: isAllDay,
                location: locationInput.value.trim() || undefined,
                description: descInput.value.trim() || undefined,
                url: urlInput.value.trim() || undefined,
                rrule: freq ? buildSimpleRrule(freq, start, context.timeZone) : undefined,
                alarms: alarmMinutes === undefined ? undefined : [{ trigger: -alarmMinutes * MS_MINUTE, action: "DISPLAY" }],
                tzid: event.tzid,
            };
            // 必须先 resolve：handle.close() 内部会触发 onClose（resolve cancel），先关会吞掉 save
            resolve({ action: "save", event: payload });
            handle.close();
        });
    });
}

/** 生成简单 RRULE（可与已有 RRULE 合并，这里只保留 FREQ 语义） */
export function buildSimpleRrule(freq: string, startTs: number, timeZone: string): string {
    const parts = partsOf(startTs, timeZone);
    const weekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][weekday7(parts.weekday)];
    switch (freq) {
        case "DAILY":
            return "FREQ=DAILY";
        case "WEEKLY":
            return `FREQ=WEEKLY;BYDAY=${weekday}`;
        case "MONTHLY":
            return `FREQ=MONTHLY;BYMONTHDAY=${parts.day}`;
        case "YEARLY":
            return `FREQ=YEARLY;BYMONTH=${parts.month};BYMONTHDAY=${parts.day}`;
        default:
            return "";
    }
}

function weekday7(weekday: number): number {
    return ((weekday % 7) + 7) % 7;
}

/**
 * 查看插件日志。
 *
 * 存在的意义：思源桌面版没有浏览器控制台入口，普通用户看不到 `console.log`。
 * 这里把内存中缓存的日志直接渲染出来，并提供「复制全部 / 清空 / 刷新」。
 */
export function openLogDialog(plugin?: { name: string; displayName?: string }): void {
    const wrap = document.createElement("div");
    wrap.className = "cc-logs";

    const status = document.createElement("div");
    status.className = "cc-field__hint";

    const list = document.createElement("pre");
    list.className = "cc-logs__list";

    const render = (): void => {
        const entries = logger.snapshot();
        list.textContent = entries.length
            ? entries
                  .map(
                      (entry) =>
                          `${new Date(entry.time).toLocaleTimeString()} ${entry.level.toUpperCase()} ${entry.message}`,
                  )
                  .join("\n")
            : t("logsEmptyHint");
        status.textContent = `${t("logsCount", { n: String(entries.length) })} · ${t("debug")}: ${
            logger.isEnabled() ? t("enabled") : t("directionOff")
        }`;
        list.scrollTop = list.scrollHeight;
    };

    const actions = document.createElement("div");
    actions.className = "cc-dialog__actions";
    const copyButton = button(t("logsCopy"));
    copyButton.addEventListener("click", () => {
        void copyText(logger.toText() || t("logsEmptyHint")).then((ok) => {
            status.textContent = ok ? t("logsCopied") : t("logsCopyFailed");
        });
    });
    const refreshButton = button(t("refresh"));
    refreshButton.addEventListener("click", render);
    // 导出到文件：日志太大时比「复制」更好用——直接在工作空间里生成一个 .log/.md
    const exportButton = button(t("logsExport"));
    exportButton.addEventListener("click", () => {
        void exportLogToFile(plugin).then((path) => {
            status.textContent = path ? t("logsExported", { path }) : t("logsExportFailed");
        });
    });
    const clearButton = button(t("logsClear"), "danger");
    clearButton.addEventListener("click", () => {
        logger.clear();
        render();
    });
    const closeButton = button(t("logsClose"), "primary");
    actions.append(clearButton, status, refreshButton, exportButton, copyButton, closeButton);

    wrap.append(list);
    const handle = openDialog({
        title: plugin ? `${t("logsTitle")} · ${plugin.displayName || plugin.name}` : t("logsTitle"),
        content: wrap,
        footer: actions,
        width: 720,
    });
    closeButton.addEventListener("click", () => handle.close());
    render();
}

/**
 * 把日志导出成工作空间里的一个文件。
 *
 * 日志体积大时（含请求体/响应体）复制到剪贴板很容易失败或丢内容，
 * 写文件更可靠：默认落在 `data/storage/petal/<插件>/logs-<时间>.log`，
 * 用户可以直接用文件管理器打开该目录。
 */
export async function exportLogToFile(plugin?: { name: string; displayName?: string }): Promise<string | undefined> {
    const now = new Date();
    const stamp =
        `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-` +
        `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(
            now.getSeconds(),
        ).padStart(2, "0")}`;
    const name = `calendar-caldav-log-${stamp}.log`;
    const dir = `/data/storage/petal/${plugin?.name ?? "siyuan-plugin-calendar-caldav"}`;
    const header = [
        `# 日历插件日志导出`,
        `# 导出时间：${now.toLocaleString()}`,
        `# 插件版本：${plugin?.displayName ?? plugin?.name ?? "unknown"}`,
        `# 系统：${navigator.userAgent}`,
        `# 共 ${logger.size} 条`,
    ];
    try {
        const file = new File([logger.toDump(header)], name, { type: "text/plain" });
        await putFile(`${dir}/${name}`, file);
        logger.log(`日志已导出：${dir}/${name}`);
        return `${dir}/${name}`;
    } catch (error) {
        logger.warn("日志导出失败", error);
        return undefined;
    }
}

/** 复制文本：优先 Clipboard API，失败时退回 execCommand */async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* 落到兜底方案 */
    }
    try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        const ok = typeof document.execCommand === "function" ? document.execCommand("copy") : false;
        area.remove();
        return ok;
    } catch {
        return false;
    }
}
