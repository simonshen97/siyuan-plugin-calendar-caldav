/**
 * iCalendar（ICS）解析与生成。
 *
 * 设计要点：
 * 1. 解析层直接使用官方 `ical.js`（jCal → Component/Property/Time），
 *    本模块只负责「CalendarEvent 统一模型 ↔ ICS」的双向映射；
 * 2. 所有时间点都是 epoch 毫秒；全天事件用「日历日」表达，
 *    由 `dateKeyToTs` 换算成本地（或指定时区）午夜，DTEND 为开区间；
 * 3. 重复规则展开使用 `ICAL.Event.iterator()`（内部即 `ICAL.RecurExpansion`），
 *    但**按事件所在时区的「墙上时间」展开**，再换算回毫秒，
 *    这样夏令时切换后本地时间仍然保持不变（RFC 5545 的 TZID 语义）；
 * 4. 重复展开永不修改入参对象，返回新的克隆对象。
 *
 * 注意：`types.ts` 不允许修改，本模块用本地扩展字段（`InternalEvent`）
 * 承载 ICS 中无法用 `CalendarEvent` 表达的信息（RDATE / RECURRENCE-ID 的绝对时间等），
 * 这些字段是普通可序列化属性，不影响其他模块。
 */

import ICAL from "ical.js";

import type {
    CalendarEvent,
    CalendarSourceKind,
    IAttendee,
    TEventClass,
    TEventStatus,
    TEventTransparency,
} from "../types";
import {
    MS_DAY,
    MS_MINUTE,
    addDays,
    dateKey,
    dateKeyToTs,
    getLocalTimeZone,
    partsOf,
    zoneOffset,
    zonedTimeToTs,
} from "../util/date";

/* —— 公开选项 —— */

export interface ParseIcsOptions {
    /** 事件归属的日历 ID（用于 CalendarEvent.calendar） */
    calendarId: string;
    /** 数据来源类型，默认 "caldav" */
    sourceKind?: CalendarSourceKind;
    /** 远端 href（写入 CalendarEvent.siyuan 之外，仅用于调试可忽略） */
    href?: string;
    /** 兜底时区（解析不到 TZID 且时间非 UTC 时使用），默认本机时区 */
    defaultTimeZone?: string;
}

export interface ExpandOptions {
    /** 窗口起点（毫秒，含） */
    windowStart: number;
    /** 窗口终点（毫秒，不含） */
    windowEnd: number;
    /** 单个重复事件最多展开的实例数，默认 750，防止无限重复规则卡死 */
    maxInstances?: number;
    /** 时区，默认本机 */
    timeZone?: string;
    /** 是否跳过 CANCELLED 事件，默认 true */
    skipCancelled?: boolean;
}

export interface BuildIcsOptions {
    /** 生成时的 PRODID，默认 "-//siyuan-plugin-calendar-caldav//NONSGML v1.0//EN" */
    prodid?: string;
    /** 是否输出 VTIMEZONE（当事件使用非 UTC 时区时） */
    includeTimezone?: boolean;
    /** 序列号（SEQUENCE），默认 0 */
    sequence?: number;
}

/* —— 本地扩展字段（不改动 types.ts） —— */

/**
 * `CalendarEvent` 无法表达的信息：
 * - `rdates`：RDATE 的绝对时间（毫秒）。`exdates` 语义上是「排除日期」，
 *   把 RDATE 混进去会导致本该出现（或被 RRULE 生成）的实例被误删，因此单独承载；
 * - `recurrenceIdTs`：RECURRENCE-ID 的绝对时间（毫秒），用于与展开出的实例对齐；
 * - `zoneOffsetMs`：TZID 无法用 IANA 名称解释时，解析时记录下来的固定偏移。
 */
interface IcsEventExtras {
    rdates?: number[];
    recurrenceIdTs?: number;
    zoneOffsetMs?: number;
    /** 来源是 VTODO（任务）而非 VEVENT：写回时必须生成 VTODO */
    isTodo?: boolean;
    /** VTODO 完成百分比（0-100） */
    percentComplete?: number;
    /** VTODO 完成时间（毫秒时间戳） */
    completedAt?: number;
}

type InternalEvent = CalendarEvent & IcsEventExtras;

/* —— 常量 —— */

const DEFAULT_PRODID = "-//siyuan-plugin-calendar-caldav//NONSGML v1.0//EN";
const DEFAULT_MAX_INSTANCES = 750;
/** 展开时允许跳过的「窗口之前」实例数上限，防止 1970 年起的每日重复拖慢展开 */
const MAX_SKIP_ITERATIONS = 20_000;
/** RFC 5545 单行 75 octets */
const FOLD_LIMIT = 75;
const WEEKDAY_ZH: Record<string, string> = {
    MO: "周一",
    TU: "周二",
    WE: "周三",
    TH: "周四",
    FR: "周五",
    SA: "周六",
    SU: "周日",
};
const WEEKDAY_BY_JS: string[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/* —— 基础工具 —— */

function pad2(value: number): string {
    return String(Math.abs(Math.trunc(value))).padStart(2, "0");
}

function pad4(value: number): string {
    return String(Math.trunc(value)).padStart(4, "0");
}

/** 转义为 iCalendar TEXT 值 */
function escapeIcsText(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * RFC 5545 TEXT 反转义。
 * `ICAL.parse` 产出的是 jCal，文本值在解析阶段已经完成反转义，
 * 因此常规路径不需要再调用；这里用于正则兜底等「原始 ICS 文本」场景。
 */
function unescapeText(value: string): string {
    let out = "";
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch !== "\\") {
            out += ch;
            continue;
        }
        const next = value[i + 1];
        if (next === undefined) {
            out += ch;
            break;
        }
        i++;
        if (next === "n" || next === "N") {
            out += "\n";
        } else if (next === "\\" || next === ";" || next === ",") {
            out += next;
        } else {
            out += next;
        }
    }
    return out;
}

/** 去掉 HTML 标签并还原常见实体（DESCRIPTION 常为 HTML） */
function stripHtml(input: string): string {
    const text = input
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&amp;/gi, "&");
    return text
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** FNV-1a（32 位）：非加密、稳定、无依赖 */
function fnv1a(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

/* —— 时区工具 —— */

const ianaZoneCache = new Map<string, boolean>();

/** 判断字符串是否为 Intl 认可的 IANA 时区名 */
/**
 * 文档里出现的「非 IANA」TZID → 固定偏移（毫秒）。
 *
 * 由 `registerTimezones` 在每次解析时填充（`parseIcs` 内），供 `icalTimeToTs` 使用。
 * 为什么需要：`Intl` 只认 IANA 名称，`TZ08`、`CST8`、`Xmail Custome Time` 这类服务端自定义
 * 时区若按本机时区解释会偏移数小时；用文档自带的 `TZOFFSETTO` 更准确。
 */
const customZoneOffsets = new Map<string, number>();

/** 按「墙上时间 + 固定偏移」换算成 epoch 毫秒 */
function wallTimeToTsWithOffset(time: ICAL.Time, offsetMs: number): number {
    return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second) - offsetMs;
}

function isIanaZone(tzid: string): boolean {    if (!tzid) {
        return false;
    }
    const cached = ianaZoneCache.get(tzid);
    if (cached !== undefined) {
        return cached;
    }
    let valid = false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tzid });
        valid = true;
    } catch {
        valid = false;
    }
    ianaZoneCache.set(tzid, valid);
    return valid;
}

/** 归一化时区名：UTC 系返回 "UTC"，其余原样返回 */
function normalizeZoneName(tzid: string | undefined): string {
    if (!tzid) {
        return "";
    }
    const trimmed = tzid.trim();
    if (/^(utc|gmt|z|etc\/utc|etc\/gmt)$/i.test(trimmed)) {
        return "UTC";
    }
    return trimmed;
}

function resolveFallbackZone(zone: string | undefined): string {
    if (zone && isIanaZone(zone)) {
        return zone;
    }
    return getLocalTimeZone();
}

const zoneNameFormatters = new Map<string, Intl.DateTimeFormat>();

/** 取某时区在某时刻的缩写（TZNAME），失败返回空串 */
function tznameAt(ts: number, zone: string): string {
    try {
        let formatter = zoneNameFormatters.get(zone);
        if (!formatter) {
            formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" });
            zoneNameFormatters.set(zone, formatter);
        }
        const found = formatter.formatToParts(new Date(ts)).find((part) => part.type === "timeZoneName");
        return found ? found.value.trim() : "";
    } catch {
        return "";
    }
}

