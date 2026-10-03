import type { CalendarEvent, CalendarInfo, CalendarSourceAv } from "../types";
import type { ISourceAdapter } from "../state/sources";
import { renderAttributeView, sql } from "../kernel/api";
import { getLocalTimeZone, MS_DAY, MS_MINUTE } from "../util/date";
import { escapeSql } from "./localStore";
import { hashString } from "../util/misc";

/** 日历区间上限：内核要求跨度不超过 63 天 */
export const MAX_CALENDAR_RANGE_DAYS = 63;

/** 属性视图「日历」布局可用作日期源的字段类型 */
export const DATE_FIELD_TYPES = ["date", "created", "updated"] as const;

export interface AvField {
    id: string;
    name: string;
    type: string;
}

export interface LoadedAvEvents {
    events: CalendarEvent[];
    /** 当前视图绑定的日期字段（日历布局下由内核返回） */
    dateKeyID?: string;
    colorKeyID?: string;
    /** 视图名称与类型，便于 UI 展示 */
    viewName?: string;
    viewType?: string;
    /** 服务端确认的时间区间 */
    range?: { start: number; end: number; timeZone: string };
    fields: AvField[];
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
    if (value === undefined || value === null) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** `date.content` 在 3.x 是毫秒数字；这里同时兼容字符串形式 */
function toTimestamp(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return value;
    }
    if (typeof value === "string" && /^\d{10,13}$/.test(value.trim())) {
        const parsed = parseInt(value.trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return value.trim().length === 10 ? parsed * 1000 : parsed;
        }
    }
    return undefined;
}

function textOf(value: unknown): string {
    const record = asRecord(value);
    if (!record) {
        return typeof value === "string" ? value : "";
    }
    const text = asRecord(record.text);
    if (text && typeof text.content === "string") {
        return text.content;
    }
    const block = asRecord(record.block);
    if (block && typeof block.content === "string") {
        return block.content;
    }
    const number = asRecord(record.number);
    if (number) {
        if (typeof number.content === "number") {
            return String(number.content);
        }
        if (typeof number.formattedContent === "string") {
            return number.formattedContent;
        }
    }
    const template = asRecord(record.template);
    if (template && typeof template.content === "string") {
        return template.content;
    }
    const url = asRecord(record.url);
    if (url && typeof url.content === "string") {
        return url.content;
    }
    if (typeof record.renderedContent === "string") {
        return record.renderedContent;
    }
    return "";
}

function selectOf(value: unknown): { content: string; color?: string } | undefined {
    const record = asRecord(value);
    const list = asArray(record?.mSelect as Record<string, unknown> | Record<string, unknown>[] | undefined);
    const first = asRecord(list[0]);
    if (!first) {
        return undefined;
    }
    const content = typeof first.content === "string" ? first.content : "";
    return content ? { content, color: typeof first.color === "string" ? first.color : undefined } : undefined;
}

/** 解析 renderAttributeView 的返回（data 可能是 JSON 字符串） */
export function parseRenderPayload(raw: unknown, viewID?: string): Record<string, unknown> | undefined {
    let data = raw;
    if (typeof data === "string") {
        try {
            data = JSON.parse(data);
        } catch {
            return undefined;
        }
    }
    const root = asRecord(data);
    if (!root) {
        return undefined;
    }
    // 兼容 {view: {...}} 与直接返回视图对象两种形态
    const nested = asRecord(root.view);
    if (nested) {
        return nested;
    }
    if (viewID && Array.isArray(root.views)) {
        const matched = asArray(root.views as Record<string, unknown>[])
            .map((item) => asRecord(item))
            .find((item) => item?.id === viewID);
        if (matched) {
            return matched;
        }
    }
    if (Array.isArray(root.rows) || Array.isArray(root.cards)) {
        return root;
    }
    return undefined;
}

/**
 * 属性视图（数据库）日历数据源。
 *
 * 内核自 3.x 起原生支持 `calendar` 视图类型：`/api/av/renderAttributeView`
 * 会返回 `viewType: "calendar"` 与 `view.calendar.dateKeyID`，行数据与表格布局一致。
 * 该布局只能读取，写回需要构造 `setAttrViewBlockAttrs` 事务，目前刻意保持只读。
 */
