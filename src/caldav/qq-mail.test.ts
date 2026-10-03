import { beforeEach, describe, expect, it } from "vitest";
import { CalDavClient } from "./client";
import { expandEvents, parseIcs } from "./ics";
import { resetKernelMock, responder } from "../__mocks__/siyuan";
import { dateKey } from "../util/date";

/**
 * QQ 邮箱（dav.qq.com）端到端回归。
 *
 * 该服务的两个「坑」都在这里锁住：
 * 1. `calendar-data` 用 XML 字符实体编码换行（`&#x0D;&#x0A;`），不解码则整份 ICS 变成一行 → 0 事件；
 * 2. 事件是「生日」这类**多年前开始、每年重复**的全天事件，
 *    必须正确展开 RRULE 才能在当月日历里看到实例。
 */

const COLLECTION_ID = "F23EXAMPLEopaque~i~8zRqAQAS";
const COLLECTION_URL = `https://dav.qq.com/calendar/${COLLECTION_ID}/`;

/** 取自真实应答：自定义 VTIMEZONE + 实体编码换行 + 年度重复全天事件 */
function qqCalendarData(
    uid: string,
    summary: string,
    startDate: string,
    endDate: string,
    rrule: string,
): string {
    const ics = [
        "BEGIN:VCALENDAR",
        "PRODID:-//Tencent Corporation//XMail",
        "VERSION:2.0",
        "BEGIN:VTIMEZONE",
        "TZID:Xmail Custome Time",
        "BEGIN:STANDARD",
        "DTSTART:19700101T000000Z",
        "TZOFFSETFROM:+0800",
        "TZOFFSETTO:+0800",
        "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:20261003T154436Z",
        `DTSTART;VALUE=DATE:${startDate}`,
        `DTEND;VALUE=DATE:${endDate}`,
        `SUMMARY:${summary}`,
        `RRULE:${rrule}`,
        "END:VEVENT",
        "END:VCALENDAR",
        "",
    ].join("\r\n");
    // 模拟 QQ 的实体编码：换行 → &#x0D;&#x0A;
    return ics.replace(/\r\n/g, "&#x0D;&#x0A;");
}

function qqMultiStatus(entries: Array<{ href: string; etag: string; data: string }>): string {
    const body = entries
        .map(
            (entry) => `
    <A:response>
        <A:href>${entry.href}</A:href>
        <A:propstat>
            <A:prop>
                <A:getetag>${entry.etag}</A:getetag>
                <A:getcontenttype>text/calendar; component=vevent</A:getcontenttype>
                <D:calendar-data>${entry.data}</D:calendar-data>
            </A:prop>
            <A:status>HTTP/1.1 200 OK</A:status>
        </A:propstat>
    </A:response>`,
        )
        .join("");
    return `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<A:multistatus xmlns:A="DAV:" xmlns:D="urn:ietf:params:xml:ns:caldav">${body}
</A:multistatus>`;
}

const account = {
    id: "acct_qq",
    name: "QQ 邮箱",
    serverUrl: "https://dav.qq.com/calendar/",
    username: "user@example.com",
    password: "authcode",
    enabled: true,
};

function client(): CalDavClient {
    return new CalDavClient({
        account,
        credentials: { username: account.username, secret: account.password, authType: "basic" },
        timeoutMs: 5000,
    });
}

beforeEach(() => {
    resetKernelMock();
});

describe("QQ 邮箱 dav.qq.com 端到端", () => {
    const response = qqMultiStatus([
        {
            href: `/calendar/${COLLECTION_ID}/7200000001.ics`,
            etag: "1791042276",
            data: qqCalendarData(
                "7200000001",
                "7200000001生日",
                "19800101",
                "19800102",
                "FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=14;BYMONTH=10",
            ),
        },
        {
            href: `/calendar/${COLLECTION_ID}/1234567890.ics`,
            etag: "1791042277",
            data: qqCalendarData(
                "1234567890",
                "无念生日",
                "20001111",
                "20001112",
                "FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=11;BYMONTH=11",
            ),
        },
    ]);

    it("拉取到的资源带着完整、可解析的 ICS", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 207, body: response, bodyEncoding: "text", headers: {} },
        });
        const objects = await client().fetchEvents(
            { url: COLLECTION_URL, readOnly: false, components: ["VEVENT"] },
            Date.UTC(2026, 0, 1),
            Date.UTC(2027, 0, 1),
        );
        expect(objects.resources).toHaveLength(2);
        for (const resource of objects.resources) {
            expect(resource.ics?.startsWith("BEGIN:VCALENDAR")).toBe(true);
            // 关键：换行必须是真实的 CRLF，而不是实体文本
            expect(resource.ics).toContain("\r\n");
            expect(resource.ics).not.toContain("&#x0D;");
        }
        expect(objects.resources.map((item) => item.uid).sort()).toEqual(["1234567890", "7200000001"]);
    });

    it("多年前开始的全天重复事件能在当前年份展开出实例", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 207, body: response, bodyEncoding: "text", headers: {} },
        });
        const objects = await client().fetchEvents(
            { url: COLLECTION_URL, readOnly: false, components: ["VEVENT"] },
            Date.UTC(2026, 0, 1),
            Date.UTC(2027, 0, 1),
        );
        const events = objects.resources.flatMap((resource) =>
            parseIcs(resource.ics ?? "", {
                calendarId: "caldav:acct_qq:qq",
                sourceKind: "caldav",
                defaultTimeZone: "Asia/Shanghai",
            }),
        );
        expect(events).toHaveLength(2);
        expect(events.every((event) => event.allDay)).toBe(true);

        // 2026 年的生日实例应当出现在 10 月 14 日 / 11 月 11 日
        const windowStart = Date.UTC(2026, 6, 1);
        const windowEnd = Date.UTC(2027, 3, 1);
        const instances = expandEvents(events, {
            windowStart,
            windowEnd,
            timeZone: "Asia/Shanghai",
        });
        const keys = instances.map((event) => dateKey(event.start, "Asia/Shanghai")).sort();
        expect(keys).toEqual(["2026-10-14", "2026-11-11"]);
        expect(instances.every((event) => event.isRecurringInstance)).toBe(true);
        expect(instances.map((event) => event.title).sort()).toEqual(["7200000001生日", "无念生日"].sort());
    });

    it("波浪号（~）在集合 ID 中不会被 URL 编码破坏", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 207, body: response, bodyEncoding: "text", headers: {} },
        });
        const objects = await client().fetchEvents(
            { url: COLLECTION_URL, readOnly: false, components: ["VEVENT"] },
            Date.UTC(2026, 0, 1),
            Date.UTC(2027, 0, 1),
        );
        for (const resource of objects.resources) {
            expect(resource.href).toContain(COLLECTION_ID);
            expect(resource.href).not.toContain("%7E");
        }
    });
});