/** 毫秒偏移 → ±HHMM */
function formatOffset(offsetMs: number): string {
    const totalMinutes = Math.round(offsetMs / MS_MINUTE);
    const sign = totalMinutes < 0 ? "-" : "+";
    const abs = Math.abs(totalMinutes);
    return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

/* —— ical.js 访问封装（库的类型较宽松，这里统一收敛为 unknown 再收窄） —— */

function safeFirstProperty(component: ICAL.Component, name: string): ICAL.Property | null {
    try {
        return component.getFirstProperty(name);
    } catch {
        return null;
    }
}

function safeProperties(component: ICAL.Component, name: string): ICAL.Property[] {
    try {
        return component.getAllProperties(name);
    } catch {
        return [];
    }
}

function safeSubcomponents(component: ICAL.Component, name: string): ICAL.Component[] {
    try {
        return component.getAllSubcomponents(name);
    } catch {
        return [];
    }
}

/** 列出全部子组件（不过滤名称） */
function safeAllSubcomponents(component: ICAL.Component): ICAL.Component[] {
    try {
        return component.getAllSubcomponents();
    } catch {
        return [];
    }
}

function safeValue(prop: ICAL.Property | null): unknown {
    if (!prop) {
        return undefined;
    }
    try {
        return prop.getFirstValue();
    } catch {
        return undefined;
    }
}

function safeValues(prop: ICAL.Property): unknown[] {
    try {
        return prop.getValues();
    } catch {
        return [];
    }
}

function paramString(prop: ICAL.Property | null, name: string): string {
    if (!prop) {
        return "";
    }
    try {
        const value: unknown = prop.getParameter(name);
        if (typeof value === "string") {
            return value.trim();
        }
        if (Array.isArray(value)) {
            const list: unknown[] = value;
            const first = list.find((item) => typeof item === "string");
            return typeof first === "string" ? first.trim() : "";
        }
        return "";
    } catch {
        return "";
    }
}

/** 组件上的 TEXT 属性（jCal 已反转义） */
function componentText(component: ICAL.Component, name: string): string {
    const value = safeValue(safeFirstProperty(component, name));
    return typeof value === "string" ? value.trim() : "";
}

function asTime(value: unknown): ICAL.Time | null {
    return value instanceof ICAL.Time ? value : null;
}

function asDuration(value: unknown): ICAL.Duration | null {
    return value instanceof ICAL.Duration ? value : null;
}

/* —— 时间换算 —— */

function utcTsOf(time: ICAL.Time): number {
    return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
}

function timeDateKey(time: ICAL.Time): string {
    return `${pad4(time.year)}-${pad2(time.month)}-${pad2(time.day)}`;
}

/**
 * 把 ICAL.Time 换算成 epoch 毫秒。
 *
 * - `Z` 结尾（zone = UTC）→ 直接按 UTC 解析；
 * - 带 TZID 且文档内/服务里能解析出 VTIMEZONE → 用 ical.js 的偏移；
 * - 带 TZID 但是 IANA 名称 → 用 Intl 换算（更准确，可覆盖历史规则）；
 * - 浮动时间 / 未知时区 → 用兜底时区。
 */
function icalTimeToTs(time: ICAL.Time, tzidParam: string, fallbackZone: string): number {
    const zoneId = time.zone && typeof time.zone.tzid === "string" ? time.zone.tzid : "";
    if (zoneId === "UTC" || zoneId === "Z") {
        return utcTsOf(time);
    }
    const tzid = tzidParam ? normalizeZoneName(tzidParam) : "";
    if (tzid === "UTC") {
        return utcTsOf(time);
    }
    if (tzid) {
        // VTIMEZONE 已随文档解析（ical.js 从组件树里取到并注水到 Time.zone）
        if (zoneId && zoneId !== "floating" && zoneId.toLowerCase() === tzidParam.trim().toLowerCase()) {
            try {
                return time.toJSDate().getTime();
            } catch {
                /* 落到下面的兜底逻辑 */
            }
        }
        if (isIanaZone(tzid)) {
            return zonedTimeToTs(time.year, time.month, time.day, time.hour, time.minute, time.second, tzid);
        }
        // 非 IANA 的 TZID（如 TZ08 / Xmail Custome Time）：优先用文档自带的固定偏移
        const offset = customZoneOffsets.get(tzidParam.trim()) ?? customZoneOffsets.get(tzid);
        if (offset !== undefined) {
            return wallTimeToTsWithOffset(time, offset);
        }
        return zonedTimeToTs(time.year, time.month, time.day, time.hour, time.minute, time.second, fallbackZone);
    }
    if (zoneId && zoneId !== "floating") {
        const zone = normalizeZoneName(zoneId);
        if (isIanaZone(zone)) {
            return zonedTimeToTs(time.year, time.month, time.day, time.hour, time.minute, time.second, zone);
        }
        const offset = customZoneOffsets.get(zoneId.trim());
        if (offset !== undefined) {
            return wallTimeToTsWithOffset(time, offset);
        }
        try {
            return time.toJSDate().getTime();
        } catch {
            return zonedTimeToTs(time.year, time.month, time.day, time.hour, time.minute, time.second, fallbackZone);
        }
    }
    // 浮动时间：按兜底时区解释
    return zonedTimeToTs(time.year, time.month, time.day, time.hour, time.minute, time.second, fallbackZone);
}

/** 全天事件：DATE 值 → 该时区当天 00:00 */
function allDayTs(time: ICAL.Time, zone: string): number {
    return dateKeyToTs(timeDateKey(time), zone);
}

/** 把 YYYY-MM-DD / YYYYMMDD / 日期时间（可带 Z）字符串换算成毫秒 */
function rawTimeToTs(raw: string, zone: string, fallbackZone: string): number | undefined {
    const value = raw.trim();
    if (!value) {
        return undefined;
    }
    const dateOnly = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value);
    if (dateOnly) {
        return dateKeyToTs(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, fallbackZone);
    }
    const dateTime = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})(Z)?$/i.exec(value);
    if (dateTime) {
        const year = parseInt(dateTime[1], 10);
        const month = parseInt(dateTime[2], 10);
        const day = parseInt(dateTime[3], 10);
        const hour = parseInt(dateTime[4], 10);
        const minute = parseInt(dateTime[5], 10);
        const second = parseInt(dateTime[6], 10);
        if (dateTime[7]) {
            return Date.UTC(year, month - 1, day, hour, minute, second);
        }
        if (isIanaZone(zone)) {
            return zonedTimeToTs(year, month, day, hour, minute, second, zone);
        }
        const offset = customZoneOffsets.get(zone.trim());
        if (offset !== undefined) {
            return Date.UTC(year, month - 1, day, hour, minute, second) - offset;
        }
        return zonedTimeToTs(year, month, day, hour, minute, second, fallbackZone);
    }
    return undefined;
}

/* —— 生成格式 —— */

function formatUtcCompact(ts: number): string {
    const date = new Date(ts);
    return `${pad4(date.getUTCFullYear())}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T${pad2(
        date.getUTCHours(),
    )}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
}

function formatCompactDateTime(ts: number, zone: string): string {
    if (zone === "UTC") {
        return formatUtcCompact(ts);
    }
    const parts = partsOf(ts, zone);
    return `${pad4(parts.year)}${pad2(parts.month)}${pad2(parts.day)}T${pad2(parts.hour)}${pad2(parts.minute)}${pad2(
        parts.second,
    )}`;
}

function formatCompactDate(ts: number, zone: string): string {
    return dateKey(ts, zone).replace(/-/g, "");
}

/**
 * 提醒偏移（**毫秒**，负数表示事件开始前）→ RFC 5545 DURATION。
 * 约定：`CalendarEvent.alarms[].trigger` 一律为毫秒偏移，与 CalendarEvent 的其他时间字段一致。
 */
function formatTrigger(triggerMs: number): string {
    let rest = Math.round(Math.abs(triggerMs) / MS_MINUTE);
    const rounded = rest;
    if (!rounded) {
        return "PT0S";
    }
    const sign = triggerMs < 0 ? "-" : "";
    const days = Math.floor(rest / 1440);
    rest -= days * 1440;
    const hours = Math.floor(rest / 60);
    rest -= hours * 60;
    let out = `${sign}P`;
    if (days) {
        out += `${days}D`;
    }
    if (hours || rest || !days) {
        out += "T";
        if (hours) {
            out += `${hours}H`;
        }
        if (rest) {
            out += `${rest}M`;
        }
        if (!hours && !rest) {
            out += "0S";
        }
    }
    return out;
}

/**
 * RFC 5545 折行：单行最长 75 octets，续行以空格开头。
 * 逐「码点」累积 UTF-8 字节数，保证不会把多字节字符切断。
 */
function foldLine(line: string): string {
    const encoder = new TextEncoder();
    const chunks: string[] = [];
    let current = "";
    let bytes = 0;
    // 首行 75 octets；续行前导空格占 1 octet，因此内容最多 74 octets
    let limit = FOLD_LIMIT;
    for (const char of line) {
        const size = encoder.encode(char).length;
        if (bytes + size > limit) {
            chunks.push(current);
            current = "";
            bytes = 0;
            limit = FOLD_LIMIT - 1;
        }
        current += char;
        bytes += size;
    }
    chunks.push(current);
    return chunks.join("\r\n ");
}

/* —— 解析 —— */

/**
 * 归一化 ICS 文本后交给 ical.js。
 *
 * 各服务端常见的「格式不统一」都在这里抹平：
 * - 以 UTF-8 BOM 开头（部分服务端）；
 * - 用 `\n` 或 `\r` 做换行（RFC 5545 要求 CRLF，但并非人人遵守）；
 * - 行尾带多余空白；
 * - 返回的是「裸 VEVENT / VTODO」而没有 VCALENDAR 外壳；
 * - 首尾有解释性噪声（少数服务端会在 ICS 前后附带文本）。
 */
function normalizeIcsText(ics: string): string {
    let text = ics.replace(/^\uFEFF/, "");
    // 去掉 ICS 之外的包裹（例如被 HTML/JSON 包了一层，或服务端附加了说明文本）
    const calendarBegin = text.search(/BEGIN:VCALENDAR/i);
    if (calendarBegin >= 0) {
        const calendarEnd = text.search(/END:VCALENDAR/i);
        text = calendarEnd > calendarBegin ? text.slice(calendarBegin, calendarEnd + "END:VCALENDAR".length) : text.slice(calendarBegin);
    } else {
        const componentBegin = text.search(/BEGIN:(VEVENT|VTODO|VJOURNAL)/i);
        if (componentBegin > 0) {
            text = text.slice(componentBegin);
        }
    }
    text = text.replace(/\r\n|\r|\n/g, "\r\n");
    text = text.replace(/[ \t]+\r\n/g, "\r\n");
    if (!/BEGIN:VCALENDAR/i.test(text) && /BEGIN:(VEVENT|VTODO|VJOURNAL)/i.test(text)) {
        // 补齐外壳，让 ical.js 能解析裸组件
        text = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//siyuan-plugin-calendar-caldav//wrapped//EN\r\n${text.trimEnd()}\r\nEND:VCALENDAR\r\n`;
    }
    return text;
}