export class SiYuanAttributeViewSourceAdapter implements ISourceAdapter {
    readonly info: CalendarInfo;
    /** 最近一次成功加载时记录的字段信息 */
    lastFields: AvField[] = [];
    lastDateKeyID?: string;

    constructor(
        private readonly options: {
            source: CalendarSourceAv;
            info: CalendarInfo;
            zone?: string;
        },
    ) {
        this.info = options.info;
    }

    get zone(): string {
        return this.options.zone ?? getLocalTimeZone();
    }

    isWritable(): boolean {
        return false;
    }

    owns(event: CalendarEvent): boolean {
        return event.calendar === this.info.id;
    }

    async loadEvents(start: number, end: number): Promise<CalendarEvent[]> {
        const { events } = await this.load(start, end);
        return events;
    }

    /** 拉取区间内的事件，并回传字段信息供设置界面使用 */
    async load(start: number, end: number): Promise<LoadedAvEvents> {
        const source = this.options.source;
        const viewID = source.viewID;
        // 内核要求 calendarRange 跨度 ≤ 63 天，超出时按窗口切片合并
        const span = end - start;
        const slices: Array<{ start: number; end: number }> = [];
        if (span <= MAX_CALENDAR_RANGE_DAYS * MS_DAY) {
            slices.push({ start, end });
        } else {
            for (let cursor = start; cursor < end; cursor += MAX_CALENDAR_RANGE_DAYS * MS_DAY) {
                slices.push({ start: cursor, end: Math.min(end, cursor + MAX_CALENDAR_RANGE_DAYS * MS_DAY) });
            }
        }

        const events = new Map<string, CalendarEvent>();
        let dateKeyID = source.dateKeyID;
        let effectiveDateKey = source.dateKeyID;
        let colorKeyID = source.colorKeyID;
        let viewName: string | undefined;
        let viewType: string | undefined;
        let fields: AvField[] = [];

        for (const slice of slices) {
            const raw = await renderAttributeView(source.avID, viewID, {
                pageSize: 500,
                calendarRange: { start: slice.start, end: slice.end, timeZone: this.zone },
            });
            const view = parseRenderPayload(raw, viewID);
            if (!view) {
                continue;
            }
            const calendarSettings = asRecord(view.calendar);
            if (!dateKeyID && typeof calendarSettings?.dateKeyID === "string" && calendarSettings.dateKeyID) {
                dateKeyID = calendarSettings.dateKeyID;
            }
            if (!colorKeyID && typeof calendarSettings?.colorKeyID === "string" && calendarSettings.colorKeyID) {
                colorKeyID = calendarSettings.colorKeyID;
            }
            if (typeof view.name === "string" && !viewName) {
                viewName = view.name;
            }
            if (typeof (view as { type?: unknown }).type === "string" && !viewType) {
                viewType = (view as { type: string }).type;
            }
            if (!fields.length) {
                fields = asArray(view.columns as Record<string, unknown>[] | Record<string, unknown> | undefined)
                    .map((column) => asRecord(column))
                    .filter((column): column is Record<string, unknown> => !!column && typeof column.id === "string")
                    .map((column) => ({
                        id: String(column.id),
                        name: typeof column.name === "string" ? column.name : String(column.id),
                        type: typeof column.type === "string" ? column.type : "",
                    }));
            }
            effectiveDateKey = dateKeyID ?? this.inferDateKey(fields);
            for (const event of this.rowsToEvents(view.rows, effectiveDateKey, colorKeyID, slice, fields)) {
                events.set(`${event.uid}`, event);
            }
        }

        this.lastFields = fields;
        // 记录「实际生效」的日期字段：内核未绑定时可能是自动推断出来的
        const resolvedDateKey = effectiveDateKey ?? dateKeyID;
        this.lastDateKeyID = resolvedDateKey;
        if (resolvedDateKey && source.dateKeyID !== resolvedDateKey) {
            // 写回数据源，便于界面持久化与下次直接使用
            this.options.source.dateKeyID = resolvedDateKey;
        }
        return {
            events: [...events.values()].sort((a, b) => a.start - b.start),
            dateKeyID: resolvedDateKey,
            colorKeyID,
            viewName,
            viewType,
            range: { start, end, timeZone: this.zone },
            fields,
        };
    }

