import { describe, expect, it } from "vitest";

import type { CalendarEvent } from "../types";
import { MS_DAY, MS_MINUTE, dateKeyToTs, getLocalTimeZone, zonedTimeToTs } from "../util/date";
import { buildIcs, eventHash, expandEvents, extractUid, looksLikeIcs, parseIcs } from "./ics";

const TZ = "Asia/Shanghai";

function cal(...blocks: string[][]): string {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN"];
    for (const block of blocks) {
        lines.push(...block);
    }
    lines.push("END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
}

function vevent(...lines: string[]): string[] {
    return ["BEGIN:VEVENT", ...lines, "END:VEVENT"];
}

/** 还原 RFC 5545 折行，便于对内容做断言 */
function unfold(ics: string): string {
    return ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

function parseOne(ics: string): CalendarEvent {
    const events = parseIcs(ics, { calendarId: "cal-1", defaultTimeZone: TZ });
    expect(events).toHaveLength(1);
    return events[0];
}

function expand(events: CalendarEvent[], windowStart: number, windowEnd: number, maxInstances?: number): CalendarEvent[] {
    return expandEvents(events, { windowStart, windowEnd, timeZone: TZ, maxInstances });
}

const WINDOW_START = Date.UTC(2024, 11, 1);
const WINDOW_END = Date.UTC(2025, 11, 31);

describe("parseIcs", () => {
    it("解析全天单日事件（DTEND 为次日、开区间）", () => {
        const event = parseOne(
            cal(vevent("UID:allday-1", "SUMMARY:全天单日", "DTSTART;VALUE=DATE:20250108", "DTEND;VALUE=DATE:20250109")),
        );
        expect(event.allDay).toBe(true);
        expect(event.hasEndDate).toBe(true);
        expect(event.start).toBe(dateKeyToTs("2025-01-08", TZ));
        expect(event.end).toBe(dateKeyToTs("2025-01-09", TZ));
        expect(event.end - event.start).toBe(MS_DAY);
        expect(event.title).toBe("全天单日");
        expect(event.calendar).toBe("cal-1");
        expect(event.sourceKind).toBe("caldav");
    });

    it("解析全天多日事件（DTEND 独占最后一天之后）", () => {
        const event = parseOne(
            cal(vevent("UID:allday-2", "SUMMARY:三天", "DTSTART;VALUE=DATE:20250108", "DTEND;VALUE=DATE:20250111")),
        );
        expect(event.allDay).toBe(true);
        expect(event.start).toBe(dateKeyToTs("2025-01-08", TZ));
        expect(event.end).toBe(dateKeyToTs("2025-01-11", TZ));
        expect(Math.round((event.end - event.start) / MS_DAY)).toBe(3);
    });

    it("全天事件无 DTEND 时按单日处理", () => {
        const event = parseOne(cal(vevent("UID:allday-3", "SUMMARY:单日", "DTSTART;VALUE=DATE:20250108")));
        expect(event.allDay).toBe(true);
        expect(event.hasEndDate).toBe(false);
        expect(event.end).toBe(dateKeyToTs("2025-01-09", TZ));
    });

    it("解析 TZID 定时事件", () => {
        const event = parseOne(
            cal(
                vevent(
                    "UID:tz-1",
                    "SUMMARY:带时区",
                    "DTSTART;TZID=Asia/Shanghai:20250108T090000",
                    "DTEND;TZID=Asia/Shanghai:20250108T103000",
                ),
            ),
        );
        expect(event.allDay).toBe(false);
        expect(event.tzid).toBe(TZ);
        expect(event.start).toBe(zonedTimeToTs(2025, 1, 8, 9, 0, 0, TZ));
        expect(event.end).toBe(zonedTimeToTs(2025, 1, 8, 10, 30, 0, TZ));
    });

    it("解析带 VTIMEZONE 的自定义时区（并注册时区）", () => {
        const vtimezone = [
            "BEGIN:VTIMEZONE",
            "TZID:Custom/Zone",
            "BEGIN:STANDARD",
            "DTSTART:19700101T000000",
            "TZOFFSETFROM:+0800",
            "TZOFFSETTO:+0800",
            "TZNAME:CST",
            "END:STANDARD",
            "END:VTIMEZONE",
        ];
        const event = parseOne(
            cal(vtimezone, vevent("UID:tz-2", "SUMMARY:自定义时区", "DTSTART;TZID=Custom/Zone:20250108T090000")),
        );
        expect(event.tzid).toBe("Custom/Zone");
        expect(event.start).toBe(Date.UTC(2025, 0, 8, 1, 0, 0));
    });

    it("解析 UTC 事件", () => {
        const event = parseOne(
            cal(vevent("UID:utc-1", "SUMMARY:UTC", "DTSTART:20250108T090000Z", "DTEND:20250108T100000Z")),
        );
        expect(event.start).toBe(Date.UTC(2025, 0, 8, 9, 0, 0));
        expect(event.end).toBe(Date.UTC(2025, 0, 8, 10, 0, 0));
        expect(event.tzid).toBeUndefined();
    });

    it("解析浮动时间（按兜底时区解释）", () => {
        const event = parseOne(cal(vevent("UID:float-1", "SUMMARY:浮动", "DTSTART:20250108T090000")));
        expect(event.start).toBe(zonedTimeToTs(2025, 1, 8, 9, 0, 0, TZ));
    });

    it("解析 DURATION（无 DTEND）", () => {
        const event = parseOne(
            cal(vevent("UID:dur-1", "SUMMARY:时长", "DTSTART:20250108T090000Z", "DURATION:PT1H")),
        );
        expect(event.end - event.start).toBe(60 * MS_MINUTE);
    });

    it("映射描述/地点/分类/状态/提醒/参与人/重复规则等字段", () => {
        const event = parseOne(
            cal(
                vevent(
                    "UID:fields-1",
                    "SUMMARY:标题\\, 带逗号",
                    "DESCRIPTION:<p>第一行<br>第二行</p>",
                    "LOCATION:会议室 A",
                    "CATEGORIES:工作,重要",
                    "STATUS:TENTATIVE",
                    "TRANSP:TRANSPARENT",
                    "CLASS:PRIVATE",
                    "URL:https://example.com/e/1",
                    "DTSTAMP:20250101T000000Z",
                    "LAST-MODIFIED:20250102T030405Z",
                    "CREATED:20241231T120000Z",
                    "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6;UNTIL=20250601T000000Z",
                    "ORGANIZER;CN=Boss:mailto:boss@example.com",
                    "ATTENDEE;CN=Zhang San;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:zhang@example.com",
                    "DTSTART:20250108T090000Z",
                    "DTEND:20250108T100000Z",
                    "BEGIN:VALARM",
                    "ACTION:DISPLAY",
                    "DESCRIPTION:提醒",
                    "TRIGGER:-PT15M",
                    "END:VALARM",
                ),
            ),
        );
        expect(event.title).toBe("标题, 带逗号");
        expect(event.description).toBe("第一行\n第二行");
        expect(event.location).toBe("会议室 A");
        expect(event.categories).toEqual(["工作", "重要"]);
        expect(event.status).toBe("TENTATIVE");
        expect(event.transparency).toBe("TRANSPARENT");
        expect(event.cls).toBe("PRIVATE");
        expect(event.url).toBe("https://example.com/e/1");
        expect(event.lastModified).toBe(Date.UTC(2025, 0, 2, 3, 4, 5));
        expect(event.created).toBe(Date.UTC(2024, 11, 31, 12, 0, 0));
        expect(event.rrule).toContain("FREQ=WEEKLY");
        expect(event.rrule).not.toContain("RRULE:");
        expect(event.organizer).toEqual({ cn: "Boss", mailto: "boss@example.com" });
        expect(event.attendees).toEqual([
            { cn: "Zhang San", mailto: "zhang@example.com", partstat: "ACCEPTED", role: "REQ-PARTICIPANT" },
        ]);
        // 约定：alarms[].trigger 是「相对事件起止的毫秒偏移」
        expect(event.alarms).toEqual([{ trigger: -15 * 60_000, action: "DISPLAY", description: "提醒" }]);
    });

    it("非法输入返回空数组而不是抛异常", () => {
        expect(parseIcs("", { calendarId: "c" })).toEqual([]);
        expect(parseIcs("这不是日历数据", { calendarId: "c" })).toEqual([]);
        expect(parseIcs("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", { calendarId: "c" })).toEqual([]);
    });

    it("提取 UID / 识别 ICS 文本", () => {
        const ics = cal(vevent("UID:uid-abc", "SUMMARY:x", "DTSTART:20250108T090000Z"));
        expect(extractUid(ics)).toBe("uid-abc");
        expect(extractUid("UID:raw-uid\r\nSUMMARY:x")).toBe("raw-uid");
        expect(looksLikeIcs(ics)).toBe(true);
        expect(looksLikeIcs("hello world")).toBe(false);
    });
});

describe("expandEvents", () => {
    it("每周 RRULE + COUNT", () => {
        const events = parseIcs(
            cal(
                vevent(
                    "UID:weekly-1",
                    "SUMMARY:周会",
                    "DTSTART:20250108T090000Z",
                    "DTEND:20250108T100000Z",
                    "RRULE:FREQ=WEEKLY;COUNT=3",
                ),
            ),
            { calendarId: "cal-1", defaultTimeZone: TZ },
        );
        const list = expand(events, WINDOW_START, WINDOW_END);
        expect(list).toHaveLength(3);
        expect(list.map((item) => item.start)).toEqual([
            Date.UTC(2025, 0, 8, 9, 0, 0),
            Date.UTC(2025, 0, 15, 9, 0, 0),
            Date.UTC(2025, 0, 22, 9, 0, 0),
        ]);
        expect(list.every((item) => item.isRecurringInstance === true)).toBe(true);
        expect(list.every((item) => item.end - item.start === 60 * MS_MINUTE)).toBe(true);
        expect(list[0].rruleSummary).toBe("每周 周三（共 3 次）");
    });

    it("每周 RRULE + BYDAY + EXDATE", () => {
        const events = parseIcs(
            cal(
                vevent(
                    "UID:weekly-2",
                    "SUMMARY:例会",
                    "DTSTART:20250108T090000Z",
                    "DTEND:20250108T093000Z",
                    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5",
                    "EXDATE:20250115T090000Z",
                ),
            ),
            { calendarId: "cal-1", defaultTimeZone: TZ },
        );
        expect(events[0].exdates).toEqual([Date.UTC(2025, 0, 15, 9, 0, 0)]);
        const list = expand(events, WINDOW_START, WINDOW_END);
        expect(list.map((item) => item.start)).toEqual([
            Date.UTC(2025, 0, 8, 9, 0, 0),
            Date.UTC(2025, 0, 13, 9, 0, 0),
            Date.UTC(2025, 0, 20, 9, 0, 0),
            Date.UTC(2025, 0, 22, 9, 0, 0),
        ]);
        expect(list[0].rruleSummary).toBe("每周 周一、周三（共 5 次）");
    });

    it("每 2 天 / 每年的中文简述", () => {
        const daily = parseIcs(
            cal(vevent("UID:d-1", "SUMMARY:d", "DTSTART:20250108T090000Z", "RRULE:FREQ=DAILY;INTERVAL=2")),
            { calendarId: "cal-1", defaultTimeZone: TZ },
        );
        const dailyList = expand(daily, WINDOW_START, WINDOW_END, 3);
        expect(dailyList[0].rruleSummary).toBe("每 2 天");
        expect(dailyList).toHaveLength(3);

        const yearly = parseIcs(
            cal(vevent("UID:y-1", "SUMMARY:y", "DTSTART:20250108T090000Z", "RRULE:FREQ=YEARLY")),
            { calendarId: "cal-1", defaultTimeZone: TZ },
        );
        const yearlyList = expand(yearly, WINDOW_START, Date.UTC(2030, 0, 1));
        expect(yearlyList[0].rruleSummary).toBe("每年");
        expect(yearlyList.map((item) => item.start)).toEqual([
            Date.UTC(2025, 0, 8, 9, 0, 0),
            Date.UTC(2026, 0, 8, 9, 0, 0),
            Date.UTC(2027, 0, 8, 9, 0, 0),
            Date.UTC(2028, 0, 8, 9, 0, 0),
            Date.UTC(2029, 0, 8, 9, 0, 0),
        ]);
    });

    it("覆盖实例（RECURRENCE-ID + 不同 SUMMARY）替换生成的实例", () => {
        const events = parseIcs(
            cal(
                vevent(
                    "UID:over-1",
                    "SUMMARY:原定",
                    "DTSTART:20250108T090000Z",
                    "DTEND:20250108T100000Z",
                    "RRULE:FREQ=WEEKLY;COUNT=3",
                ),
                vevent(
                    "UID:over-1",
                    "RECURRENCE-ID:20250115T090000Z",
                    "SUMMARY:改期",
                    "DTSTART:20250115T140000Z",
                    "DTEND:20250115T150000Z",
                ),
            ),
            { calendarId: "cal-1", defaultTimeZone: TZ },
        );
        expect(events).toHaveLength(2);
        expect(events[1].recurrenceId).toBe("2025-01-15T09:00:00Z");
        const list = expand(events, WINDOW_START, WINDOW_END);
        expect(list).toHaveLength(3);
        expect(list.map((item) => item.title)).toEqual(["原定", "改期", "原定"]);
        expect(list[1].start).toBe(Date.UTC(2025, 0, 15, 14, 0, 0));
        expect(list[1].end).toBe(Date.UTC(2025, 0, 15, 15, 0, 0));
        expect(list[1].isRecurringInstance).toBe(true);
    });

    it("CANCELLED 事件被跳过，CANCELLED 覆盖实例等于删除该次", () => {
        const cancelled = parseIcs(
            cal(
                vevent(
                    "UID:cancel-1",
                    "SUMMARY:取消",
                    "STATUS:CANCELLED",
                    "DTSTART:20250108T090000Z",
                    "DTEND:20250108T100000Z",
                ),
            ),
            { calendarId: "cal-1", defaultTimeZone: TZ },
        );
        expect(expand(cancelled, WINDOW_START, WINDOW_END)).toEqual([]);
        expect(expandEvents(cancelled, { windowStart: WINDOW_START, windowEnd: WINDOW_END, skipCancelled: false })).toHaveLength(1);

        const withOverride = parseIcs(
            cal(
                vevent(
                    "UID:cancel-2",
                    "SUMMARY:例会",
                    "DTSTART:20250108T090000Z",
                    "DTEND:20250108T100000Z",
                    "RRULE:FREQ=WEEKLY;COUNT=3",
                ),
                vevent(
                    "UID:cancel-2",
                    "RECURRENCE-ID:20250115T090000Z",
                    "STATUS:CANCELLED",
                    "DTSTART:20250115T090000Z",
                    "DTEND:20250115T100000Z",
                ),
            ),
            { calendarId: "cal-1", defaultTimeZone: TZ },
        );
        const list = expand(withOverride, WINDOW_START, WINDOW_END);
        expect(list.map((item) => item.start)).toEqual([Date.UTC(2025, 0, 8, 9, 0, 0), Date.UTC(2025, 0, 22, 9, 0, 0)]);
    });

    it("跨夏令时切换的每周事件保持本地墙上时间", () => {
        const zone = "Europe/Berlin";
        const events = parseIcs(
            cal(
                vevent(
                    "UID:dst-1",
                    "SUMMARY:柏林周会",
                    "DTSTART;TZID=Europe/Berlin:20250320T090000",
                    "DTEND;TZID=Europe/Berlin:20250320T100000",
                    "RRULE:FREQ=WEEKLY;COUNT=4",
                ),
            ),
            { calendarId: "cal-1", defaultTimeZone: zone },
        );
        const list = expandEvents(events, {
            windowStart: Date.UTC(2025, 2, 1),
            windowEnd: Date.UTC(2025, 4, 1),
            timeZone: zone,
        });
        expect(list.map((item) => item.start)).toEqual([
            zonedTimeToTs(2025, 3, 20, 9, 0, 0, zone),
            zonedTimeToTs(2025, 3, 27, 9, 0, 0, zone),
            zonedTimeToTs(2025, 4, 3, 9, 0, 0, zone),
            zonedTimeToTs(2025, 4, 10, 9, 0, 0, zone),
        ]);
        // 3/30 起进入夏令时：UTC 时间相应前移 1 小时，本地时间仍是 09:00
        expect(list[2].start - list[1].start).toBe(7 * MS_DAY - 60 * MS_MINUTE);
    });

    it("非重复事件按窗口求交，0 长度事件占 1ms 不会被丢弃", () => {
        const point = parseIcs(
            cal(vevent("UID:point-1", "SUMMARY:点事件", "DTSTART:20250108T090000Z")),
            { calendarId: "cal-1", defaultTimeZone: TZ },
        );
        expect(point[0].start).toBe(point[0].end);
        // 窗口起点正好落在事件上
        expect(expand(point, Date.UTC(2025, 0, 8, 9, 0, 0), Date.UTC(2025, 0, 8, 10, 0, 0))).toHaveLength(1);
        // 窗口终点是开区间，事件恰好落在终点之外
        expect(expand(point, Date.UTC(2025, 0, 8, 8, 0, 0), Date.UTC(2025, 0, 8, 9, 0, 0))).toEqual([]);
        // 完全不重叠
        expect(expand(point, Date.UTC(2025, 1, 1), Date.UTC(2025, 1, 2))).toEqual([]);
    });

    it("全天重复事件按整日展开", () => {
        const events = parseIcs(
            cal(
                vevent(
                    "UID:allday-recur",
                    "SUMMARY:每周全天",
                    "DTSTART;VALUE=DATE:20250106",
                    "DTEND;VALUE=DATE:20250107",
                    "RRULE:FREQ=WEEKLY;COUNT=3",
                ),
            ),
            { calendarId: "cal-1", defaultTimeZone: TZ },
        );
        const list = expand(events, WINDOW_START, WINDOW_END);
        expect(list.map((item) => item.start)).toEqual([
            dateKeyToTs("2025-01-06", TZ),
            dateKeyToTs("2025-01-13", TZ),
            dateKeyToTs("2025-01-20", TZ),
        ]);
        expect(list.every((item) => item.allDay && item.end - item.start === MS_DAY)).toBe(true);
    });

    it("maxInstances 限制实例数量", () => {
        const events = parseIcs(
            cal(vevent("UID:daily-1", "SUMMARY:每日", "DTSTART:20250101T090000Z", "RRULE:FREQ=DAILY")),
            { calendarId: "cal-1", defaultTimeZone: TZ },
        );
        const list = expand(events, Date.UTC(2025, 0, 1), Date.UTC(2025, 11, 31), 10);
        expect(list).toHaveLength(10);
    });

    it("不修改入参数组及其对象", () => {
        const events = parseIcs(
            cal(
                vevent(
                    "UID:clone-1",
                    "SUMMARY:克隆",
                    "DTSTART:20250108T090000Z",
                    "DTEND:20250108T100000Z",
                    "RRULE:FREQ=WEEKLY;COUNT=3",
                ),
            ),
            { calendarId: "cal-1", defaultTimeZone: TZ },
        );
        const snapshot = JSON.stringify(events);
        const list = expand(events, WINDOW_START, WINDOW_END);
        expect(JSON.stringify(events)).toBe(snapshot);
        expect(events[0].isRecurringInstance).toBeUndefined();
        expect(list).toHaveLength(3);
        expect(list[0]).not.toBe(events[0]);
        expect(list[1]).not.toBe(list[0]);
        // 修改克隆对象不会影响入参
        list[0].title = "被改掉了";
        list[0].categories?.push("x");
        expect(events[0].title).toBe("克隆");
        expect(JSON.stringify(events)).toBe(snapshot);
    });
});

describe("buildIcs", () => {
    it("生成规范的 VCALENDAR（CRLF / VERSION / CALSCALE / PRODID）", () => {
        const event: CalendarEvent = {
            uid: "build-1",
            calendar: "cal-1",
            sourceKind: "caldav",
            title: "构建测试",
            start: zonedTimeToTs(2025, 1, 8, 9, 0, 0, TZ),
            end: zonedTimeToTs(2025, 1, 8, 10, 0, 0, TZ),
            allDay: false,
            tzid: TZ,
        };
        const ics = buildIcs(event);
        expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
        expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
        expect(ics).toContain("VERSION:2.0\r\n");
        expect(ics).toContain("CALSCALE:GREGORIAN\r\n");
        expect(ics).toContain("PRODID:-//siyuan-plugin-calendar-caldav//NONSGML v1.0//EN\r\n");
        expect(ics).toContain("DTSTART;TZID=Asia/Shanghai:20250108T090000\r\n");
        expect(ics).toContain("DTEND;TZID=Asia/Shanghai:20250108T100000\r\n");
        expect(ics).toContain("BEGIN:VTIMEZONE\r\n");
        expect(ics).not.toContain("\n\n");
    });

    it("全天事件使用 VALUE=DATE，支持关闭 VTIMEZONE", () => {
        const event: CalendarEvent = {
            uid: "build-2",
            calendar: "cal-1",
            sourceKind: "caldav",
            title: "全天",
            start: dateKeyToTs("2025-01-08", TZ),
            end: dateKeyToTs("2025-01-11", TZ),
            allDay: true,
            hasEndDate: true,
            tzid: TZ,
        };
        const ics = buildIcs(event, { includeTimezone: false, sequence: 3, prodid: "-//x//EN" });
        expect(ics).toContain("DTSTART;VALUE=DATE:20250108\r\n");
        expect(ics).toContain("DTEND;VALUE=DATE:20250111\r\n");
        expect(ics).toContain("SEQUENCE:3\r\n");
        expect(ics).toContain("PRODID:-//x//EN\r\n");
        expect(ics).not.toContain("VTIMEZONE");
    });

    it("输出提醒 / 参与人 / 重复规则", () => {
        const event: CalendarEvent = {
            uid: "build-3",
            calendar: "cal-1",
            sourceKind: "caldav",
            title: "提醒",
            start: Date.UTC(2025, 0, 8, 9, 0, 0),
            end: Date.UTC(2025, 0, 8, 10, 0, 0),
            allDay: false,
            rrule: "FREQ=WEEKLY;COUNT=4",
            categories: ["工作", "重要"],
            status: "CONFIRMED",
            transparency: "OPAQUE",
            cls: "PUBLIC",
            url: "https://example.com/e/3",
            organizer: { cn: "Boss", mailto: "boss@example.com" },
            attendees: [{ cn: "Zhang San", mailto: "zhang@example.com", partstat: "ACCEPTED", role: "REQ-PARTICIPANT" }],
            alarms: [{ trigger: -15 * 60_000, action: "DISPLAY", description: "提醒" }],
        };
        const ics = buildIcs(event);
        const plain = unfold(ics);
        expect(plain).toContain("RRULE:FREQ=WEEKLY;COUNT=4\r\n");
        expect(plain).toContain("CATEGORIES:工作,重要\r\n");
        expect(plain).toContain("STATUS:CONFIRMED\r\n");
        expect(plain).toContain("TRANSP:OPAQUE\r\n");
        expect(plain).toContain("CLASS:PUBLIC\r\n");
        expect(plain).toContain("URL:https://example.com/e/3\r\n");
        expect(plain).toContain("ORGANIZER;CN=Boss:mailto:boss@example.com\r\n");
        expect(plain).toContain("ATTENDEE;CN=Zhang San;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:zhang@example.com\r\n");
        expect(plain).toContain("BEGIN:VALARM\r\n");
        expect(plain).toContain("TRIGGER:-PT15M\r\n");
        expect(plain).toContain("DTSTART:20250108T090000Z\r\n");
    });

    it("超过 75 octets 的 CJK SUMMARY 按字节折行且不切断多字节字符", () => {
        const title = "日历".repeat(30); // 60 个汉字 = 180 octets
        const event: CalendarEvent = {
            uid: "fold-1",
            calendar: "cal-1",
            sourceKind: "caldav",
            title,
            start: Date.UTC(2025, 0, 8, 9, 0, 0),
            end: Date.UTC(2025, 0, 8, 10, 0, 0),
            allDay: false,
        };
        const ics = buildIcs(event);
        const encoder = new TextEncoder();
        const rawLines = ics.slice(0, -2).split("\r\n");
        for (const line of rawLines) {
            expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
        }
        const summaryLines = rawLines.filter((line, index) => line.startsWith("SUMMARY") || (index > 0 && rawLines[index - 1].startsWith("SUMMARY")));
        expect(summaryLines.length).toBeGreaterThan(1);
        for (const line of summaryLines.slice(1)) {
            expect(line.startsWith(" ")).toBe(true);
        }
        // 折行后仍能完整解析出原文
        const parsed = parseOne(ics);
        expect(parsed.title).toBe(title);
    });

    it("无夏令时时区只生成一个 STANDARD 观测项", () => {
        const event: CalendarEvent = {
            uid: "build-tz-std",
            calendar: "cal-1",
            sourceKind: "caldav",
            title: "上海",
            start: zonedTimeToTs(2025, 1, 8, 9, 0, 0, TZ),
            end: zonedTimeToTs(2025, 1, 8, 10, 0, 0, TZ),
            allDay: false,
            tzid: TZ,
        };
        const ics = buildIcs(event);
        expect(ics).toContain("BEGIN:STANDARD\r\n");
        expect(ics).not.toContain("BEGIN:DAYLIGHT");
        expect(ics).toContain("TZOFFSETFROM:+0800\r\n");
        expect(ics).toContain("TZOFFSETTO:+0800\r\n");
    });

    it("有夏令时的时区生成 STANDARD + DAYLIGHT 观测项并保持往返", () => {
        const zone = "Europe/Berlin";
        const event: CalendarEvent = {
            uid: "build-tz-dst",
            calendar: "cal-1",
            sourceKind: "caldav",
            title: "柏林",
            start: zonedTimeToTs(2025, 7, 8, 9, 0, 0, zone),
            end: zonedTimeToTs(2025, 7, 8, 10, 30, 0, zone),
            allDay: false,
            tzid: zone,
        };
        const ics = buildIcs(event);
        expect(ics).toContain("TZID:Europe/Berlin\r\n");
        expect(ics).toContain("BEGIN:DAYLIGHT\r\n");
        expect(ics).toContain("BEGIN:STANDARD\r\n");
        expect(ics).toContain("TZOFFSETTO:+0200\r\n");
        expect(ics).toContain("TZOFFSETTO:+0100\r\n");
        expect(ics).toContain("DTSTART;TZID=Europe/Berlin:20250708T090000\r\n");
        const parsed = parseIcs(ics, { calendarId: "cal-1", defaultTimeZone: "UTC" });
        expect(parsed).toHaveLength(1);
        expect(parsed[0].start).toBe(event.start);
        expect(parsed[0].end).toBe(event.end);
        expect(parsed[0].tzid).toBe(zone);
    });

    it("buildIcs → parseIcs 往返保持 start/end/allDay/title", () => {
        const timed: CalendarEvent = {
            uid: "round-1",
            calendar: "cal-1",
            sourceKind: "caldav",
            title: "往返：定时",
            description: "描述\n第二行",
            location: "会议室",
            start: zonedTimeToTs(2025, 3, 8, 9, 30, 0, TZ),
            end: zonedTimeToTs(2025, 3, 8, 11, 0, 0, TZ),
            allDay: false,
            tzid: TZ,
        };
        const parsedTimed = parseOne(buildIcs(timed));
        expect(parsedTimed.start).toBe(timed.start);
        expect(parsedTimed.end).toBe(timed.end);
        expect(parsedTimed.allDay).toBe(false);
        expect(parsedTimed.title).toBe(timed.title);
        expect(parsedTimed.description).toBe(timed.description);
        expect(parsedTimed.location).toBe(timed.location);
        expect(parsedTimed.tzid).toBe(TZ);

        const allDay: CalendarEvent = {
            uid: "round-2",
            calendar: "cal-1",
            sourceKind: "caldav",
            title: "往返：全天",
            start: dateKeyToTs("2025-01-08", TZ),
            end: dateKeyToTs("2025-01-10", TZ),
            allDay: true,
            hasEndDate: true,
            tzid: TZ,
        };
        const parsedAllDay = parseOne(buildIcs(allDay));
        expect(parsedAllDay.start).toBe(allDay.start);
        expect(parsedAllDay.end).toBe(allDay.end);
        expect(parsedAllDay.allDay).toBe(true);
        expect(parsedAllDay.hasEndDate).toBe(true);
        expect(parsedAllDay.title).toBe(allDay.title);

        const utc: CalendarEvent = {
            uid: "round-3",
            calendar: "cal-1",
            sourceKind: "caldav",
            title: "round utc",
            start: Date.UTC(2025, 5, 1, 0, 0, 0),
            end: Date.UTC(2025, 5, 1, 1, 0, 0),
            allDay: false,
        };
        const parsedUtc = parseOne(buildIcs(utc));
        expect(parsedUtc.start).toBe(utc.start);
        expect(parsedUtc.end).toBe(utc.end);
        expect(parsedUtc.title).toBe(utc.title);
    });

    it("本地时区（未显式给出 tzid）的全天事件也能往返", () => {
        const zone = getLocalTimeZone();
        const event: CalendarEvent = {
            uid: "round-4",
            calendar: "cal-1",
            sourceKind: "caldav",
            title: "本地全天",
            start: dateKeyToTs("2025-02-03", zone),
            end: dateKeyToTs("2025-02-04", zone),
            allDay: true,
            hasEndDate: true,
        };
        const parsed = parseIcs(buildIcs(event), { calendarId: "cal-1", defaultTimeZone: zone });
        expect(parsed[0].start).toBe(event.start);
        expect(parsed[0].end).toBe(event.end);
        expect(parsed[0].allDay).toBe(true);
    });
});

describe("eventHash", () => {
    const base: CalendarEvent = {
        uid: "hash-1",
        calendar: "cal-1",
        sourceKind: "caldav",
        title: "哈希",
        start: Date.UTC(2025, 0, 8, 9, 0, 0),
        end: Date.UTC(2025, 0, 8, 10, 0, 0),
        allDay: false,
    };

    it("稳定且忽略易变字段", () => {
        const a = eventHash(base);
        const b = eventHash({ ...base, lastModified: Date.now(), created: 1, calendar: "other" });
        expect(a).toBe(b);
        expect(a).toBe(eventHash({ ...base }));
        expect(a.length).toBeGreaterThan(0);
    });

    it("随内容变化", () => {
        expect(eventHash(base)).not.toBe(eventHash({ ...base, title: "改" }));
        expect(eventHash(base)).not.toBe(eventHash({ ...base, start: base.start + 1 }));
        expect(eventHash(base)).not.toBe(eventHash({ ...base, allDay: true }));
        expect(eventHash(base)).not.toBe(eventHash({ ...base, rrule: "FREQ=DAILY" }));
        expect(eventHash(base)).not.toBe(eventHash({ ...base, attendees: [{ cn: "A" }] }));
    });
});