/** 解析出根组件（兼容多 VCALENDAR / 裸 VEVENT） */
function parseRoots(ics: string): ICAL.Component[] {
    const jcal: unknown = ICAL.parse(normalizeIcsText(ics));
    const roots: ICAL.Component[] = [];
    if (Array.isArray(jcal) && typeof jcal[0] === "string") {
        roots.push(new ICAL.Component(jcal));
        return roots;
    }
    if (Array.isArray(jcal)) {
        for (const item of jcal) {
            if (Array.isArray(item) && typeof item[0] === "string") {
                roots.push(new ICAL.Component(item));
            }
        }
    }
    return roots;
}

/** 注册文档里所有 VTIMEZONE（重复注册在部分版本会抛错，忽略），并返回非 IANA 时区的固定偏移 */
function registerTimezones(root: ICAL.Component): Map<string, number> {
    const offsets = new Map<string, number>();
    const record = (component: ICAL.Component): void => {
        const tzid = component.getFirstPropertyValue("tzid");
        const name = typeof tzid === "string" ? tzid.trim() : "";
        if (!name || isIanaZone(name)) {
            return;
        }
        const offset = readZoneOffsetMs(component);
        if (offset !== undefined && !offsets.has(name)) {
            offsets.set(name, offset);
        }
    };
    const walk = (component: ICAL.Component, depth: number): void => {
        if (depth > 4) {
            return;
        }
        for (const child of safeSubcomponents(component, "vtimezone")) {
            try {
                ICAL.TimezoneService.register(child);
            } catch {
                /* 已注册或非法定义：忽略 */
            }
            record(child);
        }
        for (const sub of component.getAllSubcomponents()) {
            walk(sub, depth + 1);
        }
    };
    const name = typeof root.name === "string" ? root.name.toLowerCase() : "";
    if (name === "vtimezone") {
        try {
            ICAL.TimezoneService.register(root);
        } catch {
            /* 忽略 */
        }
        record(root);
        return offsets;
    }
    walk(root, 0);
    return offsets;
}

/**
 * 从 VTIMEZONE 里取固定偏移（毫秒）。
 *
 * 用途：`TZID=TZ08`、`TZID=Xmail Custome Time` 这类**非 IANA** 时区名在 `Intl` 里查不到，
 * 若直接按本机时区解释会偏移数小时。这里退回解析文档自带的 `TZOFFSETTO`
 * （如 `+0800`），比假设本机时区准确得多。
 */
function readZoneOffsetMs(component: ICAL.Component): number | undefined {
    for (const sub of safeAllSubcomponents(component)) {
        const subName = typeof sub.name === "string" ? sub.name.toLowerCase() : "";
        if (subName !== "standard" && subName !== "daylight") {
            continue;
        }
        const raw = sub.getFirstPropertyValue("tzoffsetto");
        const offset = parseUtcOffset(typeof raw === "string" ? raw : undefined);
        if (offset !== undefined) {
            return offset;
        }
    }
    return undefined;
}

/** `+0800` / `-0530` / `+08:00` / `+08` → 毫秒 */
function parseUtcOffset(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }
    const match = /^([+-])(\d{2}):?(\d{2})?/.exec(value.trim());
    if (!match) {
        return undefined;
    }
    const sign = match[1] === "-" ? -1 : 1;
    const hours = parseInt(match[2], 10);
    const minutes = match[3] ? parseInt(match[3], 10) : 0;
    return sign * (hours * 60 + minutes) * MS_MINUTE;
}

function collectVevents(root: ICAL.Component): ICAL.Component[] {
    const name = typeof root.name === "string" ? root.name.toLowerCase() : "";
    if (name === "vevent" || name === "vtodo") {
        return [root];
    }
    // VTODO 必须一起收集：任务型服务端（例如 Vikunja）只提供 VTODO，
    // 只找 VEVENT 就会表现为「日历能列出、里面永远没有条目」。
    return [...safeSubcomponents(root, "vevent"), ...safeSubcomponents(root, "vtodo")];
}

function readCategories(component: ICAL.Component): string[] | undefined {
    const out: string[] = [];
    for (const prop of safeProperties(component, "categories")) {
        // CATEGORIES 在 jCal 里是 multiValue，ical.js 已按「未转义逗号」切分并反转义
        for (const value of safeValues(prop)) {
            if (typeof value !== "string") {
                continue;
            }
            const text = value.trim();
            if (text) {
                out.push(text);
            }
        }
    }
    return out.length ? out : undefined;
}

function stripMailto(uri: string): string {
    return uri.replace(/^mailto:/i, "").trim();
}

function normalizePartstat(value: string): IAttendee["partstat"] | undefined {
    const upper = value.trim().toUpperCase();
    switch (upper) {
        case "NEEDS-ACTION":
        case "ACCEPTED":
        case "DECLINED":
        case "TENTATIVE":
        case "DELEGATED":
            return upper;
        default:
            return undefined;
    }
}

function readAttendee(prop: ICAL.Property): IAttendee {
    const value = safeValues(prop).find((item) => typeof item === "string");
    const uri = typeof value === "string" ? value.trim() : "";
    const attendee: IAttendee = {};
    const cn = paramString(prop, "cn");
    const mailto = stripMailto(uri);
    const partstat = normalizePartstat(paramString(prop, "partstat"));
    const role = paramString(prop, "role");
    if (cn) {
        attendee.cn = cn;
    }
    if (mailto) {
        attendee.mailto = mailto;
    }
    if (partstat) {
        attendee.partstat = partstat;
    }
    if (role) {
        attendee.role = role;
    }
    return attendee;
}

function hasAttendeeField(attendee: IAttendee): boolean {
    return Boolean(attendee.cn || attendee.mailto || attendee.partstat || attendee.role);
}

function readAlarms(component: ICAL.Component, startTs: number, endTs: number): CalendarEvent["alarms"] {
    const out: { trigger: number; action?: string; description?: string }[] = [];
    for (const alarm of safeSubcomponents(component, "valarm")) {
        const triggerProp = safeFirstProperty(alarm, "trigger");
        const value = safeValue(triggerProp);
        let trigger: number | undefined;
        const duration = asDuration(value);
        const time = asTime(value);
        if (duration) {
            // 统一约定：alarms[].trigger 是相对事件起止的毫秒偏移
            trigger = duration.toSeconds() * 1000;
        } else if (time) {
            const isEnd = paramString(triggerProp, "related").toUpperCase() === "END";
            const ts = icalTimeToTs(time, paramString(triggerProp, "tzid"), getLocalTimeZone());
            trigger = ts - (isEnd ? endTs : startTs);
        }
        if (trigger === undefined || !Number.isFinite(trigger)) {
            continue;
        }
        const action = componentText(alarm, "action");
        const description = componentText(alarm, "description");
        const item: { trigger: number; action?: string; description?: string } = { trigger };
        if (action) {
            item.action = action.toUpperCase();
        }
        if (description) {
            item.description = description;
        }
        out.push(item);
    }
    return out.length ? out : undefined;
}

function readStatus(value: string): TEventStatus | undefined {
    switch (value.trim().toUpperCase()) {
        case "CONFIRMED":
        // VTODO 的进行中/已完成也映射到同一枚举，避免任务被当成「无状态」
        case "IN-PROCESS":
        case "COMPLETED":
            return "CONFIRMED";
        case "TENTATIVE":
        case "NEEDS-ACTION":
            return "TENTATIVE";
        case "CANCELLED":
            return "CANCELLED";
        default:
            return undefined;
    }
}

function readTransparency(value: string): TEventTransparency | undefined {
    switch (value.trim().toUpperCase()) {
        case "OPAQUE":
            return "OPAQUE";
        case "TRANSPARENT":
            return "TRANSPARENT";
        default:
            return undefined;
    }
}

