import type { CalendarEvent, CalendarInfo, CalendarSourceQuery } from "../types";
import type { CalendarStore } from "../state/store";
import type { ISourceAdapter } from "../state/sources";
import {
    getBlockAttrs,
    parseSiyuanTime,
    pickCustomAttrs,
    request,
    sql,
    updateBlock,
    setBlockAttrs,
    getDocInfo,
    formatSiyuanTime,
} from "../kernel/api";
import { hashString, uuid } from "../util/misc";

/** 本插件写入思源自定义属性时使用的字段名（不含 custom- 前缀） */
export interface LocalAttrNameMap {
    uid: string;
    calendar: string;
    synced: string;
    start: string;
    end: string;
    title?: string;
    location?: string;
    description?: string;
    etag?: string;
    href?: string;
    recurrenceId?: string;
    instance?: string;
    /** 其余事件字段的 JSON（rrule/categories/status/transparency/class/url/alarms/attendees） */
    extra?: string;
}

interface BlockRow {
    id: string;
    parent_id?: string;
    root_id?: string;
    box?: string;
    path?: string;
    hPath?: string;
    content?: string;
    name?: string;
    fcontent?: string;
    alias?: string;
    tag?: string;
    created?: string;
    updated?: string;
    type?: string;
    ial?: string;
}

export interface SiYuanQueryAdapterOptions {
    source: CalendarSourceQuery;
    info: CalendarInfo;
    zone: string;
    /** 每源最多拉取多少条，避免 SQL 全表扫描 */
    limit?: number;
}

