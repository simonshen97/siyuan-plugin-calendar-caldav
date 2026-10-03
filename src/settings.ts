import type {
    AvSyncConfig,
    CalDavAccount,
    CalendarSource,
    LocalAttrNames,
    PluginSettings,
    SyncOptions,
} from "./types";

export const SETTINGS_STORAGE = "settings.json";
export const MAPPING_STORAGE = "mappings.json";

/** 思源侧自定义属性名（写入时自动加 `custom-` 前缀） */
export const DEFAULT_ATTRS: LocalAttrNames = {
    uid: "caldav-uid",
    calendar: "caldav-calendar",
    etag: "caldav-etag",
    href: "caldav-href",
    lastSync: "caldav-synced",
    recurrenceId: "caldav-recurrence-id",
};

export const CALDAV_ATTR_PREFIX = "custom-";

export function defaultSyncOptions(): SyncOptions {
    return {
        direction: "both",
        pastDays: 90,
        futureDays: 180,
        targetNotebook: "",
        pathTemplate: "/日历/${yyyy}/${MM}",
        conflictPolicy: "duplicate",
        deleteLocalWhenRemoteDeleted: false,
        pushLocalChanges: false,
        intervalMinutes: 15,
        attrPrefix: CALDAV_ATTR_PREFIX,
    };
}