function readClass(value: string): TEventClass | undefined {
    switch (value.trim().toUpperCase()) {
        case "PUBLIC":
            return "PUBLIC";
        case "PRIVATE":
            return "PRIVATE";
        case "CONFIDENTIAL":
            return "CONFIDENTIAL";
        default:
            return undefined;
    }
}

/** EXDATE / RDATE → 毫秒数组 */
function readDateList(component: ICAL.Component, name: string, fallbackZone: string, tzidFallback: string): number[] {
    const out: number[] = [];
    for (const prop of safeProperties(component, name)) {
        const tzid = paramString(prop, "tzid") || tzidFallback;
        for (const value of safeValues(prop)) {
            const time = asTime(value);
            if (time) {
                out.push(time.isDate ? allDayTs(time, fallbackZone) : icalTimeToTs(time, tzid, fallbackZone));
                continue;
            }
            // RDATE 允许 PERIOD 值：取起点
            const period = value as { start?: unknown } | null;
            const periodStart = period && typeof period === "object" ? asTime(period.start) : null;
            if (periodStart) {
                out.push(icalTimeToTs(periodStart, tzid, fallbackZone));
            }
        }
    }
    return out;
}

interface ParsedStart {
    start: number;
    end: number;
    allDay: boolean;
    hasEndDate: boolean;
    tzid?: string;
    zoneOffsetMs?: number;
}

/** DTSTART/DTEND/DURATION → 毫秒区间；VTODO 允许用 DUE 取代 DTSTART/DTEND */
function readTimeRange(component: ICAL.Component, fallbackZone: string): ParsedStart | null {
    const dtstartProp = safeFirstProperty(component, "dtstart");
    const dtstart = asTime(safeValue(dtstartProp));
    if (!dtstart) {
        // VTODO：只有 DUE（无 DTSTART）时把 DUE 当作起止点，任务至少能在到期日显示
        const dueProp = safeFirstProperty(component, "due");
        const due = asTime(safeValue(dueProp));
        if (!due) {
            return null;
        }
        if (due.isDate) {
            const start = allDayTs(due, fallbackZone);
            return { start, end: addDays(start, 1, fallbackZone), allDay: true, hasEndDate: false };
        }
        const dueTzid = paramString(dueProp, "tzid");
        const start = icalTimeToTs(due, dueTzid, fallbackZone);
        const dueResult: ParsedStart = { start, end: start, allDay: false, hasEndDate: false };
        const dueZone = normalizeZoneName(dueTzid);
        if (dueZone && dueZone !== "UTC") {
            dueResult.tzid = dueZone;
        }
        return dueResult;
    }
    const allDay = dtstart.isDate === true;
    const dtendProp = safeFirstProperty(component, "dtend");
    const dtend = asTime(safeValue(dtendProp));
    const duration = asDuration(safeValue(safeFirstProperty(component, "duration")));

    if (allDay) {
        const start = allDayTs(dtstart, fallbackZone);
        let end: number;
        let hasEndDate = false;
        if (dtend) {
            if (dtend.isDate) {
                end = allDayTs(dtend, fallbackZone);
            } else {
                end = icalTimeToTs(dtend, paramString(dtendProp, "tzid"), fallbackZone);
            }
            hasEndDate = true;
        } else if (duration) {
            end = start + duration.toSeconds() * 1000;
        } else {
            end = addDays(start, 1, fallbackZone);
        }
        if (!Number.isFinite(end) || end <= start) {
            end = addDays(start, 1, fallbackZone);
        } else {
            // 全天事件的结束必须是某天的 00:00
            end = dateKeyToTs(dateKey(end, fallbackZone), fallbackZone);
            if (end <= start) {
                end = addDays(start, 1, fallbackZone);
            }
        }
        return { start, end, allDay: true, hasEndDate };
    }

    const tzidParam = paramString(dtstartProp, "tzid");
    const tzid = normalizeZoneName(tzidParam);
    const start = icalTimeToTs(dtstart, tzidParam, fallbackZone);
    let end: number;
    if (dtend && !dtend.isDate) {
        end = icalTimeToTs(dtend, paramString(dtendProp, "tzid") || tzidParam, fallbackZone);
    } else if (dtend && dtend.isDate) {
        // 非法组合（DATE-TIME 起点 + DATE 终点）：按天数补齐
        end = allDayTs(dtend, fallbackZone);
    } else if (duration) {
        end = start + duration.toSeconds() * 1000;
    } else {
        // 0 长度事件（点事件）
        end = start;
    }
    if (!Number.isFinite(end)) {
        end = start;
    }
    const result: ParsedStart = { start, end, allDay: false, hasEndDate: false };
    if (tzid && tzid !== "UTC") {
        result.tzid = tzid;
    }
    // 非 IANA 的 TZID：记录解析时的固定偏移，展开时用于墙上时间 → 毫秒
    if (tzid && tzid !== "UTC" && !isIanaZone(tzid)) {
        result.zoneOffsetMs = start - utcTsOf(dtstart);
    }
    return result;
}

function normalizeRrule(value: string): string {
    const trimmed = value.trim().replace(/\r?\n/g, "");
    const colon = trimmed.indexOf(":");
    if (colon > 0 && /^rrule(\s*;.*)?$/i.test(trimmed.slice(0, colon))) {
        return trimmed.slice(colon + 1);
    }
    return trimmed;
}

function parseEventComponent(
    component: ICAL.Component,
    fallbackZone: string,
    options: ParseIcsOptions,
    index: number,
): InternalEvent | null {
    const range = readTimeRange(component, fallbackZone);
    if (!range) {
        // 没有 DTSTART/DUE 的组件无法定位，丢弃
        return null;
    }

    const componentName = typeof component.name === "string" ? component.name.toLowerCase() : "vevent";
    const isTodo = componentName === "vtodo";

    const uidText = componentText(component, "uid");
    const title = componentText(component, "summary");
    const uid = uidText || `no-uid-${fnv1a(`${title}|${range.start}|${index}`)}`;

    const event: InternalEvent = {
        uid,
        calendar: options.calendarId,
        sourceKind: options.sourceKind ?? "caldav",
        title,
        start: range.start,
        end: range.end,
        allDay: range.allDay,
    };
    if (isTodo) {
        // 任务型服务端（Vikunja 等）只提供 VTODO；标记出来以便视图区分、写回时仍生成 VTODO
        event.isTodo = true;
        const percent = componentText(component, "percent-complete");
        if (percent && /^\d+$/.test(percent.trim())) {
            event.percentComplete = Math.max(0, Math.min(100, parseInt(percent.trim(), 10)));
        }
        const completed = asTime(safeValue(safeFirstProperty(component, "completed")));
        if (completed) {
            event.completedAt = utcTsOf(completed);
        }
    }

    if (range.allDay) {
        event.hasEndDate = range.hasEndDate;
    }
    if (range.tzid) {
        event.tzid = range.tzid;
    }
    if (range.zoneOffsetMs !== undefined) {
        event.zoneOffsetMs = range.zoneOffsetMs;
    }

    const description = componentText(component, "description");
    if (description) {
        const plain = stripHtml(description);
        if (plain) {
            event.description = plain;
        }
    }
    const location = componentText(component, "location");
    if (location) {
        event.location = location;
    }
    const categories = readCategories(component);
    if (categories) {
        event.categories = categories;
    }
    const status = readStatus(componentText(component, "status"));
    if (status) {
        event.status = status;
    }
    const transparency = readTransparency(componentText(component, "transp"));
    if (transparency) {
        event.transparency = transparency;
    }
    const cls = readClass(componentText(component, "class"));
    if (cls) {
        event.cls = cls;
    }
    const url = componentText(component, "url");
    if (url) {
        event.url = url;
    }

    const rruleProp = safeFirstProperty(component, "rrule");
    if (rruleProp) {
        let raw = "";
        try {
            raw = rruleProp.toICALString();
        } catch {
            raw = "";
        }
        const body = raw ? normalizeRrule(raw) : "";
        if (body) {
            event.rrule = body;
        }
    }

    const lastModifiedProp = safeFirstProperty(component, "last-modified");
    const dtstampProp = safeFirstProperty(component, "dtstamp");
    const modified = asTime(safeValue(lastModifiedProp)) ?? asTime(safeValue(dtstampProp));
    if (modified) {
        event.lastModified = icalTimeToTs(modified, paramString(lastModifiedProp, "tzid"), fallbackZone);
    }
    const created = asTime(safeValue(safeFirstProperty(component, "created")));
    if (created) {
        event.created = icalTimeToTs(created, "", fallbackZone);
    }

    const exdates = readDateList(component, "exdate", fallbackZone, event.tzid ?? "");
    if (exdates.length) {
        event.exdates = exdates;
    }
    const rdates = readDateList(component, "rdate", fallbackZone, event.tzid ?? "");
    if (rdates.length) {
        event.rdates = rdates;
    }

    const attendeeProps = safeProperties(component, "attendee");
    const attendees = attendeeProps.map(readAttendee).filter(hasAttendeeField);
    if (attendees.length) {
        event.attendees = attendees;
    }
    const organizerProp = safeFirstProperty(component, "organizer");
    if (organizerProp) {
        const organizer = readAttendee(organizerProp);
        if (hasAttendeeField(organizer)) {
            event.organizer = organizer;
        }
    }

    const alarms = readAlarms(component, range.start, range.end);
    if (alarms) {
        event.alarms = alarms;
    }

    const recurrenceProp = safeFirstProperty(component, "recurrence-id");
    const recurrenceTime = asTime(safeValue(recurrenceProp));
    if (recurrenceTime) {
        event.recurrenceId = recurrenceTime.toString();
        const ridTzid = paramString(recurrenceProp, "tzid") || (range.allDay ? "" : event.tzid ?? "");
        event.recurrenceIdTs = recurrenceTime.isDate
            ? allDayTs(recurrenceTime, fallbackZone)
            : icalTimeToTs(recurrenceTime, ridTzid, fallbackZone);
    }

    return event;
}