export function escapeSql(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * 把思源「SQL 查询」结果映射为日历事件。
 *
 * 约定：
 * - 查询必须返回 `id` 列（块 ID）；
 * - 日期取自自定义属性 `custom-<dateAttr>`（支持 `20250103` / `20250103120000` / 毫秒时间戳）；
 * - 标题默认取 `content`，可用 `titleField` 指定 `name`/`fcontent`/`alias`/`content` 或自定义属性名。
 */
export class SiYuanQuerySourceAdapter implements ISourceAdapter {
    readonly info: CalendarInfo;

    constructor(private readonly options: SiYuanQueryAdapterOptions) {
        this.info = options.info;
    }

    isWritable(): boolean {
        return false;
    }

    owns(event: CalendarEvent): boolean {
        return event.calendar === this.info.id;
    }

    async loadEvents(start: number, end: number): Promise<CalendarEvent[]> {
        const stmt = this.buildStatement();
        const rows = await sql<BlockRow>(stmt, this.options.limit ?? 500).catch(() => [] as BlockRow[]);
        const events: CalendarEvent[] = [];
        for (const row of rows) {
            if (!row?.id) {
                continue;
            }
            const attrs = await getBlockAttrs(row.id).catch(() => ({}) as Record<string, string>);
            const event = this.toEvent(row, attrs, row.id);
            if (!event) {
                continue;
            }
            // 只保留与区间相交的事件
            if (event.end < start || event.start > end) {
                continue;
            }
            events.push(event);
        }
        return events;
    }

    /** 由用户提供的 SQL 或默认语句构造查询 */
    private buildStatement(): string {
        const source = this.options.source;
        const stmt = source.stmt?.trim();
        if (stmt) {
            return stmt;
        }
        return `SELECT * FROM blocks WHERE type = 'd' AND ial LIKE '%custom-${escapeSql(source.dateAttr)}%' ORDER BY updated DESC`;
    }

    toEvent(row: BlockRow, attrs: Record<string, string>, blockID: string): CalendarEvent | undefined {
        const source = this.options.source;
        const custom = pickCustomAttrs(attrs);
        const startRaw = custom[source.dateAttr] ?? attrs[`custom-${source.dateAttr}`];
        const start = parseSiyuanTime(startRaw);
        if (start === undefined) {
            return undefined;
        }
        const endRaw = source.endDateAttr ? custom[source.endDateAttr] : undefined;
        const endParsed = parseSiyuanTime(endRaw);
        const hasTime = !!(startRaw && startRaw.length > 8);
        let end = endParsed ?? start + (hasTime ? 3_600_000 : 86_400_000);
        if (end <= start) {
            end = start + (hasTime ? 3_600_000 : 86_400_000);
        }
        const titleField = source.titleField ?? "content";
        const titleValue =
            custom[titleField] ??
            (row as unknown as Record<string, string | undefined>)[titleField] ??
            row.content ??
            row.name ??
            "(未命名)";
        const uid = `siyuan-${hashString(`${blockID}:${source.dateAttr}:${start}`)}`;
        return {
            uid,
            calendar: this.info.id,
            calendarName: this.info.name,
            color: source.color ?? this.info.color,
            sourceKind: "query",
            title: titleValue || "(未命名)",
            start,
            end,
            allDay: !hasTime,
            readOnly: true,
            siyuan: {
                blockID,
                rootID: row.root_id,
                box: row.box,
                path: row.path,
                hPath: row.hPath,
            },
        };
    }
}

export interface LocalDocumentAdapterOptions {
    zone: string;
    /** 文档写入位置 */
    target: {
        notebook: string;
        /** 支持 ${date} ${yyyy} ${MM} ${dd} ${title} 占位符 */
        pathTemplate: string;
    };
    attrNames: LocalAttrNameMap;
    /** 本地索引一次最多读取的文档数（受内核 search.limit 截断，需显式 LIMIT） */
    indexLimit?: number;
    onProgress?: (message: string) => void;
}

export interface LocalDocumentItem {
    uid: string;
    blockID: string;
    rootID: string;
    title: string;
    start: number;
    allDay: boolean;
}

/**
 * 思源文档本地存储：同步到本地的每个远端事件对应一个文档，
 * 通过 `custom-caldav-*` 属性保存 UID/ETag/时间，实现双向追溯。
 */
export class LocalDocumentAdapter {
    private index: Map<string, LocalDocumentItem> | null = null;

    constructor(private readonly options: LocalDocumentAdapterOptions) {}

    private get markerAttr(): string {
        return this.options.attrNames.uid;
    }

    private get indexLimit(): number {
        return Math.max(100, this.options.indexLimit ?? 5000);
    }

    /** 生成同步属性名（供外部构造适配器时使用） */
    static attrsFor(prefix: string): LocalAttrNameMap {
        return {
            uid: `${prefix}caldav-uid`,
            calendar: `${prefix}caldav-calendar`,
            synced: `${prefix}caldav-synced`,
            start: `${prefix}caldav-start`,
            end: `${prefix}caldav-end`,
            title: `${prefix}caldav-title`,
            location: `${prefix}caldav-location`,
            description: `${prefix}caldav-description`,
            etag: `${prefix}caldav-etag`,
            href: `${prefix}caldav-href`,
            recurrenceId: `${prefix}caldav-recurrence-id`,
            instance: `${prefix}caldav-instance`,
            extra: `${prefix}caldav-extra`,
        };
    }

    /** 列出所有由本插件管理的文档（按 UID 建索引） */
    async list(): Promise<Map<string, LocalDocumentItem>> {
        if (this.index) {
            return this.index;
        }
        const items = new Map<string, LocalDocumentItem>();
        // 内核按 search.limit 截断结果（默认 64），因此必须显式 LIMIT 并取足够大的值，
        // 否则索引不完整会把「未纳入索引的已同步文档」误判为本地条目缺失。
        const rows = await sql<BlockRow>(
            `SELECT id, content, ial, created, updated FROM blocks WHERE type = 'd' AND ial LIKE '%${escapeSql(this.markerAttr)}%' LIMIT ${this.indexLimit}`,
        ).catch(() => [] as BlockRow[]);
        if (rows.length >= this.indexLimit) {
            this.options.onProgress?.(
                `已同步文档数量达到索引上限 ${this.indexLimit}，超出的条目本轮不参与同步，可在设置中调大「同步并发/索引上限」。`,
            );
        }
        for (const row of rows) {
            const ial = parseIal(row.ial);
            const uid = ial[this.markerAttr];
            if (!uid) {
                continue;
            }
            const attrs = this.options.attrNames;
            const start = parseSiyuanTime(ial[attrs.start]);
            items.set(uid, {
                uid,
                blockID: row.id,
                rootID: row.root_id ?? row.id,
                title: row.content ?? "",
                start: start ?? 0,
                allDay: true,
            });
        }
        this.index = items;
        return items;
    }

    async refresh(): Promise<Map<string, LocalDocumentItem>> {
        this.index = null;
        return this.list();
    }

    get(uid: string): LocalDocumentItem | undefined {
        return this.index?.get(uid);
    }

    /** 创建文档并写入属性 */
    async create(event: CalendarEvent, meta: { etag?: string; href?: string; calendarUrl: string }): Promise<LocalDocumentItem> {
        const notebook = this.options.target.notebook;
        const path = buildPath(this.options.target.pathTemplate, event);
        const docId = await request<string>("/api/filetree/createDocWithMd", {
            notebook,
            path,
            markdown: buildMarkdown(event, this.options.zone),
        });
        const attrs = this.buildAttrs(event, meta);
        await setBlockAttrs(docId, attrs).catch(() => undefined);
        const item: LocalDocumentItem = {
            uid: event.uid,
            blockID: docId,
            rootID: docId,
            title: event.title,
            start: event.start,
            allDay: event.allDay,
        };
        this.index?.set(event.uid, item);
        return item;
    }

    /** 更新已有文档的属性（必要时同步正文标题） */
    async update(
        item: LocalDocumentItem,
        event: CalendarEvent,
        meta: { etag?: string; href?: string; calendarUrl: string; previousTitle?: string },
    ): Promise<void> {
        const attrs = this.buildAttrs(event, meta);
        await setBlockAttrs(item.blockID, attrs).catch(() => undefined);
        // 索引里的 item.title 是「上一轮同步时的标题」，不代表文档当前标题，
        // 因此由调用方通过 meta.previousTitle 传入基准值，否则正文永远不会被更新。
        const currentTitle = meta.previousTitle ?? item.title;
        if (currentTitle !== event.title) {
            await updateBlock("markdown", buildMarkdown(event, this.options.zone), item.blockID).catch(() => undefined);
            item.title = event.title;
        }
        item.start = event.start;
        item.allDay = event.allDay;
    }

    /** 移除插件属性（保留文档，仅解除同步关系） */
    async unlink(item: LocalDocumentItem): Promise<void> {
        const attrs: Record<string, string | null> = {};
        for (const name of Object.values(this.options.attrNames)) {
            attrs[name] = null;
        }
        await setBlockAttrs(item.blockID, attrs).catch(() => undefined);
        this.index?.delete(item.uid);
    }

    buildAttrs(event: CalendarEvent, meta: { etag?: string; href?: string; calendarUrl: string }): Record<string, string | null> {
        const names = this.options.attrNames;
        const attrs: Record<string, string | null> = {
            [names.uid]: event.uid,
            [names.calendar]: meta.calendarUrl,
            [names.synced]: String(Date.now()),
            [names.start]: formatSiyuanTime(event.start, !event.allDay, this.options.zone),
            [names.end]: formatSiyuanTime(event.end, !event.allDay, this.options.zone),
        };
        if (names.title) {
            attrs[names.title] = event.title || null;
        }
        if (names.location) {
            attrs[names.location] = event.location ?? null;
        }
        if (names.description) {
            attrs[names.description] = event.description ?? null;
        }
        if (names.etag) {
            attrs[names.etag] = meta.etag ?? null;
        }
        if (names.href) {
            attrs[names.href] = meta.href ?? null;
        }
        if (names.recurrenceId) {
            attrs[names.recurrenceId] = event.recurrenceId ?? null;
        }
        if (names.instance) {
            attrs[names.instance] = event.isRecurringInstance || event.isInstanceMirror ? "1" : null;
        }
        if (names.extra) {
            // 其余字段整体存为 JSON，保证「拉取 → 本地 → 推送」往返无损：
            // 否则用户只改标题时，推送会用丢失了 attendees/alarms/status 的事件覆盖远端。
            attrs[names.extra] = encodeExtraFields(event);
        }
        return attrs;
    }

    /**
     * 读取文档上的同步属性并还原为事件对象（用于推送本地修改）。
     * 正文内容不参与解析——事件字段全部保存在自定义属性中，避免解析 Markdown 带来的歧义。
     *
     * 错误语义（重要）：只有「文档存在但没有本插件的 UID 属性」才返回 `undefined`
     * （表示用户解除了同步）；属性读取失败会**抛出**，由调用方按临时故障跳过，
     * 避免把一次 API 抖动误判成「用户删除了文档」从而删除远端事件。
     */
    async loadEvent(blockID: string): Promise<CalendarEvent | undefined> {
        const attrs = await getBlockAttrs(blockID);
        const names = this.options.attrNames;
        const uid = attrs[names.uid];
        if (!uid) {
            return undefined;
        }
        const allDayRaw = attrs[names.start] ?? "";
        const allDay = allDayRaw.length <= 8;
        const start = parseSiyuanTime(attrs[names.start], !allDay);
        if (start === undefined) {
            return undefined;
        }
        const end = parseSiyuanTime(attrs[names.end], !allDay) ?? start + (allDay ? 86_400_000 : 3_600_000);
        const calendarUrl = attrs[names.calendar] ?? "";
        const extra = decodeExtraFields(names.extra ? attrs[names.extra] : undefined);
        const event: CalendarEvent = {
            uid,
            calendar: calendarUrl,
            calendarName: undefined,
            sourceKind: "caldav",
            title: attrs[names.title ?? ""] ?? uid,
            description: attrs[names.description ?? ""] || undefined,
            location: attrs[names.location ?? ""] || undefined,
            start,
            end: end > start ? end : start + (allDay ? 86_400_000 : 3_600_000),
            allDay,
            tzid: allDay ? undefined : this.options.zone,
            isInstanceMirror: attrs[names.instance ?? ""] === "1",
            siyuan: { blockID, rootID: blockID },
            ...extra,
        };
        // 提醒以「相对事件起止的毫秒偏移」持久化，读回后按当前时间重新换算，
        // 这样事件时间变化不会让提醒产生虚假差异
        if (extra.alarms?.length) {
            event.alarms = extra.alarms.map((alarm) => ({
                ...alarm,
                trigger: calibratedTrigger(alarm.trigger, event.start, event.end),
            }));
        }
        return event;
    }
}

/** 把绝对触发时间换算为相对事件起点/终点的毫秒偏移 */
function relativeTrigger(trigger: number, start: number, end: number): number {
    if (trigger >= end - 1000 && trigger <= end + 1000) {
        return trigger - end;
    }
    if (trigger >= start - 1000 && trigger <= start + 1000) {
        return trigger - start;
    }
    return trigger - start;
}

/** 把相对毫秒偏移还原为绝对触发时间 */
function calibratedTrigger(relative: number, start: number, end: number): number {
    return relative >= 0 ? end + relative : start + relative;
}

/** 需要额外持久化的事件字段（用于无损往返） */
interface EventExtraFields {
    rrule?: string;
    categories?: string[];
    status?: CalendarEvent["status"];
    transparency?: CalendarEvent["transparency"];
    cls?: CalendarEvent["cls"];
    url?: string;
    lastModified?: number;
    created?: number;
    hasEndDate?: boolean;
    recurrenceId?: string;
    alarms?: CalendarEvent["alarms"];
    attendees?: CalendarEvent["attendees"];
    organizer?: CalendarEvent["organizer"];
    isRecurringInstance?: boolean;
}

function encodeExtraFields(event: CalendarEvent): string | null {
    const extra: EventExtraFields = {};
    if (event.rrule) {
        extra.rrule = event.rrule;
    }
    if (event.categories?.length) {
        extra.categories = event.categories;
    }
    if (event.status) {
        extra.status = event.status;
    }
    if (event.transparency) {
        extra.transparency = event.transparency;
    }
    if (event.cls) {
        extra.cls = event.cls;
    }
    if (event.url) {
        extra.url = event.url;
    }
    if (typeof event.lastModified === "number") {
        extra.lastModified = event.lastModified;
    }
    if (typeof event.created === "number") {
        extra.created = event.created;
    }
    if (event.hasEndDate) {
        extra.hasEndDate = true;
    }
    if (event.recurrenceId) {
        extra.recurrenceId = event.recurrenceId;
    }
    if (event.alarms?.length) {
        extra.alarms = event.alarms.map((alarm) => ({
            ...alarm,
            trigger: relativeTrigger(alarm.trigger, event.start, event.end),
        }));
    }
    if (event.attendees?.length) {
        extra.attendees = event.attendees;
    }
    if (event.organizer) {
        extra.organizer = event.organizer;
    }
    if (event.isRecurringInstance) {
        extra.isRecurringInstance = true;
    }
    return Object.keys(extra).length ? JSON.stringify(extra) : null;
}

function decodeExtraFields(raw: string | undefined): EventExtraFields {
    if (!raw) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as EventExtraFields)
            : {};
    } catch {
        return {};
    }
}