export function defaultSettings(): PluginSettings {
    return {
        version: 1,
        accounts: [],
        localSources: [],
        sync: defaultSyncOptions(),
        view: {
            defaultMode: "month",
            weekStart: 1,
            showLunar: true,
            showWeekNumber: true,
            hourCycle: 24,
            defaultDuration: 60,
            showTimeInMonth: true,
            density: "comfortable",
            defaultAlarm: undefined,
            allDayLane: true,
            highlightToday: true,
        },
        advanced: {
            requestTimeoutMs: 30_000,
            debug: false,
            debugMode: false,
            acceptInsecureTLS: false,
            concurrency: 4,
        },
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown, fallback: string): string {
    return typeof value === "string" ? value : fallback;
}

/** 把任意（可能被手改坏/旧版本）的设置对象规整为合法设置 */
export function normalizeSettings(raw: unknown): PluginSettings {
    const base = defaultSettings();
    if (!isObject(raw)) {
        return base;
    }
    const sync = isObject(raw.sync) ? raw.sync : {};
    const view = isObject(raw.view) ? raw.view : {};
    const advanced = isObject(raw.advanced) ? raw.advanced : {};

    const direction = str(sync.direction, base.sync.direction);
    const conflict = str(sync.conflictPolicy, base.sync.conflictPolicy);
    const weekStart = num(view.weekStart, base.view.weekStart);
    const mode = str(view.defaultMode, base.view.defaultMode);
    const density = str(view.density, base.view.density);

    return {
        version: 1,
        accounts: Array.isArray(raw.accounts) ? (raw.accounts as CalDavAccount[]).filter(isObject) : [],
        localSources: Array.isArray(raw.localSources) ? (raw.localSources as CalendarSource[]).filter(isObject) : [],
        sync: {
            direction: (["both", "pull", "push", "off"] as const).includes(direction as never)
                ? (direction as SyncOptions["direction"])
                : base.sync.direction,
            pastDays: Math.max(0, Math.min(3650, num(sync.pastDays, base.sync.pastDays))),
            futureDays: Math.max(0, Math.min(3650, num(sync.futureDays, base.sync.futureDays))),
            targetNotebook: str(sync.targetNotebook, base.sync.targetNotebook),
            pathTemplate: str(sync.pathTemplate, base.sync.pathTemplate) || base.sync.pathTemplate,
            conflictPolicy: (["remote", "local", "duplicate", "skip"] as const).includes(conflict as never)
                ? (conflict as SyncOptions["conflictPolicy"])
                : base.sync.conflictPolicy,
            deleteLocalWhenRemoteDeleted: bool(
                sync.deleteLocalWhenRemoteDeleted,
                base.sync.deleteLocalWhenRemoteDeleted,
            ),
            pushLocalChanges: bool(sync.pushLocalChanges, base.sync.pushLocalChanges),
            intervalMinutes: Math.max(0, Math.min(1440, num(sync.intervalMinutes, base.sync.intervalMinutes))),
            attrPrefix: str(sync.attrPrefix, base.sync.attrPrefix),
        },
        avSync: normalizeAvSync(raw.avSync),
        hiddenCalendars: Array.isArray(raw.hiddenCalendars)
            ? raw.hiddenCalendars.filter((item): item is string => typeof item === "string" && !!item)
            : [],
        view: {
            defaultMode: (["month", "week", "day", "agenda"] as const).includes(mode as never)
                ? (mode as PluginSettings["view"]["defaultMode"])
                : base.view.defaultMode,            weekStart: ([0, 1, 2, 3, 4, 5, 6] as const).includes(weekStart as never)
                ? (weekStart as PluginSettings["view"]["weekStart"])
                : base.view.weekStart,
            showLunar: bool(view.showLunar, base.view.showLunar),
            showWeekNumber: bool(view.showWeekNumber, base.view.showWeekNumber),
            hourCycle: num(view.hourCycle, 24) === 12 ? 12 : 24,
            defaultDuration: Math.max(5, Math.min(24 * 60, num(view.defaultDuration, base.view.defaultDuration))),
            showTimeInMonth: bool(view.showTimeInMonth, base.view.showTimeInMonth),
            density: density === "compact" ? "compact" : "comfortable",
            defaultAlarm: typeof view.defaultAlarm === "number" && Number.isFinite(view.defaultAlarm)
                ? view.defaultAlarm
                : undefined,
            allDayLane: bool(view.allDayLane, base.view.allDayLane),
            highlightToday: bool(view.highlightToday, base.view.highlightToday),
        },
        advanced: {
            requestTimeoutMs: Math.max(3_000, Math.min(300_000, num(advanced.requestTimeoutMs, base.advanced.requestTimeoutMs))),
            debug: bool(advanced.debug, base.advanced.debug),
            debugMode: bool(advanced.debugMode, base.advanced.debugMode),
            acceptInsecureTLS: bool(advanced.acceptInsecureTLS, base.advanced.acceptInsecureTLS),
            concurrency: Math.max(1, Math.min(16, num(advanced.concurrency, base.advanced.concurrency))),
        },
    };
}

/** 生成账户 ID */
export function newAccountId(): string {
    return `acct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 归一化「数据库块同步」配置。
 *
 * 只有填写了数据库块 ID 才认为配置存在（否则返回 undefined，表示未启用该功能）；
 * 日期列是必填项，缺失时视为未配置完成。
 */
export function normalizeAvSync(raw: unknown): AvSyncConfig | undefined {
    if (!isObject(raw)) {
        return undefined;
    }
    // 用户经常把块 ID 连同引号一起复制进来，这里统一清洗
    const clean = (value: unknown): string => str(value, "").trim().replace(/^["'`]+|["'`]+$/g, "");
    const avID = clean(raw.avID);
    if (!avID) {
        return undefined;
    }
    const direction = str(raw.direction, "pull");
    const optional = (value: unknown): string | undefined => {
        const text = clean(value);
        return text || undefined;
    };
    return {
        avID,
        blockID: optional(raw.blockID),
        viewID: optional(raw.viewID),
        enabled: bool(raw.enabled, true),
        dateKeyID: str(raw.dateKeyID, "").trim(),
        titleKeyID: optional(raw.titleKeyID),
        endKeyID: optional(raw.endKeyID),
        descriptionKeyID: optional(raw.descriptionKeyID),
        locationKeyID: optional(raw.locationKeyID),
        calendarKeyID: optional(raw.calendarKeyID),
        uidKeyID: optional(raw.uidKeyID),
        statusKeyID: optional(raw.statusKeyID),
        markerKeyID: optional(raw.markerKeyID),
        direction: direction === "both" ? "both" : "pull",
    };
}

/**
 * 设置读写：由 Plugin 实例注入 load/save，便于测试与复用。
 * `load`/`save` 直接对应 `plugin.loadData` / `plugin.saveData`。
 */
export class SettingsStore {
    private current: PluginSettings = defaultSettings();
    private loaded = false;
    private saving: Promise<void> | null = null;

    constructor(
        private readonly io: {
            load: (name: string) => Promise<unknown>;
            save: (name: string, data: unknown) => Promise<unknown>;
        },
    ) {}

    get value(): PluginSettings {
        return this.current;
    }

    async load(): Promise<PluginSettings> {
        const raw = await this.io.load(SETTINGS_STORAGE).catch(() => undefined);
        this.current = normalizeSettings(raw);
        this.loaded = true;
        return this.current;
    }

    /**
     * 合并式更新并落盘。
     * 注意：思源 saveData 的兑现不代表写入成功，因此这里对失败做兜底但不抛出。
     */
    async update(mutator: (settings: PluginSettings) => void): Promise<PluginSettings> {
        if (!this.loaded) {
            await this.load();
        }
        mutator(this.current);
        this.current = normalizeSettings(this.current);
        await this.flush();
        return this.current;
    }

    async flush(): Promise<void> {
        // 串行化写入，避免并发 saveData 互相覆盖
        const previous = this.saving ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(async () => {
                const result = await this.io.save(SETTINGS_STORAGE, this.current);
                if (isObject(result) && typeof result.code === "number" && result.code !== 0) {
                    throw new Error(`保存设置失败：${str(result.msg, "未知错误")}`);
                }
            });
        this.saving = next.catch(() => undefined) as Promise<void>;
        await next;
    }

    getAccount(id: string): CalDavAccount | undefined {
        return this.current.accounts.find((item) => item.id === id);
    }

    async upsertAccount(account: CalDavAccount): Promise<CalDavAccount> {
        await this.update((settings) => {
            const index = settings.accounts.findIndex((item) => item.id === account.id);
            if (index === -1) {
                settings.accounts.push(account);
            } else {
                settings.accounts[index] = account;
            }
        });
        return account;
    }

    async removeAccount(id: string): Promise<void> {
        await this.update((settings) => {
            settings.accounts = settings.accounts.filter((item) => item.id !== id);
        });
    }
}

/**
 * 属性名解析：支持使用自定义前缀（默认 `custom-`），
 * 返回带前缀的完整属性名，例如 `custom-caldav-uid`。
 */
export function attrName(prefix: string, name: string): string {
    return `${prefix}${name}`;
}

export function attrsFor(settings: PluginSettings): Record<keyof LocalAttrNames, string> {
    const prefix = settings.sync.attrPrefix || CALDAV_ATTR_PREFIX;
    return {
        uid: attrName(prefix, DEFAULT_ATTRS.uid),
        calendar: attrName(prefix, DEFAULT_ATTRS.calendar),
        etag: attrName(prefix, DEFAULT_ATTRS.etag),
        href: attrName(prefix, DEFAULT_ATTRS.href),
        lastSync: attrName(prefix, DEFAULT_ATTRS.lastSync),
        recurrenceId: attrName(prefix, DEFAULT_ATTRS.recurrenceId),
    };
}