/**
 * 解析一个 ICS 文本，返回其主事件（未展开重复），不抛异常：非法输入返回 []。
 * 覆盖实例（同一 UID + RECURRENCE-ID）也会被返回，由 `expandEvents` 负责合并。
 */
export function parseIcs(ics: string, options: ParseIcsOptions): CalendarEvent[] {
    if (typeof ics !== "string" || !looksLikeIcs(ics)) {
        return [];
    }
    try {
        customZoneOffsets.clear();
        const roots = parseRoots(ics);
        if (!roots.length) {
            return [];
        }
        for (const root of roots) {
            const offsets = registerTimezones(root);
            for (const [zone, offset] of offsets) {
                customZoneOffsets.set(zone, offset);
            }
        }
        const fallbackZone = resolveFallbackZone(options && options.defaultTimeZone);
        const out: CalendarEvent[] = [];
        let index = 0;
        for (const root of roots) {
            for (const component of collectVevents(root)) {
                try {
                    const event = parseEventComponent(component, fallbackZone, options, index);
                    if (event) {
                        out.push(event);
                    }
                } catch {
                    /* 单个事件异常不影响其他事件 */
                }
                index++;
            }
        }
        return out;
    } catch {
        return [];
    }
}

/* —— 重复展开 —— */

interface ExpandContext {
    windowStart: number;
    windowEnd: number;
    maxInstances: number;
    fallbackZone: string;
    skipCancelled: boolean;
}

/** 事件在展开时使用的时区：全天事件用调用方时区，定时事件优先用自己的 TZID */
function eventZone(event: CalendarEvent, fallbackZone: string): string {
    if (event.allDay) {
        return fallbackZone;
    }
    const tzid = normalizeZoneName(event.tzid);
    if (tzid === "UTC") {
        return "UTC";
    }
    if (tzid && isIanaZone(tzid)) {
        return tzid;
    }
    return fallbackZone;
}

interface WallParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

/**
 * 取「事件坐标系的墙上时间分量」。
 * IANA 时区走 Intl；无法用 IANA 名称解释的 TZID（自定义 VTIMEZONE）
 * 使用解析时记录的固定偏移。重复展开始终在墙上时间上进行，
 * 这样夏令时切换后事件的本地时间保持不变（RFC 5545 的 TZID 语义）。
 */
function wallPartsOf(ts: number, zone: string, fixedOffsetMs?: number): WallParts {
    if (fixedOffsetMs !== undefined) {
        const shifted = new Date(ts + fixedOffsetMs);
        return {
            year: shifted.getUTCFullYear(),
            month: shifted.getUTCMonth() + 1,
            day: shifted.getUTCDate(),
            hour: shifted.getUTCHours(),
            minute: shifted.getUTCMinutes(),
            second: shifted.getUTCSeconds(),
        };
    }
    const parts = partsOf(ts, zone);
    return {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour,
        minute: parts.minute,
        second: parts.second,
    };
}

/** 墙上时间 → 毫秒（支持固定偏移的非 IANA 时区） */
function wallToTs(parts: WallParts, zone: string, fixedOffsetMs?: number): number {
    if (fixedOffsetMs !== undefined) {
        return (
            Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - fixedOffsetMs
        );
    }
    return zonedTimeToTs(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, zone);
}

function compactFromWall(parts: WallParts): string {
    return `${pad4(parts.year)}${pad2(parts.month)}${pad2(parts.day)}T${pad2(parts.hour)}${pad2(parts.minute)}${pad2(
        parts.second,
    )}`;
}

function occurrenceStart(time: ICAL.Time, zone: string, allDay: boolean, fixedOffsetMs?: number): number {
    if (allDay || time.isDate) {
        return dateKeyToTs(timeDateKey(time), zone);
    }
    return wallToTs(
        {
            year: time.year,
            month: time.month,
            day: time.day,
            hour: time.hour,
            minute: time.minute,
            second: time.second,
        },
        zone,
        fixedOffsetMs,
    );
}

function intersectsRange(start: number, end: number, windowStart: number, windowEnd: number): boolean {
    if (!Number.isFinite(start)) {
        return false;
    }
    const from = start;
    const to = Number.isFinite(end) && end > start ? end : start + 1; // 0 长度事件占 1ms
    return from < windowEnd && to > windowStart;
}

function intersectsWindow(event: CalendarEvent, windowStart: number, windowEnd: number): boolean {
    return intersectsRange(Number(event.start), Number(event.end), windowStart, windowEnd);
}

/** 深一层克隆：数组/嵌套对象都复制，避免调用方修改入参对象 */
function cloneEvent(event: InternalEvent): InternalEvent {
    const clone: InternalEvent = { ...event };
    if (Array.isArray(event.categories)) {
        clone.categories = [...event.categories];
    }
    if (Array.isArray(event.exdates)) {
        clone.exdates = [...event.exdates];
    }
    if (Array.isArray(event.attendees)) {
        clone.attendees = event.attendees.map((item) => ({ ...item }));
    }
    if (event.organizer) {
        clone.organizer = { ...event.organizer };
    }
    if (Array.isArray(event.alarms)) {
        clone.alarms = event.alarms.map((item) => ({ ...item }));
    }
    if (Array.isArray(event.rdates)) {
        clone.rdates = [...event.rdates];
    }
    return clone;
}

function parseRruleParts(rrule: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const chunk of rrule.split(";")) {
        const idx = chunk.indexOf("=");
        if (idx <= 0) {
            continue;
        }
        map.set(chunk.slice(0, idx).trim().toUpperCase(), chunk.slice(idx + 1).trim());
    }
    return map;
}

function weekdayOfTs(ts: number, zone: string): string {
    const parts = partsOf(ts, zone);
    return WEEKDAY_BY_JS[parts.weekday] ?? "MO";
}

function weekdayZh(code: string): string {
    const key = code.replace(/^[+-]?\d+/, "").toUpperCase();
    return WEEKDAY_ZH[key] ?? code;
}

function monthlyByDayZh(code: string): string {
    const match = /^([+-]?\d+)?([A-Za-z]{2})$/.exec(code.trim());
    if (!match) {
        return code;
    }
    const day = weekdayZh(match[2]);
    if (!match[1]) {
        return day;
    }
    const nth = parseInt(match[1], 10);
    if (nth < 0) {
        return `第${Math.abs(nth)}个${day}（倒数）`;
    }
    return `第${nth}个${day}`;
}

function formatUntilZh(until: string): string {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(until.trim());
    if (!match) {
        return until;
    }
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    return match[4] ? `${date} ${match[4]}:${match[5]}` : date;
}