    private inferDateKey(fields: AvField[]): string | undefined {
        return fields.find((field) => (DATE_FIELD_TYPES as readonly string[]).includes(field.type))?.id;
    }

    private rowsToEvents(
        rowsRaw: unknown,
        dateKeyID: string | undefined,
        colorKeyID: string | undefined,
        slice: { start: number; end: number },
        fields: AvField[],
    ): CalendarEvent[] {
        if (!dateKeyID) {
            return [];
        }
        const events: CalendarEvent[] = [];
        for (const rowRaw of asArray(rowsRaw as Record<string, unknown>[] | Record<string, unknown> | undefined)) {
            const row = asRecord(rowRaw);
            if (!row || typeof row.id !== "string") {
                continue;
            }
            const itemID = row.id;
            const cells = asArray(row.cells as Record<string, unknown>[] | Record<string, unknown> | undefined)
                .map((cell) => asRecord(cell))
                .filter((cell): cell is Record<string, unknown> => !!cell);
            const dateCell = cells.find((cell) => {
                const value = asRecord(cell.value);
                return value?.keyID === dateKeyID;
            });
            const dateValue = asRecord(dateCell?.value);
            const date = asRecord(dateValue?.date) ?? asRecord(dateValue?.created) ?? asRecord(dateValue?.updated);
            const start = toTimestamp(date?.content) ?? toTimestamp(dateValue?.content);
            if (start === undefined) {
                continue;
            }
            const isNotTime = date?.isNotTime !== false;
            const hasEndDate = date?.hasEndDate === true;
            const endRaw = hasEndDate ? toTimestamp(date?.content2) : undefined;
            let end = endRaw ?? start + (isNotTime ? MS_DAY : 60 * MS_MINUTE);
            if (end <= start) {
                end = start + (isNotTime ? MS_DAY : 60 * MS_MINUTE);
            }
            // 只保留与本次区间相交的行
            if (end <= slice.start || start >= slice.end) {
                continue;
            }
            const titleKey = this.resolveTitleKey(fields, dateKeyID);
            const titleCell = titleKey
                ? cells.find((cell) => asRecord(cell.value)?.keyID === titleKey)
                : undefined;
            const title = textOf(titleCell?.value) || this.options.source.label || "(未命名)";
            const color = colorKeyID
                ? selectOf(cells.find((cell) => asRecord(cell.value)?.keyID === colorKeyID)?.value)?.color
                : undefined;
            // 「插件标识」列：用于区分哪些行由插件写入（用户手写的行该列为空）
            const markerKey = this.options.source.markerKeyID;
            const marker = markerKey
                ? textOf(cells.find((cell) => asRecord(cell.value)?.keyID === markerKey)?.value) || undefined
                : undefined;
            events.push({
                uid: `av-${itemID}`,
                calendar: this.info.id,
                calendarName: this.info.name,
                color: color ?? this.info.color,
                sourceKind: "av",
                title,
                start,
                end,
                allDay: isNotTime,
                hasEndDate,
                tzid: isNotTime ? undefined : this.zone,
                readOnly: true,
                siyuan: { itemID, avID: this.options.source.avID, dateKeyID, blockID: itemID, marker },
            });
        }
        return events;
    }

    private resolveTitleKey(fields: AvField[], dateKeyID: string): string | undefined {
        const configured = this.options.source.titleKeyID;
        if (configured) {
            return configured;
        }
        const preferred = fields.find(
            (field) => field.id !== dateKeyID && (field.type === "text" || field.type === "block"),
        );
        return preferred?.id ?? fields.find((field) => field.id !== dateKeyID)?.id;
    }
}

/**
 * 探测数据库（属性视图）信息：读取字段列表与默认视图，供设置界面选择日期/标题字段。
 * 失败返回 `undefined` 而不是抛错，便于界面给出可读提示。
 */