/**
 * 「可持久化投影」哈希。
 *
 * 思源条目只保存事件字段的一个子集，因此同步判定不能直接用完整事件哈希：
 * 远端事件里的 attendees / alarms / status / class 等字段不会被持久化，
 * 用完整哈希比较会导致每轮同步都误判「本地已修改」并把远端事件重写一遍
 * （从而丢失那些未持久化的字段）。
 */
export function projectionHash(event: CalendarEvent): string {
    return hashString(
        JSON.stringify([
            event.uid,
            event.title ?? "",
            event.description ?? "",
            event.location ?? "",
            event.start,
            event.end,
            event.allDay ? 1 : 0,
            event.rrule ?? "",
        ]),
    );
}

export function parseIal(ial: string | undefined): Record<string, string> {    if (!ial) {
        return {};
    }
    const out: Record<string, string> = {};
    const regex = /([A-Za-z0-9_-]+)="([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(ial))) {
        out[match[1]] = match[2];
    }
    return out;
}

function buildPath(template: string, event: CalendarEvent): string {
    const date = new Date(event.start);
    const safeTitle = event.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "event";
    const rendered = (template || "/日历/${yyyy}/${MM}")
        .replace(/\$\{yyyy\}/g, String(date.getFullYear()))
        .replace(/\$\{MM\}/g, String(date.getMonth() + 1).padStart(2, "0"))
        .replace(/\$\{dd\}/g, String(date.getDate()).padStart(2, "0"))
        .replace(/\$\{date\}/g, `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`)
        .replace(/\$\{title\}/g, safeTitle);
    const prefix = rendered.startsWith("/") ? rendered : `/${rendered}`;
    const unique = `${prefix.replace(/\/$/, "")}/${safeTitle}-${hashString(event.uid).slice(0, 6)}`;
    return unique;
}

