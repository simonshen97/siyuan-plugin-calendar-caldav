/**
 * 日期/时间工具：全部基于 IANA 时区 + 毫秒时间戳，避免引入重量级日期库。
 *
 * 约定：
 * - 所有时间点用 `number`（epoch 毫秒）表示；
 * - 全天事件用「日历日」表示，键为 `YYYY-MM-DD`（不属于任何时区），
 *   其毫秒时间戳由 `dateKeyToTs` 按本地时区 00:00 生成，仅用于排序与比较。
 * - 重叠计算使用半开区间 [start, end)。
 */

export const MS_MINUTE = 60_000;
export const MS_HOUR = 3_600_000;
export const MS_DAY = 86_400_000;

export function getLocalTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = locale + "|" + JSON.stringify(options);
    let formatter = dtfCache.get(key);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, options);
        dtfCache.set(key, formatter);
    }
    return formatter;
}

function partsInZone(ts: number, timeZone: string): Record<string, number> {
    const p = dtf("en-US", {
        timeZone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(new Date(ts));
    const out: Record<string, number> = {};
    for (const item of p) {
        if (item.type !== "literal") {
            out[item.type] = parseInt(item.value, 10);
        }
    }
    // Intl 在 hour12:false 下可能返回 24 表示午夜
    if (out.hour === 24) {
        out.hour = 0;
    }
    return out;
}

/** 时区偏移（毫秒），正数表示当地时间领先 UTC */
export function zoneOffset(ts: number, timeZone: string): number {
    const p = partsInZone(ts, timeZone);
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUTC - Math.floor(ts / 1000) * 1000;
}

/** 把「某时区下的年月日时分秒」转换为 UTC 毫秒时间戳（自动处理夏令时） */
export function zonedTimeToTs(
    year: number,
    month: number,
    day: number,
    hour = 0,
    minute = 0,
    second = 0,
    timeZone: string = getLocalTimeZone(),
): number {
    const guess = Date.UTC(year, month - 1, day, hour, minute, second);
    let ts = guess - zoneOffset(guess, timeZone);
    // 再迭代一次以吸收 DST 边界误差
    ts = guess - zoneOffset(ts, timeZone);
    return ts;
}

export interface ZoneParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    /** 0=周日 ... 6=周六 */
    weekday: number;
}

export function partsOf(ts: number, timeZone: string = getLocalTimeZone()): ZoneParts {
    const p = partsInZone(ts, timeZone);
    const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    return {
        year: p.year,
        month: p.month,
        day: p.day,
        hour: p.hour,
        minute: p.minute,
        second: p.second,
        weekday,
    };
}

/** 日历日键：YYYY-MM-DD（按给定时区） */
export function dateKey(ts: number, timeZone: string = getLocalTimeZone()): string {
    const p = partsOf(ts, timeZone);
    return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** 解析 YYYY-MM-DD 为 {year, month, day} */
export function parseDateKey(key: string): { year: number; month: number; day: number } {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
    if (!m) {
        const now = partsOf(Date.now());
        return { year: now.year, month: now.month, day: now.day };
    }
    return { year: parseInt(m[1], 10), month: parseInt(m[2], 10), day: parseInt(m[3], 10) };
}

/** 日历日键 -> 该时区当天 00:00 的时间戳 */
export function dateKeyToTs(key: string, timeZone: string = getLocalTimeZone()): number {
    const { year, month, day } = parseDateKey(key);
    return zonedTimeToTs(year, month, day, 0, 0, 0, timeZone);
}

export function startOfDay(ts: number, timeZone: string = getLocalTimeZone()): number {
    return dateKeyToTs(dateKey(ts, timeZone), timeZone);
}

export function endOfDay(ts: number, timeZone: string = getLocalTimeZone()): number {
    return startOfDay(ts, timeZone) + MS_DAY;
}

export function addDays(ts: number, days: number, timeZone: string = getLocalTimeZone()): number {
    const p = partsOf(ts, timeZone);
    // 通过「日历日 + N」再回到时间戳，避免 DST 造成的 23/25 小时偏移
    const base = Date.UTC(p.year, p.month - 1, p.day + days);
    const d = new Date(base);
    return zonedTimeToTs(
        d.getUTCFullYear(),
        d.getUTCMonth() + 1,
        d.getUTCDate(),
        p.hour,
        p.minute,
        p.second,
        timeZone,
    );
}

export function addMonths(ts: number, months: number, timeZone: string = getLocalTimeZone()): number {
    const p = partsOf(ts, timeZone);
    const base = new Date(Date.UTC(p.year, p.month - 1 + months, 1));
    const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
    return zonedTimeToTs(
        base.getUTCFullYear(),
        base.getUTCMonth() + 1,
        Math.min(p.day, lastDay),
        p.hour,
        p.minute,
        p.second,
        timeZone,
    );
}

/** 周起始日（0=周日） */
export function startOfWeek(ts: number, weekStart = 1, timeZone: string = getLocalTimeZone()): number {
    const p = partsOf(ts, timeZone);
    const diff = (p.weekday - weekStart + 7) % 7;
    return startOfDay(addDays(ts, -diff, timeZone), timeZone);
}

export function startOfMonth(ts: number, timeZone: string = getLocalTimeZone()): number {
    const p = partsOf(ts, timeZone);
    return zonedTimeToTs(p.year, p.month, 1, 0, 0, 0, timeZone);
}

export function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isSameDay(a: number, b: number, timeZone: string = getLocalTimeZone()): boolean {
    return dateKey(a, timeZone) === dateKey(b, timeZone);
}

export function minutesSinceMidnight(ts: number, timeZone: string = getLocalTimeZone()): number {
    const p = partsOf(ts, timeZone);
    return p.hour * 60 + p.minute + p.second / 60;
}

/** 时长（毫秒） -> 可读文本 */
export function humanDuration(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / MS_MINUTE));
    if (minutes < 60) {
        return `${minutes} 分钟`;
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) {
        return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
    }
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

/* —— 格式化 —— */

const WEEKDAY_NAMES_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEKDAY_NAMES_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function weekdayLabel(weekday: number, locale: string, short = true): string {
    const zh = locale.startsWith("zh");
    if (zh) {
        return short ? WEEKDAY_NAMES_ZH[weekday].slice(1) : WEEKDAY_NAMES_ZH[weekday];
    }
    if (short) {
        return WEEKDAY_NAMES_EN[weekday];
    }
    return dtf(locale, { weekday: "long" }).format(new Date());
}

export interface FormatOptions {
    locale?: string;
    timeZone?: string;
    hourCycle?: 24 | 12;
}

function timeOptions(opts: FormatOptions, withSeconds = false): Intl.DateTimeFormatOptions {
    return {
        timeZone: opts.timeZone || getLocalTimeZone(),
        hour: "2-digit",
        minute: "2-digit",
        ...(withSeconds ? { second: "2-digit" as const } : {}),
        hour12: opts.hourCycle === 12,
    };
}

export function formatTime(ts: number, opts: FormatOptions = {}): string {
    const locale = opts.locale || "zh-CN";
    return dtf(locale, timeOptions(opts)).format(new Date(ts));
}

export function formatDate(ts: number, opts: FormatOptions = {}): string {
    const locale = opts.locale || "zh-CN";
    const zh = locale.startsWith("zh");
    return dtf(locale, {
        timeZone: opts.timeZone || getLocalTimeZone(),
        year: "numeric",
        month: zh ? "long" : "short",
        day: "numeric",
    }).format(new Date(ts));
}

export function formatDateKey(key: string, opts: FormatOptions = {}): string {
    return formatDate(dateKeyToTs(key, opts.timeZone), opts);
}

export function formatDateTime(ts: number, opts: FormatOptions = {}): string {
    return `${formatDate(ts, opts)} ${formatTime(ts, opts)}`;
}

export function formatMonthTitle(ts: number, opts: FormatOptions = {}): string {
    const locale = opts.locale || "zh-CN";
    return dtf(locale, {
        timeZone: opts.timeZone || getLocalTimeZone(),
        year: "numeric",
        month: "long",
    }).format(new Date(ts));
}

export function formatWeekTitle(startTs: number, endTs: number, opts: FormatOptions = {}): string {
    const a = partsOf(startTs, opts.timeZone);
    const b = partsOf(endTs, opts.timeZone);
    if (a.year === b.year && a.month === b.month) {
        return `${a.year}年${a.month}月${a.day}日 – ${b.day}日`;
    }
    if (a.year === b.year) {
        return `${a.year}年${a.month}月${a.day}日 – ${b.month}月${b.day}日`;
    }
    return `${a.year}年${a.month}月${a.day}日 – ${b.year}年${b.month}月${b.day}日`;
}

/** ISO 周数（周一为一周开始） */
export function isoWeekNumber(ts: number, timeZone: string = getLocalTimeZone()): number {
    const p = partsOf(ts, timeZone);
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
    const dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
    return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * MS_DAY));
}