export async function detectAttributeView(
    avID: string,
    viewID?: string,
): Promise<{
    name: string;
    viewID?: string;
    viewType?: string;
    fields: AvField[];
    calendarDateKeyID?: string;
    /** 解析出的真正属性视图 ID（可能与传入的块 ID 不同） */
    resolvedAvID?: string;
    /** 字段清单摘要（`名称(类型)=keyID`），用于日志 */
    fieldsSummary?: string;
} | undefined> {
    const safeID = avID.trim().replace(/^["'`]+|["'`]+$/g, "");
    if (!safeID) {
        return undefined;
    }
    // 1) 名称与 ial：用 SQL 读属性视图块，顺便解析真正的 avID
    let name = safeID;
    const rows = await sql<{ content?: string; ial?: string }>(
        `SELECT content, ial FROM blocks WHERE id = '${escapeSql(safeID)}' LIMIT 1`,
    ).catch(() => []);
    if (rows.length && typeof rows[0].content === "string" && rows[0].content) {
        name = rows[0].content;
    }
    // 新建数据库块时，用户复制的**块 ID** 与内核的**属性视图 ID（avID）并不相同**：
    // avID 记在块的 ial 里（custom-av-id）。这里必须解析出来，否则 renderAttributeView
    // 会读不到任何字段（表现为「未读取到字段」）。
    const resolved = resolveAvID(rows[0]?.ial, safeID);

    // 2) 用 renderAttributeView 取字段与默认视图
    //
    // 注意：**只有当 viewID 属于当前这个属性视图时才能带上**。用户换了数据库块后，
    // 配置里的 viewID 还是上一个数据库的，内核会抛 `view not found`，
    // 表现为「未读取到字段」（v0.5.0 起引入的问题）。
    // 探测一律用 silent：viewID 失效时内核会拒绝，但**不该**给用户弹「view not found」，
    // 因为插件会自动去掉它重试（用户看到的应该是最终结果，而不是中间失败）。
    const attempt = async (useViewID?: string): Promise<unknown> =>
        renderAttributeView(resolved, useViewID, { pageSize: 1, silent: true }).catch(() => undefined);
    let raw = await attempt(viewID);
    let view = parseRenderPayload(raw, viewID);
    if (!view && viewID) {
        // 视图 ID 无效（多半来自另一个数据库）：去掉它再试一次，并采用新读到的视图
        raw = await attempt(undefined);
        view = parseRenderPayload(raw, undefined);
    }
    if (!view) {
        return { name, fields: [] };
    }
    const fields = asArray(view.columns as Record<string, unknown>[] | Record<string, unknown> | undefined)
        .map((column) => asRecord(column))
        .filter((column): column is Record<string, unknown> => !!column && typeof column.id === "string")
        .map((column) => ({
            id: String(column.id),
            name: typeof column.name === "string" ? column.name : String(column.id),
            type: typeof column.type === "string" ? column.type : "",
        }));
    const calendarSettings = asRecord(view.calendar);
    const viewType = typeof (view as { type?: unknown }).type === "string" ? (view as { type: string }).type : undefined;
    const detectedViewID = typeof view.id === "string" ? view.id : undefined;
    return {
        name,
        viewID: detectedViewID,
        viewType,
        fields,
        resolvedAvID: resolved,
        // 字段清单也返回给调用方打日志：绑定错列时能一眼看出 name/type
        fieldsSummary: fields.map((field) => `${field.name}(${field.type})=${field.id}`).join(", "),
        calendarDateKeyID:
            typeof calendarSettings?.dateKeyID === "string" && calendarSettings.dateKeyID
                ? calendarSettings.dateKeyID
                : undefined,
    };
}

/** 构造属性视图数据源的稳定 ID */
export function attributeViewCalendarId(source: CalendarSourceAv): string {
    return `av:${source.avID}:${hashString(JSON.stringify([source.avID, source.viewID ?? "", source.dateKeyID ?? ""]))}`;
}

/**
 * 从数据库块的 `ial` 里解析真正的属性视图 ID（avID）。
 *
 * 实测：用户右键复制到的是**块 ID**，而 `renderAttributeView` 需要的是
 * **属性视图 ID**，两者不同——`custom-av-id` 属性里才是后者。ial 形如：
 * `{: id="20261003…" custom-av-id="20261003…" …}`（也可能是 `av-id`）。
 * 解析不到时原样返回传入的 ID，保持对「直接填 avID」用法的兼容。
 */
export function resolveAvID(ial: string | undefined, fallback: string): string {
    if (!ial) {
        return fallback;
    }
    for (const key of ["custom-av-id", "av-id", "avID"]) {
        const match = new RegExp(`${key}="([^"]+)"`).exec(ial);
        if (match && match[1]) {
            return match[1];
        }
    }
    return fallback;
}
