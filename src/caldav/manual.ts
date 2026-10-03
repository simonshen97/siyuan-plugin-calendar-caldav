import type { CalDavAccount, CalendarInfo } from "../types";
import { calendarId } from "../caldav/client";

/**
 * 手动日历集合地址的处理。
 *
 * 背景：少数 CalDAV 服务端（典型是 QQ 邮箱 `dav.qq.com`）对任何 PROPFIND / REPORT 都返回
 * **空 multistatus**，既枚举不到日历集合也查询不到事件；这类服务只认「固定的集合地址」。
 * 因此除了自动发现，还允许用户在账户里手动填写集合 URL。
 */

/** 统一日历 URL：去掉查询串/片段、补结尾斜杠 */
export function normalizeCalendarUrl(raw: string): string {
    const value = (raw ?? "").trim();
    if (!value) {
        return "";
    }
    const [base] = value.split(/[?#]/);
    return `${base.replace(/\/+$/, "")}/`;
}

/** 由 URL 末段推断日历显示名（百分号解码，失败时退回原文） */
export function calendarNameFromUrl(url: string): string {
    const segments = normalizeCalendarUrl(url).replace(/\/+$/, "").split("/");
    const last = segments[segments.length - 1] ?? url;
    try {
        return decodeURIComponent(last) || url;
    } catch {
        return last || url;
    }
}

/**
 * 合并「自动发现的日历」与「手动填写的日历 URL」。
 * 手动 URL 与已发现集合相同时复用已发现项，保留其颜色与只读设置。
 */
export function mergeManualCalendars(account: CalDavAccount): CalendarInfo[] {
    const discovered = account.calendars ?? [];
    const manual = account.manualCalendarUrls ?? [];
    if (!manual.length) {
        return discovered;
    }
    const byUrl = new Map<string, CalendarInfo>();
    for (const info of discovered) {
        if (info.source.kind === "caldav") {
            byUrl.set(normalizeCalendarUrl(info.source.calendarUrl), info);
        }
    }
    const merged = [...discovered];
    for (const raw of manual) {
        const url = normalizeCalendarUrl(raw);
        if (!url || byUrl.has(url)) {
            continue;
        }
        const name = calendarNameFromUrl(url);
        const info: CalendarInfo = {
            id: calendarId(account.id, url),
            name,
            color: account.color,
            readOnly: false,
            source: {
                kind: "caldav",
                accountId: account.id,
                calendarUrl: url,
                displayName: name,
                components: ["VEVENT"],
            },
        };
        byUrl.set(url, info);
        merged.push(info);
    }
    return merged;
}