/** RRULE → 中文简述（例如「每周 周一」「每年」「每 2 天」） */
function summarizeRrule(rrule: string | undefined, startTs: number, zone: string): string | undefined {
    if (!rrule) {
        return undefined;
    }
    const parts = parseRruleParts(rrule);
    const freq = (parts.get("FREQ") ?? "").toUpperCase();
    const intervalRaw = parseInt(parts.get("INTERVAL") ?? "1", 10);
    const interval = Number.isFinite(intervalRaw) && intervalRaw > 1 ? intervalRaw : 1;
    const byday = (parts.get("BYDAY") ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    const bymonthday = parts.get("BYMONTHDAY") ?? "";
    const bymonth = parts.get("BYMONTH") ?? "";
    const count = parts.get("COUNT") ?? "";
    const until = parts.get("UNTIL") ?? "";

    let base: string;
    switch (freq) {
        case "DAILY":
            base = interval > 1 ? `每 ${interval} 天` : "每天";
            break;
        case "WEEKLY": {
            const days = byday.length
                ? byday.map(weekdayZh).join("、")
                : weekdayZh(weekdayOfTs(startTs, zone));
            base = interval > 1 ? `每 ${interval} 周 ${days}` : `每周 ${days}`;
            break;
        }
        case "MONTHLY": {
            base = interval > 1 ? `每 ${interval} 个月` : "每月";
            if (bymonthday) {
                base += ` ${bymonthday
                    .split(",")
                    .map((item) => `${item.trim()} 日`)
                    .join("、")}`;
            } else if (byday.length) {
                base += ` ${byday.map(monthlyByDayZh).join("、")}`;
            }
            break;
        }
        case "YEARLY": {
            base = interval > 1 ? `每 ${interval} 年` : "每年";
            if (bymonth) {
                base += ` ${bymonth
                    .split(",")
                    .map((item) => `${item.trim()} 月`)
                    .join("、")}`;
            }
            if (bymonthday) {
                base += ` ${bymonthday
                    .split(",")
                    .map((item) => `${item.trim()} 日`)
                    .join("、")}`;
            }
            break;
        }
        case "HOURLY":
            base = interval > 1 ? `每 ${interval} 小时` : "每小时";
            break;
        case "MINUTELY":
            base = interval > 1 ? `每 ${interval} 分钟` : "每分钟";
            break;
        case "SECONDLY":
            base = interval > 1 ? `每 ${interval} 秒` : "每秒";
            break;
        default:
            return undefined;
    }
    if (count) {
        base += `（共 ${count} 次）`;
    } else if (until) {
        base += `（至 ${formatUntilZh(until)}）`;
    }
    return base;
}

/** 覆盖实例的 RECURRENCE-ID 绝对时间 */
function recurrenceTsOf(event: InternalEvent, zone: string, fallbackZone: string): number | undefined {
    if (typeof event.recurrenceIdTs === "number" && Number.isFinite(event.recurrenceIdTs)) {
        return event.recurrenceIdTs;
    }
    if (!event.recurrenceId) {
        return undefined;
    }
    return rawTimeToTs(event.recurrenceId, zone, fallbackZone);
}

/** 用 CalendarEvent 重建一个「浮动时间」的 ICAL 组件，专供 RecurExpansion 使用 */
function buildExpansionEvent(event: InternalEvent, zone: string, fixedOffsetMs?: number): ICAL.Event | null {
    const allDay = Boolean(event.allDay);
    let dtstart: ICAL.Time | null;
    if (allDay) {
        dtstart = ICAL.Time.fromDateString(dateKey(event.start, zone));
    } else {
        const wall = wallPartsOf(event.start, zone, fixedOffsetMs);
        dtstart = ICAL.Time.fromDateTimeString(
            `${pad4(wall.year)}-${pad2(wall.month)}-${pad2(wall.day)}T${pad2(wall.hour)}:${pad2(wall.minute)}:${pad2(
                wall.second,
            )}`,
        );
    }
    if (!dtstart) {
        return null;
    }
    const component = new ICAL.Component(["vevent", [], []]);
    const icalEvent = new ICAL.Event(component);
    icalEvent.uid = event.uid || "no-uid";
    icalEvent.startDate = dtstart;

    if (event.rrule) {
        try {
            component.addProperty(ICAL.Property.fromString(`RRULE:${normalizeRrule(event.rrule)}`));
        } catch {
            return null;
        }
    }

    // EXDATE（ical.js 会自行排除；下面还有一层毫秒级过滤兜底）
    for (const ts of event.exdates ?? []) {
        if (!Number.isFinite(ts)) {
            continue;
        }
        try {
            const line = allDay
                ? `EXDATE;VALUE=DATE:${formatCompactDate(ts, zone)}`
                : `EXDATE:${compactFromWall(wallPartsOf(ts, zone, fixedOffsetMs))}`;
            component.addProperty(ICAL.Property.fromString(line));
        } catch {
            /* 非法 EXDATE 忽略 */
        }
    }

    return icalEvent;
}

interface ExpandResult {
    instances: InternalEvent[];
    /** 本次展开「认领」的覆盖实例（无论是否被窗口保留），避免调用方重复输出 */
    consumed: InternalEvent[];
}

function expandRecurring(master: InternalEvent, overrides: InternalEvent[], ctx: ExpandContext): ExpandResult {
    const zone = eventZone(master, ctx.fallbackZone);
    const allDay = Boolean(master.allDay);
    const tzid = normalizeZoneName(master.tzid);
    const fixedOffsetMs =
        !allDay && tzid && tzid !== "UTC" && !isIanaZone(tzid) && typeof master.zoneOffsetMs === "number"
            ? master.zoneOffsetMs
            : undefined;

    const instances: InternalEvent[] = [];
    const consumed: InternalEvent[] = [];
    const icalEvent = buildExpansionEvent(master, zone, fixedOffsetMs);
    if (!icalEvent) {
        return { instances, consumed };
    }

    const spanDays = Math.max(1, Math.round((master.end - master.start) / MS_DAY));
    const durationMs = Math.max(0, master.end - master.start);
    const summary = summarizeRrule(master.rrule, master.start, ctx.fallbackZone);
    const exdateSet = new Set(master.exdates ?? []);
    const overrideByTs = new Map<number, InternalEvent>();
    for (const override of overrides) {
        const ts = recurrenceTsOf(override, zone, ctx.fallbackZone);
        if (ts !== undefined && !overrideByTs.has(ts)) {
            overrideByTs.set(ts, override);
        }
    }

    const emitOverride = (override: InternalEvent): void => {
        consumed.push(override);
        if (ctx.skipCancelled && override.status === "CANCELLED") {
            return; // 覆盖实例被取消 = 删除该次
        }
        if (intersectsWindow(override, ctx.windowStart, ctx.windowEnd)) {
            instances.push({ ...cloneEvent(override), isRecurringInstance: true, rruleSummary: summary });
        }
    };

    const emitOccurrence = (occStart: number): void => {
        const occEnd = allDay ? addDays(occStart, spanDays, zone) : occStart + durationMs;
        if (!intersectsRange(occStart, occEnd, ctx.windowStart, ctx.windowEnd)) {
            return;
        }
        const instance = cloneEvent(master);
        instance.start = occStart;
        instance.end = occEnd;
        instance.isRecurringInstance = true;
        instance.recurrenceId = undefined;
        instance.recurrenceIdTs = undefined;
        instance.rdates = undefined;
        if (summary) {
            instance.rruleSummary = summary;
        }
        instances.push(instance);
    };

    const iterator = icalEvent.iterator();
    let emitted = 0;
    let skipped = 0;
    let iterated = 0;
    let lastKey = "";
    const guard = MAX_SKIP_ITERATIONS + ctx.maxInstances + 100;

    while (emitted < ctx.maxInstances) {
        let current: ICAL.Time | null = null;
        try {
            current = iterator.next() as ICAL.Time | null;
        } catch {
            break;
        }
        if (!current) {
            break;
        }
        if (++iterated > guard) {
            break;
        }
        const key = current.toString();
        if (key === lastKey) {
            break; // 迭代器原地打转：防死循环
        }
        lastKey = key;

        const occStart = occurrenceStart(current, zone, allDay, fixedOffsetMs);
        if (!Number.isFinite(occStart)) {
            break;
        }
        if (occStart >= ctx.windowEnd) {
            break; // 迭代时间递增，后面都不在窗口内
        }
        const override = overrideByTs.get(occStart);
        if (occStart < ctx.windowStart) {
            if (override) {
                emitOverride(override);
            } else if (++skipped > MAX_SKIP_ITERATIONS) {
                break;
            }
            continue;
        }
        if (override) {
            emitOverride(override);
            emitted++;
            continue;
        }
        if (exdateSet.has(occStart)) {
            continue;
        }
        emitOccurrence(occStart);
        emitted++;
    }

    // RDATE：RRULE 之外额外指定的时间点
    for (const ts of master.rdates ?? []) {
        if (emitted >= ctx.maxInstances) {
            break;
        }
        const override = overrideByTs.get(ts);
        if (override) {
            emitOverride(override);
            emitted++;
            continue;
        }
        if (ts < ctx.windowStart || ts >= ctx.windowEnd || exdateSet.has(ts)) {
            continue;
        }
        emitOccurrence(ts);
        emitted++;
    }

    return { instances, consumed };
}

/**
 * 把主事件按 RRULE/RDATE/EXDATE/覆盖实例展开为窗口内的事件列表。
 * 非重复事件按 `[start, end)` 与窗口求交（0 长度事件占 1ms）。
 * 返回值均为克隆对象，不会修改入参。
 */
export function expandEvents(events: CalendarEvent[], options: ExpandOptions): CalendarEvent[] {
    const out: CalendarEvent[] = [];
    if (!Array.isArray(events) || events.length === 0 || !options) {
        return out;
    }
    const windowStart = Number(options.windowStart);
    const windowEnd = Number(options.windowEnd);
    if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
        return out;
    }
    const maxInstancesRaw = Number(options.maxInstances);
    const maxInstances =
        Number.isFinite(maxInstancesRaw) && maxInstancesRaw > 0 ? Math.floor(maxInstancesRaw) : DEFAULT_MAX_INSTANCES;
    const fallbackZone = resolveFallbackZone(options.timeZone);
    const skipCancelled = options.skipCancelled !== false;
    const ctx: ExpandContext = { windowStart, windowEnd, maxInstances, fallbackZone, skipCancelled };

    const masters = new Map<string, InternalEvent>();
    const overridesByUid = new Map<string, InternalEvent[]>();
    const orderedMasters: InternalEvent[] = [];

    for (const raw of events) {
        if (!raw || typeof raw !== "object") {
            continue;
        }
        const event = raw as InternalEvent;
        if (typeof event.recurrenceId === "string" && event.recurrenceId) {
            const list = overridesByUid.get(event.uid);
            if (list) {
                list.push(event);
            } else {
                overridesByUid.set(event.uid, [event]);
            }
            continue;
        }
        if (!masters.has(event.uid)) {
            masters.set(event.uid, event);
            orderedMasters.push(event);
        }
    }

    /** 已被展开过程认领的覆盖实例 */
    const consumed = new Set<InternalEvent>();
    /** 主事件整体被取消 -> 其覆盖实例也不再输出 */
    const cancelledUids = new Set<string>();

    const isRecurringMaster = (master: InternalEvent): boolean =>
        Boolean(master.rrule) || Boolean(master.rdates && master.rdates.length);

    for (const master of orderedMasters) {
        const overrides = overridesByUid.get(master.uid) ?? [];
        if (skipCancelled && master.status === "CANCELLED") {
            cancelledUids.add(master.uid);
            continue;
        }
        if (isRecurringMaster(master)) {
            try {
                const result = expandRecurring(master, overrides, ctx);
                for (const instance of result.instances) {
                    out.push(instance);
                }
                for (const override of result.consumed) {
                    consumed.add(override);
                }
            } catch {
                // 规则异常时至少保留主事件本身
                if (intersectsWindow(master, windowStart, windowEnd)) {
                    out.push(cloneEvent(master));
                }
                for (const override of overrides) {
                    consumed.add(override);
                }
            }
            continue;
        }
        if (intersectsWindow(master, windowStart, windowEnd)) {
            out.push(cloneEvent(master));
        }
    }

    // 覆盖实例兜底：
    // 1. 没有主事件的孤立实例（服务端只回了单个实例）；
    // 2. 起点不在迭代结果里的实例（例如被移动到窗口内），或展开被 maxInstances 截断的实例。
    for (const [uid, list] of overridesByUid) {
        if (cancelledUids.has(uid)) {
            continue;
        }
        const master = masters.get(uid);
        const series = master ? isRecurringMaster(master) : false;
        for (const override of list) {
            if (consumed.has(override)) {
                continue;
            }
            if (skipCancelled && override.status === "CANCELLED") {
                continue;
            }
            if (!intersectsWindow(override, windowStart, windowEnd)) {
                continue;
            }
            if (master && series) {
                out.push({
                    ...cloneEvent(override),
                    isRecurringInstance: true,
                    rruleSummary: summarizeRrule(master.rrule, master.start, fallbackZone),
                });
            } else {
                out.push(cloneEvent(override));
            }
        }
    }

    return sortEvents(out);
}