const lunarCache = new Map<string, Intl.DateTimeFormat>();

/** 农历（依赖平台 ICU 的 chinese 日历，失败时返回空串） */
export function formatLunar(ts: number, locale: string, timeZone: string): string {
    const key = locale + "|" + timeZone;
    let formatter = lunarCache.get(key);
    if (!formatter) {
        try {
            formatter = new Intl.DateTimeFormat(locale + "-u-ca-chinese", {
                timeZone,
                month: "numeric",
                day: "numeric",
            });
        } catch {
            return "";
        }
        lunarCache.set(key, formatter);
    }
    try {
        return formatter.format(new Date(ts)).replace(/\s+/g, "");
    } catch {
        return "";
    }
}

/* —— 区间与重叠 —— */

export interface TimeRange {
    start: number;
    end: number;
}

/** 判断两个半开区间是否相交 */
export function rangesIntersect(a: TimeRange, b: TimeRange): boolean {
    return a.start < b.end && b.start < a.end;
}

export function clampRange(range: TimeRange, min: TimeRange): TimeRange {
    return {
        start: Math.max(range.start, min.start),
        end: Math.min(range.end, min.end),
    };
}

/** 事件在时间轴上的布局信息 */
export interface LayoutItem {
    /** 列索引（0 起） */
    column: number;
    /** 该重叠簇的列数 */
    columns: number;
    start: number;
    end: number;
}

