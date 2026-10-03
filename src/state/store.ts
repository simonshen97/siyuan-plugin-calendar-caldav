import type { CalendarEvent, CalendarInfo, PluginSettings } from "../types";
import type { MappingStore } from "./mapping";
import type { ISourceAdapter } from "./sources";
import { getLocalTimeZone } from "../util/date";

export interface CalendarStoreOptions {
    settings: () => PluginSettings;
    mappings: MappingStore;
    /** 事件被写入后由外部（同步引擎）触发，用于刷新 */
    onEventsChanged?: () => void;
    /**
     * 日历启用/停用状态变化时回调（用于持久化）。
     *
     * 必须持久化：以前只存在内存里，重启思源后被停用的日历会全部「复活」。
     */
    onVisibilityChange?: (hiddenIds: string[]) => void;
    log?: (message: string, ...rest: unknown[]) => void;
}

export interface CalendarLoadResult {
    calendarId: string;
    events: number;
    error?: string;
}

/**
 * 视图状态仓库：聚合所有数据源的事件，维护可见性/加载状态，
 * 并向 UI 提供按时间区间查询的能力（区间查询结果做二级缓存）。
 */
export class CalendarStore {
    private adapters = new Map<string, ISourceAdapter>();
    private infos = new Map<string, CalendarInfo>();
    private cache = new Map<string, { start: number; end: number; events: CalendarEvent[]; at: number }>();
    /** 每个日历的缓存有效期：本地数据源随思源数据变化，因此需要更短的 TTL */
    private ttlById = new Map<string, number>();
    private hidden = new Set<string>();
    private loading = new Set<string>();
    private errors = new Map<string, string>();
    private listeners = new Set<() => void>();
    /** 远端日历的缓存有效期（避免每次本地编辑都重新请求远端） */
    private readonly cacheTtl = 30_000;
    /** 本地数据源（属性视图 / SQL 查询）的有效期 */
    private readonly localCacheTtl = 3_000;
    private timeZone: string;

    constructor(private readonly options: CalendarStoreOptions) {
        this.timeZone = getLocalTimeZone();
    }