function buildMarkdown(event: CalendarEvent, zone: string): string {
    const lines: string[] = [`# ${event.title || "(未命名)"}`, ""];
    lines.push(`- 开始：\`${new Date(event.start).toISOString()}\``);
    lines.push(`- 结束：\`${new Date(event.end).toISOString()}\``);
    if (event.location) {
        lines.push(`- 地点：${event.location}`);
    }
    if (event.rrule) {
        lines.push(`- 重复：\`${event.rrule}\``);
    }
    lines.push(`- 时区：\`${zone}\``);
    if (event.url) {
        lines.push(`- 链接：${event.url}`);
    }
    if (event.description) {
        lines.push("", event.description);
    }
    lines.push("", `<!-- 由 siyuan-plugin-calendar-caldav 同步，UID: ${event.uid} -->`);
    return lines.join("\n");
}

/** 供外部使用：构造同步 UID（思源本地新建事件） */
export function newEventUid(): string {
    return `${uuid()}@siyuan`;
}

/** 工具：把块 ID 解析为文档信息（跳转到思源） */
export async function resolveDoc(blockID: string): Promise<{ id: string; hPath: string; box: string } | undefined> {
    try {
        const info = await getDocInfo(blockID);
        return { id: info.id, hPath: info.hPath, box: info.box };
    } catch {
        return undefined;
    }
}

/** 供 CalendarStore 注册：把查询源适配器挂载到 store */
export function registerQueryAdapter(store: CalendarStore, adapter: SiYuanQuerySourceAdapter): void {
    store.registerAdapter(adapter, adapter.info);
}