/**
 * 计算重叠事件的分列布局（用于周/日视图）。
 * 输入需按 start 升序，返回与输入等长的布局数组。
 */
export function layoutOverlaps<T extends TimeRange>(items: T[]): (LayoutItem & { item: T })[] {
    const sorted = items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => a.item.start - b.item.start || a.item.end - b.item.end);

    const result: (LayoutItem & { item: T })[] = [];
    let cluster: { item: T; column: number; end: number }[] = [];
    let columnEnds: number[] = [];
    let clusterEnd = -Infinity;

    const flush = () => {
        const columns = columnEnds.length || 1;
        for (const entry of cluster) {
            result.push({
                item: entry.item,
                column: entry.column,
                columns,
                start: entry.item.start,
                end: entry.item.end,
            });
        }
        cluster = [];
        columnEnds = [];
        clusterEnd = -Infinity;
    };

    for (const entry of sorted) {
        const { item } = entry;
        if (cluster.length && item.start >= clusterEnd) {
            flush();
        }
        let column = columnEnds.findIndex((end) => end <= item.start);
        if (column === -1) {
            column = columnEnds.length;
            columnEnds.push(item.end);
        } else {
            columnEnds[column] = item.end;
        }
        cluster.push({ item, column, end: item.end });
        clusterEnd = Math.max(clusterEnd, item.end);
    }
    flush();

    // 还原输入顺序
    const byIndex = new Map<T, LayoutItem>();
    for (const entry of result) {
        byIndex.set(entry.item, { column: entry.column, columns: entry.columns, start: entry.start, end: entry.end });
    }
    return items.map((item) => ({ item, ...(byIndex.get(item) as LayoutItem) }));
}

/** 生成日历日键序列（含起止） */
export function dateKeyRange(startTs: number, endTs: number, timeZone: string = getLocalTimeZone()): string[] {
    const keys: string[] = [];
    let cursor = startOfDay(startTs, timeZone);
    const limit = startOfDay(endTs, timeZone);
    let guard = 0;
    while (cursor <= limit && guard < 1000) {
        keys.push(dateKey(cursor, timeZone));
        cursor = addDays(cursor, 1, timeZone);
        guard++;
    }
    return keys;
}

export function nowTs(): number {
    return Date.now();
}