function sortEvents(events: CalendarEvent[]): CalendarEvent[] {
    return events
        .map((event, index) => ({ event, index }))
        .sort((a, b) => a.event.start - b.event.start || a.event.end - b.event.end || a.index - b.index)
        .map((entry) => entry.event);
}

/* —— 生成 —— */

interface Observance {
    kind: "standard" | "daylight";
    dtstart: string;
    from: number;
    to: number;
    tzname: string;
}

/** 用 Intl 采样出某时区在指定年份的偏移变化，生成 VTIMEZONE 观测项 */
function collectObservances(zone: string, year: number): Observance[] {
    const yearStart = Date.UTC(year, 0, 1);
    const yearEnd = Date.UTC(year + 1, 0, 1);
    const step = 5 * MS_DAY;
    const firstOffset = zoneOffset(yearStart + MS_DAY / 2, zone);

    const transitions: { ts: number; from: number; to: number }[] = [];
    let previous = firstOffset;
    for (let cursor = yearStart + MS_DAY / 2; cursor < yearEnd; cursor += step) {
        const offset = zoneOffset(cursor, zone);
        if (offset !== previous) {
            let low = cursor - step;
            let high = cursor;
            while (high - low > MS_MINUTE) {
                const mid = Math.floor((low + high) / 2);
                if (zoneOffset(mid, zone) === previous) {
                    low = mid;
                } else {
                    high = mid;
                }
            }
            transitions.push({ ts: high, from: previous, to: zoneOffset(high, zone) });
            previous = zoneOffset(high, zone);
        }
    }

    const offsets = new Set<number>([firstOffset]);
    for (const transition of transitions) {
        offsets.add(transition.to);
    }
    const sorted = [...offsets].sort((a, b) => a - b);
    const daylightOffset = sorted[sorted.length - 1];
    const hasDst = sorted.length > 1;
    const kindOf = (offset: number): "standard" | "daylight" =>
        hasDst && offset === daylightOffset ? "daylight" : "standard";

    const observances: Observance[] = [];
    const yearStartLocal = zonedTimeToTs(year, 1, 1, 0, 0, 0, zone);
    observances.push({
        kind: kindOf(firstOffset),
        dtstart: formatCompactDateTime(yearStartLocal, zone),
        from: firstOffset,
        to: firstOffset,
        tzname: tznameAt(yearStartLocal + MS_DAY, zone),
    });
    for (const transition of transitions) {
        observances.push({
            kind: kindOf(transition.to),
            dtstart: formatCompactDateTime(transition.ts, zone),
            from: transition.from,
            to: transition.to,
            tzname: tznameAt(transition.ts + MS_MINUTE, zone),
        });
    }
    return observances;
}

/** 依据 Intl 的偏移信息生成 VTIMEZONE 行（失败返回空数组） */
function buildVtimezoneLines(zone: string, referenceTs: number): string[] {
    try {
        if (!isIanaZone(zone) || zone === "UTC") {
            return [];
        }
        const year = partsOf(referenceTs, zone).year;
        const observances = collectObservances(zone, year);
        if (!observances.length) {
            return [];
        }
        const lines: string[] = ["BEGIN:VTIMEZONE", `TZID:${zone}`];
        for (const item of observances) {
            const name = item.kind.toUpperCase();
            lines.push(`BEGIN:${name}`);
            lines.push(`DTSTART:${item.dtstart}`);
            lines.push(`TZOFFSETFROM:${formatOffset(item.from)}`);
            lines.push(`TZOFFSETTO:${formatOffset(item.to)}`);
            if (item.tzname) {
                lines.push(`TZNAME:${item.tzname}`);
            }
            lines.push(`END:${name}`);
        }
        lines.push("END:VTIMEZONE");
        return lines;
    } catch {
        return [];
    }
}

/**
 * 由 CalendarEvent 生成可 PUT 的 ICS 文本（CRLF 换行，75 字节折行）。
 *
 * 除了需求列出的字段外，还会写出 `RECURRENCE-ID`（覆盖实例必需）、
 * `EXDATE`、`LAST-MODIFIED` / `CREATED`（若模型里有），以便 build → parse 往返保真。
 */
