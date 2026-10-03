import type { CalendarEvent, CalendarInfo, CalendarSourceCalDav, EventMapping } from "../types";
import type { CalDavAdapter } from "../state/sources";
import {
    CalDavClient,
    type RemoteCalendar,
    type RemoteCalendarObjects,
    type RemoteEventResource,
} from "./client";
import { expandEvents, extractUid, looksLikeIcs, parseIcs } from "./ics";
import { hashString } from "../util/misc";

/** 判断两个资源 href 是否指向同一资源（容忍绝对 URL / 路径、百分号编码与结尾斜杠差异） */
function sameResource(a: string, b: string): boolean {
    const path = (value: string): string => {
        let pathname = value;
        try {
            pathname = new URL(value).pathname;
        } catch {
            pathname = value.split(/[?#]/)[0];
        }
        try {
            pathname = decodeURIComponent(pathname);
        } catch {
            /* 保持原样 */
        }
        return pathname.replace(/\/+$/, "");
    };
    return path(a) === path(b);
}

export interface CalDavAdapterOptions {
    accountId: string;
    calendar: RemoteCalendar;
    info: CalendarInfo;
    client: () => CalDavClient;
    zone: string;
    /** 账户缓存的 sync-token（增量同步）；用 getter 读取，避免构造时的快照失效 */
    syncToken?: () => string | undefined;
    /** 同步成功后回写 sync-token */
    onSyncToken?: (token: string | undefined) => void;
    log?: (message: string, ...rest: unknown[]) => void;
}

/**
 * CalDAV 数据源适配器：
 * - `loadEvents` 供视图层直接读取（未开启本地同步时也能看到远端事件）；
 * - `loadResource` 供同步引擎使用，保留 ETag/href 等同步元数据。
 */
export class CalDavSourceAdapter implements CalDavAdapter {
    readonly info: CalendarInfo;
    readonly source: CalendarSourceCalDav;
    /** 该日历已知不支持 calendar-multiget（避免每轮都发一个注定失败的请求） */
    private readonly multigetUnsupported = new Set<string>();

    constructor(private readonly options: CalDavAdapterOptions) {
        this.info = options.info;
        this.source = options.info.source as CalendarSourceCalDav;
    }

    get remote(): RemoteCalendar {
        return this.options.calendar;
    }

    isWritable(): boolean {
        return !this.options.calendar.readOnly && !this.info.readOnly;
    }

    owns(event: CalendarEvent): boolean {
        return event.calendar === this.info.id;
    }

    /**
     * 该日历是否支持 `VEVENT`（日程）。
     * 服务器若不返回 `supported-calendar-component-set`，则保守认为支持。
     */
    supportsEvents(): boolean {
        const components = this.options.calendar.components;
        return !components?.length || components.includes("VEVENT");
    }

    /** 该日历是否支持 `VTODO`（任务） */
    supportsTasks(): boolean {
        const components = this.options.calendar.components;
        return !components?.length || components.includes("VTODO");
    }

    /**
     * 判断「本地条目」是否属于本日历。
     *
     * 用途：推送阶段会遍历思源里所有带 UID 属性的文档。若不校验归属，
     * 新建在 A 日历的事件会被同时创建到 B 日历（**误推送**），
     * 而只支持任务的日历还会因此收到 VEVENT 并报 500。
     *
     * 注意：文档上记录的是**日历地址**（`sync` 写入 `calendarUrl`），不是 `info.id`。
     */
    belongsTo(event: CalendarEvent, options?: { allowUnassigned?: boolean }): boolean {
        const url = this.options.calendar.url.replace(/\/+$/, "");
        const value = (event.calendar ?? "").trim();
        // 未记录归属的文档：只有在本日历是唯一可写日历时才认领，
        // 否则同一个新建事件会被复制到多个日历（另一种误推送）。
        if (!value) {
            return options?.allowUnassigned === true;
        }
        return value.replace(/\/+$/, "") === url;
    }

    async loadEvents(start: number, end: number): Promise<CalendarEvent[]> {
        const { events } = await this.loadResource(start, end, { forceFull: true });
        return events;
    }

    /**
     * 拉取原始资源 + 展开后的事件。
     *
     * `forceFull` 为 true 时强制走全量 `calendar-query`：
     * 视图渲染必须使用全量结果，否则增量（只返回变化项）会覆盖掉区间缓存，
     * 导致日历看起来「只剩下改过的那几条」。
     */
    async loadResource(
        start: number,
        end: number,
        options?: { forceFull?: boolean },
    ): Promise<{ events: CalendarEvent[]; objects: RemoteCalendarObjects }> {
        const client = this.options.client();
        const token = options?.forceFull ? undefined : this.options.syncToken?.();
        const objects = await client.fetchEvents(this.options.calendar, start, end, token);
        if (objects.syncToken) {
            this.options.onSyncToken?.(objects.syncToken);
        }
        // 兼容层 1：REPORT 没给出任何资源 → 退回 PROPFIND 枚举（Vikunja 这类实现）
        // 兼容层 2：REPORT 给了资源但没给 calendar-data → 按 href 补取（企业微信）
        await this.ensureResourceContent(client, objects, start, end);
        const events: CalendarEvent[] = [];
        for (const resource of objects.resources) {
            if (!resource.ics) {
                continue;
            }
            const parsed = parseIcs(resource.ics, {
                calendarId: this.info.id,
                sourceKind: "caldav",
                href: resource.href,
                defaultTimeZone: this.options.zone,
            });
            for (const event of parsed) {
                events.push(event);
            }
        }
        const expanded = expandEvents(events, {
            windowStart: start,
            windowEnd: end,
            timeZone: this.options.zone,
        });
        return {
            events: expanded.map((event) => this.decorate(event)),
            objects,
        };
    }

    private decorate(event: CalendarEvent): CalendarEvent {
        return {
            ...event,
            calendarName: this.info.name,
            color: this.info.color,
            readOnly: !this.isWritable(),
        };
    }

    /**
     * 保证 `objects.resources` 里每一项都拿到了 ICS 正文。
     *
     * 分三步，覆盖不同 CalDAV 实现的「格式不统一」：
     * 1. 好的情况：`calendar-query` 已经把 `<c:calendar-data>` 返回了，直接返回；
     * 2. 只有 href/ETag（企业微信实测）→ `calendar-multiget`，不支持则逐条 GET；
     * 3. 连资源都没有（有些实现 REPORT 直接返回空 multistatus）→ PROPFIND depth 1 枚举，
     *    再按 href 取正文。
     *
     * 失败不抛错：宁可少显示事件，也不要让整个日历渲染失败。
     */
    private async ensureResourceContent(
        client: CalDavClient,
        objects: RemoteCalendarObjects,
        start: number,
        end: number,
    ): Promise<void> {
        if (!objects.resources.length || objects.hasContent === false) {
            try {
                const listed = await client.listResources(this.options.calendar.url);
                if (listed.length) {
                    this.options.log?.(
                        `REPORT 未返回资源，改由 PROPFIND 枚举到 ${listed.length} 个资源（${this.info.name}）`,
                    );
                    objects.resources = listed;
                }
            } catch (error) {
                this.options.log?.(`PROPFIND 枚举资源失败（${this.info.name}）`, error);
            }
        }

        const missing = objects.resources.filter((item) => !item.ics && item.href);
        if (!missing.length) {
            return;
        }
        const fetched = await this.fetchMissingContent(client, missing);
        let unresolved = 0;
        for (const [href, resource] of fetched) {
            const target = objects.resources.find((item) => sameResource(item.href, href));
            if (!target) {
                continue;
            }
            target.ics = resource.ics;
            target.uid = resource.uid ?? target.uid;
            target.hash = resource.hash ?? target.hash;
            if (!target.etag && resource.etag) {
                target.etag = resource.etag;
            }
        }
        for (const item of missing) {
            if (!objects.resources.find((other) => sameResource(other.href, item.href))?.ics) {
                unresolved++;
            }
        }
        // 明确报出「有资源但取不到内容」，避免再次出现「静默显示为空」
        this.options.log?.(
            `${this.info.name}: ${objects.resources.length} 个资源，补取 ${missing.length} 个正文` +
                (unresolved ? `，其中 ${unresolved} 个失败` : "") +
                `（窗口 ${new Date(start).toISOString().slice(0, 10)} ~ ${new Date(end).toISOString().slice(0, 10)}）`,
        );
    }

    /**
     * 为「只有 href/ETag、没有内容」的资源补取 ICS。
     *
     * 策略：先试 `calendar-multiget`（一次请求拿多条，省往返），失败或仍缺内容时
     * 再按并发上限逐条 GET。企业微信正是必须走这一步的服务端。
     */
    private async fetchMissingContent(
        client: CalDavClient,
        missing: RemoteEventResource[],
    ): Promise<Map<string, RemoteEventResource>> {
        const result = new Map<string, RemoteEventResource>();
        const calendarUrl = this.options.calendar.url;
        // 已知不支持 multiget 的日历（例如企业微信用 Depth 不当会 403）：直接走逐条 GET，
        // 避免每次刷新都先发一个注定失败的 REPORT。
        const supportsMultiget = !this.multigetUnsupported.has(calendarUrl);
        if (supportsMultiget) {
            const limit = 20;
            for (let index = 0; index < missing.length; index += limit) {
                const chunk = missing.slice(index, index + limit);
                try {
                    const resources = await client.multiget(
                        calendarUrl,
                        chunk.map((item) => item.href),
                    );
                    for (const resource of resources) {
                        if (resource.ics) {
                            result.set(resource.href, resource);
                        }
                    }
                } catch (error) {
                    this.multigetUnsupported.add(calendarUrl);
                    this.options.log?.("calendar-multiget 不受支持，改用逐条 GET", error);
                    break;
                }
            }
        }

        const stillMissing = missing.filter((item) => ![...result.keys()].some((href) => sameResource(href, item.href)));
        if (!stillMissing.length) {
            return result;
        }

        // 逐条 GET：限制并发，避免一次同步打出几十个请求
        const concurrency = 4;
        let cursor = 0;
        const worker = async (): Promise<void> => {
            while (cursor < stillMissing.length) {
                const item = stillMissing[cursor++];
                try {
                    const { ics, etag } = await client.getEvent(item.href);
                    if (ics && looksLikeIcs(ics)) {
                        result.set(item.href, {
                            href: item.href,
                            etag: etag ?? item.etag,
                            ics,
                            uid: extractUid(ics),
                            hash: hashString(ics),
                        });
                    }
                } catch (error) {
                    this.options.log?.(`补取事件内容失败：${item.href}`, error);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, stillMissing.length) }, worker));
        return result;
    }

    /* —— 写回远端的薄封装（供同步引擎调用，避免其直接依赖 HTTP 细节） —— */

    /** 新建远端资源 */
    async createRemote(uid: string, ics: string): Promise<{ url: string; etag?: string }> {
        return this.options.client().createEvent(this.options.calendar.url, uid, ics);
    }

    /** 覆盖远端资源（不做冲突检测，调用方负责 ETag 判定） */
    async putRemote(href: string, ics: string, etag?: string): Promise<{ etag?: string }> {
        return this.options.client().updateEvent(href, ics, etag);
    }

    /** 删除远端资源 */
    async deleteRemote(href: string, etag?: string): Promise<void> {
        return this.options.client().deleteEvent(href, etag);
    }

    /** 冲突「以本地为准」时使用（内部走 putRemote） */
    async pushIcs(href: string, ics: string, etag?: string): Promise<{ etag?: string }> {
        return this.putRemote(href, ics, etag);
    }
}

/** 把远端资源写入映射表所需的最小信息 */
export function resourceMapping(
    calendarUrl: string,
    uid: string,
    resource: { href: string; etag?: string; hash?: string },
    local?: EventMapping["local"],
): EventMapping {
    return {
        uid,
        calendarUrl,
        href: resource.href,
        etag: resource.etag,
        remoteHash: resource.hash,
        local,
        syncedAt: Date.now(),
    };
}

