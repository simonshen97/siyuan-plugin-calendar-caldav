import type { EventMapping, SyncReport } from "../types";

export interface MappingData {
    version: 2;
    /** key = `${calendarUrl}\u0000${uid}` */
    events: Record<string, EventMapping>;
    lastReport?: SyncReport;
}

export function emptyMappingData(): MappingData {
    return { version: 2, events: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 仅保留结构正确的映射，避免脏数据导致同步异常 */
export function normalizeMappingData(raw: unknown): MappingData {
    if (!isObject(raw) || !isObject(raw.events)) {
        return emptyMappingData();
    }
    const events: Record<string, EventMapping> = {};
    for (const [key, value] of Object.entries(raw.events)) {
        if (!isObject(value) || typeof value.uid !== "string" || typeof value.calendarUrl !== "string") {
            continue;
        }
        events[key] = {
            uid: value.uid,
            calendarUrl: value.calendarUrl,
            etag: typeof value.etag === "string" ? value.etag : undefined,
            href: typeof value.href === "string" ? value.href : undefined,
            scheduleTag: typeof value.scheduleTag === "string" ? value.scheduleTag : undefined,
            local: isObject(value.local)
                ? {
                      kind: value.local.kind === "avItem" ? "avItem" : "block",
                      blockID: typeof value.local.blockID === "string" ? value.local.blockID : undefined,
                      itemID: typeof value.local.itemID === "string" ? value.local.itemID : undefined,
                      avID: typeof value.local.avID === "string" ? value.local.avID : undefined,
                      dateKeyID: typeof value.local.dateKeyID === "string" ? value.local.dateKeyID : undefined,
                      writtenAt: typeof value.local.writtenAt === "number" ? value.local.writtenAt : undefined,
                  }
                : undefined,
            syncedAt: typeof value.syncedAt === "number" ? value.syncedAt : 0,
            start: typeof value.start === "number" ? value.start : undefined,
            lastDirection: typeof value.lastDirection === "string"
                ? (value.lastDirection as EventMapping["lastDirection"])
                : undefined,
            remoteHash: typeof value.remoteHash === "string" ? value.remoteHash : undefined,
            localHash: typeof value.localHash === "string" ? value.localHash : undefined,
        };
    }
    return {
        version: 2,
        events,
        lastReport: isObject(raw.lastReport) ? (raw.lastReport as unknown as SyncReport) : undefined,
    };
}

export function mappingKey(calendarUrl: string, uid: string): string {
    return `${calendarUrl}\u0000${uid}`;
}

/**
 * 同步映射表：记录远端事件与思源条目的一一对应关系。
 * 数据量较大（数千条），因此采用「整体载入 + 增量落盘（去抖）」策略。
 */
export class MappingStore {
    private data: MappingData = emptyMappingData();
    private dirty = false;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushing: Promise<void> = Promise.resolve();

    constructor(
        private readonly io: {
            load: (name: string) => Promise<unknown>;
            save: (name: string, data: unknown) => Promise<unknown>;
        },
        private readonly debounceMs = 1_500,
    ) {}

    async load(): Promise<MappingData> {
        const raw = await this.io.load(name()).catch(() => undefined);
        this.data = normalizeMappingData(raw);
        return this.data;
    }

    get size(): number {
        return Object.keys(this.data.events).length;
    }

    get lastReport(): SyncReport | undefined {
        return this.data.lastReport;
    }

    all(): EventMapping[] {
        return Object.values(this.data.events);
    }

    get(calendarUrl: string, uid: string): EventMapping | undefined {
        return this.data.events[mappingKey(calendarUrl, uid)];
    }

    findByLocal(local: { blockID?: string; itemID?: string }): EventMapping | undefined {
        if (!local.blockID && !local.itemID) {
            return undefined;
        }
        return this.all().find(
            (item) =>
                (local.blockID && item.local?.blockID === local.blockID) ||
                (local.itemID && item.local?.itemID === local.itemID),
        );
    }

    findByUid(uid: string): EventMapping[] {
        return this.all().filter((item) => item.uid === uid);
    }

    set(mapping: EventMapping): void {
        this.data.events[mappingKey(mapping.calendarUrl, mapping.uid)] = mapping;
        this.markDirty();
    }

    delete(calendarUrl: string, uid: string): void {
        const key = mappingKey(calendarUrl, uid);
        if (this.data.events[key]) {
            delete this.data.events[key];
            this.markDirty();
        }
    }

    deleteByCalendar(calendarUrl: string): void {
        let changed = false;
        for (const key of Object.keys(this.data.events)) {
            if (this.data.events[key].calendarUrl === calendarUrl) {
                delete this.data.events[key];
                changed = true;
            }
        }
        if (changed) {
            this.markDirty();
        }
    }

    setLastReport(report: SyncReport): void {
        this.data.lastReport = report;
        this.markDirty();
    }

    private markDirty(): void {
        this.dirty = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
        }, this.debounceMs);
    }

    /** 立即落盘（同步结束、插件卸载时调用） */
    async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (!this.dirty) {
            await this.flushing;
            return;
        }
        this.dirty = false;
        const snapshot: MappingData = { version: 2, events: { ...this.data.events }, lastReport: this.data.lastReport };
        const run = async () => {
            await this.io.save(name(), snapshot).catch(() => undefined);
        };
        this.flushing = this.flushing.then(run, run);
        await this.flushing;
    }
}

function name(): string {
    return "mappings.json";
}