    get zone(): string {
        return this.timeZone;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch (error) {
                this.options.log?.("store listener failed", error);
            }
        }
    }

    private ttlFor(id: string): number {
        return this.ttlById.get(id) ?? this.cacheTtl;
    }

    registerAdapter(adapter: ISourceAdapter, info: CalendarInfo): void {
        this.adapters.set(info.id, adapter);
        this.infos.set(info.id, info);
        this.cache.delete(info.id);
    }

    /**
     * 注册「本地数据源」（属性视图 / SQL 查询）。
     * 这类数据源会被思源的 transactions 事件影响，因此用更短的缓存有效期。
     */
    registerLocalAdapter(adapter: ISourceAdapter, info: CalendarInfo): void {
        this.registerAdapter(adapter, info);
        this.ttlById.set(info.id, this.localCacheTtl);
    }

    unregisterAdapter(id: string): void {
        this.adapters.delete(id);
        this.infos.delete(id);
        this.cache.delete(id);
        this.ttlById.delete(id);
        this.errors.delete(id);
        this.loading.delete(id);
    }

    clearAdapters(): void {
        this.adapters.clear();
        this.infos.clear();
        this.cache.clear();
        this.ttlById.clear();
        this.errors.clear();
        this.loading.clear();
        this.emit();
    }

    getAdapter(id: string): ISourceAdapter | undefined {
        return this.adapters.get(id);
    }

    listCalendars(): CalendarInfo[] {
        return [...this.infos.values()].sort((a, b) => {
            const kindOrder = { caldav: 0, av: 1, query: 2, virtual: 3 } as const;
            const diff = kindOrder[a.source.kind] - kindOrder[b.source.kind];
            return diff !== 0 ? diff : a.name.localeCompare(b.name);
        });
    }

    setCalendarInfo(info: CalendarInfo): void {
        this.infos.set(info.id, info);
        this.emit();
    }

    /** 只列出「已启用」的日历（界面上方与同步都以此为准） */
    visibleCalendars(): CalendarInfo[] {
        return this.listCalendars().filter((info) => this.isVisible(info.id));
    }

    isVisible(id: string): boolean {
        if (this.hidden.has(id)) {
            return false;
        }
        const source = this.infos.get(id)?.source;
        if (source?.kind === "caldav") {
            const account = this.options.settings().accounts.find((item) => item.id === source.accountId);
            if (account && !account.enabled) {
                return false;
            }
        }
        return true;
    }

    setVisible(id: string, visible: boolean): void {
        if (visible) {
            this.hidden.delete(id);
        } else {
            this.hidden.add(id);
        }
        // 立即持久化：否则重启后停用状态丢失
        this.options.onVisibilityChange?.(this.hiddenIds());
        this.emit();
    }

    hiddenIds(): string[] {
        return [...this.hidden];
    }

    /** 从设置里恢复「已停用」的日历；不会触发持久化回调（避免回写循环） */
    restoreHidden(ids: string[]): void {
        this.hidden = new Set(ids);
        this.emit();
    }

    isLoading(id?: string): boolean {
        return id ? this.loading.has(id) : this.loading.size > 0;
    }

    errorOf(id: string): string | undefined {
        return this.errors.get(id);
    }

    lastLoadedAt(id: string): number | undefined {
        return this.cache.get(id)?.at;
    }

    /** 视图区间：以当前浏览日为中心，按设置的过去/未来天数扩展（月视图至少前后 1 个月） */
    windowFor(anchor: number, mode: "month" | "week" | "day" | "agenda"): { start: number; end: number } {
        const sync = this.options.settings().sync;
        const pad = 7 * 86_400_000;
        const span =
            mode === "month"
                ? 45 * 86_400_000
                : mode === "week"
                  ? 14 * 86_400_000
                  : 7 * 86_400_000;
        const past = Math.max(sync.pastDays * 86_400_000, span);
        const future = Math.max(sync.futureDays * 86_400_000, span);
        return { start: anchor - past - pad, end: anchor + future + pad };
    }

    /**
     * 查询事件。命中缓存（区间足够覆盖且未过期）时直接返回，
     * 否则触发对应适配器加载。
     */
    async eventsIn(start: number, end: number, options?: { force?: boolean }): Promise<CalendarEvent[]> {
        const targets = [...this.adapters.keys()].filter((id) => this.isVisible(id));
        const missing = targets.filter((id) => {
            const cached = this.cache.get(id);
            if (options?.force) {
                return true;
            }
            if (!cached) {
                return true;
            }
            if (Date.now() - cached.at > this.ttlFor(id)) {
                return true;
            }
            return cached.start > start || cached.end < end;
        });
        if (missing.length) {
            await Promise.all(missing.map((id) => this.loadCalendar(id, start, end)));
        }
        const result: CalendarEvent[] = [];
        for (const id of targets) {
            const cached = this.cache.get(id);
            if (!cached) {
                continue;
            }
            for (const event of cached.events) {
                // 全天事件按日历日比较，避免跨时区误差
                if (event.end >= start && event.start <= end) {
                    result.push(event);
                }
            }
        }
        return result.sort((a, b) => a.start - b.start || a.end - b.end);
    }

    async loadCalendar(id: string, start: number, end: number): Promise<CalendarLoadResult> {
        const adapter = this.adapters.get(id);
        if (!adapter) {
            return { calendarId: id, events: 0, error: "adapter missing" };
        }
        this.loading.add(id);
        this.errors.delete(id);
        this.emit();
        try {
            const events = await adapter.loadEvents(start, end);
            const prepared = events.map((event) => ({ ...event, readOnly: event.readOnly ?? !adapter.isWritable() }));
            this.cache.set(id, { start, end, events: prepared, at: Date.now() });
            const info = this.infos.get(id);
            if (info) {
                this.infos.set(id, {
                    ...info,
                    count: prepared.length,
                    fetchedAt: Date.now(),
                    error: undefined,
                    readOnly: !adapter.isWritable(),
                });
            }
            return { calendarId: id, events: prepared.length };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.errors.set(id, message);
            const info = this.infos.get(id);
            if (info) {
                this.infos.set(id, { ...info, error: message, fetchedAt: Date.now() });
            }
            return { calendarId: id, events: 0, error: message };
        } finally {
            this.loading.delete(id);
            this.emit();
        }
    }

    /** 清空缓存并重新加载所有可见日历 */
    async refreshAll(start: number, end: number): Promise<CalendarLoadResult[]> {
        const targets = [...this.adapters.keys()].filter((id) => this.isVisible(id));
        const results: CalendarLoadResult[] = [];
        const limit = Math.max(1, this.options.settings().advanced.concurrency);
        let index = 0;
        const worker = async (): Promise<void> => {
            while (index < targets.length) {
                const id = targets[index++];
                results.push(await this.loadCalendar(id, start, end));
            }
        };
        await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, worker));
        this.emit();
        return results;
    }

    invalidate(id?: string): void {
        if (id) {
            this.cache.delete(id);
        } else {
            this.cache.clear();
        }
        this.emit();
    }

    /**
     * 只失效「本地数据源」的缓存（属性视图 / SQL 查询），保留远端日历的缓存。
     *
     * 用途：思源的 transactions/setBlockAttrs 事件会被高频触发，而这些事件只能影响
     * 思源本地的数据；如果连远端 CalDAV 日历一起失效，就会变成每隔一两秒对所有日历
     * 重发一次 REPORT（实测日志里出现过这种风暴）。
     */
    invalidateLocal(): void {
        let changed = false;
        for (const id of [...this.cache.keys()]) {
            if (this.ttlFor(id) === this.localCacheTtl) {
                this.cache.delete(id);
                changed = true;
            }
        }
        if (changed) {
            this.emit();
        }
    }

    /** 由同步/外部写入事件后调用 */
    notifyExternalChange(): void {
        this.cache.clear();
        this.options.onEventsChanged?.();
        this.emit();
    }
}