export function buildIcs(event: CalendarEvent, options: BuildIcsOptions = {}): string {
    const prodid = options.prodid || DEFAULT_PRODID;
    const includeTimezone = options.includeTimezone !== false;
    const sequenceRaw = Number(options.sequence);
    const sequence = Number.isFinite(sequenceRaw) && sequenceRaw > 0 ? Math.floor(sequenceRaw) : 0;
    const localZone = getLocalTimeZone();
    const allDay = Boolean(event.allDay);
    const tzid = normalizeZoneName(event.tzid);
    const useZone = !allDay && Boolean(tzid) && tzid !== "UTC" && isIanaZone(tzid);
    const zone = useZone ? tzid : "UTC";
    const dayZone = tzid && isIanaZone(tzid) ? tzid : localZone;

    const lines: string[] = [];
    lines.push("BEGIN:VCALENDAR");
    lines.push("VERSION:2.0");
    lines.push("CALSCALE:GREGORIAN");
    lines.push(`PRODID:${escapeIcsText(prodid)}`);
    if (useZone && includeTimezone) {
        for (const line of buildVtimezoneLines(zone, Number.isFinite(event.start) ? event.start : Date.now())) {
            lines.push(line);
        }
    }
    const extras = event as InternalEvent;
    const isTodo = extras.isTodo === true;
    const componentName = isTodo ? "VTODO" : "VEVENT";
    lines.push(`BEGIN:${componentName}`);
    lines.push(`UID:${escapeIcsText(event.uid || "")}`);
    lines.push(`DTSTAMP:${formatUtcCompact(Date.now())}`);
    if (typeof event.lastModified === "number" && Number.isFinite(event.lastModified)) {
        lines.push(`LAST-MODIFIED:${formatUtcCompact(event.lastModified)}`);
    }
    if (typeof event.created === "number" && Number.isFinite(event.created)) {
        lines.push(`CREATED:${formatUtcCompact(event.created)}`);
    }
    lines.push(`SEQUENCE:${sequence}`);

    if (isTodo) {
        // VTODO：DTSTART 可选、DUE 总是输出（对应 CalendarEvent.start/end）。
        // 只有 DUE 的任务解析后 start === end，这里必须仍然写回 DUE，否则往返会丢时间。
        const dueTs = Number.isFinite(event.end) ? Math.max(event.end, event.start) : event.start;
        if (allDay) {
            lines.push(`DTSTART;VALUE=DATE:${formatCompactDate(event.start, dayZone)}`);
            lines.push(`DUE;VALUE=DATE:${formatCompactDate(dueTs, dayZone)}`);
        } else {
            lines.push(`${useZone ? `DTSTART;TZID=${zone}` : "DTSTART"}:${formatCompactDateTime(event.start, zone)}`);
            lines.push(`${useZone ? `DUE;TZID=${zone}` : "DUE"}:${formatCompactDateTime(dueTs, zone)}`);
        }
        if (typeof extras.percentComplete === "number" && Number.isFinite(extras.percentComplete)) {
            lines.push(`PERCENT-COMPLETE:${Math.max(0, Math.min(100, Math.round(extras.percentComplete)))}`);
        }
        if (typeof extras.completedAt === "number" && Number.isFinite(extras.completedAt)) {
            lines.push(`COMPLETED:${formatUtcCompact(extras.completedAt)}`);
        }
    } else if (allDay) {
        lines.push(`DTSTART;VALUE=DATE:${formatCompactDate(event.start, dayZone)}`);
        const spanDays = Math.max(1, Math.round((event.end - event.start) / MS_DAY));
        if (event.hasEndDate === true || spanDays > 1) {
            const end = spanDays > 1 ? event.end : addDays(event.start, 1, dayZone);
            lines.push(`DTEND;VALUE=DATE:${formatCompactDate(end, dayZone)}`);
        }
    } else {
        lines.push(`${useZone ? `DTSTART;TZID=${zone}` : "DTSTART"}:${formatCompactDateTime(event.start, zone)}`);
        if (event.end > event.start) {
            lines.push(`${useZone ? `DTEND;TZID=${zone}` : "DTEND"}:${formatCompactDateTime(event.end, zone)}`);
        }
    }
    void componentName;

    if (event.rrule) {
        const body = normalizeRrule(event.rrule);
        if (body) {
            lines.push(`RRULE:${body}`);
        }
    }

    for (const ts of event.exdates ?? []) {
        if (!Number.isFinite(ts)) {
            continue;
        }
        if (allDay) {
            lines.push(`EXDATE;VALUE=DATE:${formatCompactDate(ts, dayZone)}`);
        } else {
            lines.push(
                `${useZone ? `EXDATE;TZID=${zone}` : "EXDATE"}:${
                    useZone ? formatCompactDateTime(ts, zone) : formatUtcCompact(ts)
                }`,
            );
        }
    }

    if (event.recurrenceId && !isTodo) {
        const recurrenceTs = (event as InternalEvent).recurrenceIdTs;
        if (typeof recurrenceTs === "number" && Number.isFinite(recurrenceTs)) {
            if (allDay) {
                lines.push(`RECURRENCE-ID;VALUE=DATE:${formatCompactDate(recurrenceTs, dayZone)}`);
            } else {
                lines.push(
                    `${useZone ? `RECURRENCE-ID;TZID=${zone}` : "RECURRENCE-ID"}:${
                        useZone ? formatCompactDateTime(recurrenceTs, zone) : formatUtcCompact(recurrenceTs)
                    }`,
                );
            }
        } else {
            lines.push(`RECURRENCE-ID:${escapeIcsText(event.recurrenceId)}`);
        }
    }

    lines.push(`SUMMARY:${escapeIcsText(event.title || "")}`);
    if (event.description) {
        lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    }
    if (event.location) {
        lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    }
    if (event.categories && event.categories.length) {
        lines.push(`CATEGORIES:${event.categories.map((item) => escapeIcsText(item)).join(",")}`);
    }
    if (event.status && !isTodo) {
        lines.push(`STATUS:${event.status}`);
    }
    if (isTodo) {
        // VTODO 的 STATUS 取值域与 VEVENT 不同，需要映射，避免服务端拒绝
        const percent = typeof extras.percentComplete === "number" ? extras.percentComplete : undefined;
        if (percent !== undefined && percent >= 100) {
            lines.push("STATUS:COMPLETED");
        } else if (event.status === "CANCELLED") {
            lines.push("STATUS:CANCELLED");
        } else {
            lines.push("STATUS:IN-PROCESS");
        }
    }
    if (event.transparency && !isTodo) {
        lines.push(`TRANSP:${event.transparency}`);
    }
    if (event.cls) {
        lines.push(`CLASS:${event.cls}`);
    }
    if (event.url) {
        lines.push(`URL:${event.url}`);
    }
    if (event.organizer && (event.organizer.cn || event.organizer.mailto)) {
        lines.push(`ORGANIZER${attendeeParams(event.organizer, false)}:${attendeeValue(event.organizer)}`);
    }
    for (const attendee of event.attendees ?? []) {
        if (!attendee || (!attendee.cn && !attendee.mailto)) {
            continue;
        }
        lines.push(`ATTENDEE${attendeeParams(attendee, true)}:${attendeeValue(attendee)}`);
    }
    for (const alarm of event.alarms ?? []) {
        const trigger = Number(alarm && alarm.trigger);
        if (!Number.isFinite(trigger)) {
            continue;
        }
        lines.push("BEGIN:VALARM");
        lines.push(`ACTION:${(alarm.action || "DISPLAY").toUpperCase()}`);
        lines.push(`DESCRIPTION:${escapeIcsText(alarm.description || event.title || "Reminder")}`);
        lines.push(`TRIGGER:${formatTrigger(trigger)}`);
        lines.push("END:VALARM");
    }
    lines.push(`END:${componentName}`);
    lines.push("END:VCALENDAR");

    return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function attendeeValue(attendee: IAttendee): string {
    const mailto = (attendee.mailto ?? "").trim();
    if (!mailto) {
        return "";
    }
    return /^[a-z][a-z0-9+.-]*:/i.test(mailto) ? mailto : `mailto:${mailto}`;
}

function attendeeParams(attendee: IAttendee, withPartstat: boolean): string {
    const params: string[] = [];
    if (attendee.cn) {
        params.push(`CN=${quoteParam(attendee.cn)}`);
    }
    if (withPartstat && attendee.partstat) {
        params.push(`PARTSTAT=${attendee.partstat}`);
    }
    if (attendee.role) {
        params.push(`ROLE=${attendee.role}`);
    }
    return params.length ? `;${params.join(";")}` : "";
}

/** 参数值含 , ; : 时按 RFC 6868 / RFC 5545 加引号 */
function quoteParam(value: string): string {
    if (/[,;:]/.test(value)) {
        return `"${value.replace(/"/g, "")}"`;
    }
    return value;
}

/* —— 哈希 / UID / 识别 —— */

/** 计算事件的稳定哈希（忽略 LAST-MODIFIED/DTSTAMP 等易变字段） */
export function eventHash(event: CalendarEvent): string {
    if (!event || typeof event !== "object") {
        return fnv1a("");
    }
    const attendees = (event.attendees ?? [])
        .map((item) => [item.cn ?? "", item.mailto ?? "", item.partstat ?? "", item.role ?? ""].join("\u0001"))
        .join("\u0002");
    const organizer = event.organizer
        ? [event.organizer.cn ?? "", event.organizer.mailto ?? "", event.organizer.partstat ?? "", event.organizer.role ?? ""].join(
              "\u0001",
          )
        : "";
    const alarms = (event.alarms ?? [])
        .map((item) => [Math.round(Number(item.trigger) || 0), item.action ?? "", item.description ?? ""].join("\u0001"))
        .join("\u0002");
    const parts: (string | number)[] = [
        event.uid ?? "",
        event.title ?? "",
        event.description ?? "",
        event.location ?? "",
        (event.categories ?? []).join("\u0001"),
        Number(event.start) || 0,
        Number(event.end) || 0,
        event.allDay ? 1 : 0,
        event.rrule ?? "",
        event.status ?? "",
        event.transparency ?? "",
        event.cls ?? "",
        attendees,
        organizer,
        alarms,
        event.recurrenceId ?? "",
    ];
    return fnv1a(parts.join("\u0000"));
}

/** 取 ICS 文本里的事件 UID（可用于 REPORT 结果预解析） */
export function extractUid(ics: string): string | undefined {
    if (typeof ics !== "string" || !ics) {
        return undefined;
    }
    try {
        for (const root of parseRoots(ics)) {
            const vevent = collectVevents(root)[0];
            if (vevent) {
                const uid = componentText(vevent, "uid");
                if (uid) {
                    return uid;
                }
            }
        }
    } catch {
        /* 落到正则兜底 */
    }
    try {
        const unfolded = ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
        const match = /^UID(?:;[^:\r\n]*)?:(.*)$/im.exec(unfolded);
        if (match && match[1]) {
            const uid = unescapeText(match[1].trim());
            return uid || undefined;
        }
    } catch {
        /* 忽略 */
    }
    return undefined;
}

/** 简单判断文本是否像 iCalendar 数据 */
export function looksLikeIcs(text: string): boolean {
    if (typeof text !== "string" || !text) {
        return false;
    }
    return /BEGIN:(VCALENDAR|VEVENT|VTODO|VJOURNAL|VFREEBUSY|VTIMEZONE)/i.test(text);
}

/** 该事件是否来自 VTODO（任务型服务端，例如 Vikunja） */
export function isTodoEvent(event: CalendarEvent): boolean {
    return (event as InternalEvent).isTodo === true;
}
