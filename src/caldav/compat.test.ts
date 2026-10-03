import { beforeEach, describe, expect, it } from "vitest";
import { CalDavClient, normalizeEtag, quoteEtag } from "./client";
import { CalDavSourceAdapter } from "./adapter";
import { parseIcs, buildIcs, isTodoEvent } from "./ics";
import { resetKernelMock, responder } from "../__mocks__/siyuan";
import { dateKey } from "../util/date";

/** 与 client.test.ts 一致：还原 base64 请求体（不依赖 Node Buffer） */
function decodeBase64(value: string): string {
    if (!value) {
        return "";
    }
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const clean = value.replace(/[^A-Za-z0-9+/]/g, "");
    let output = "";
    let buffer = 0;
    let bits = 0;
    for (const char of clean) {
        const index = alphabet.indexOf(char);
        if (index < 0) {
            continue;
        }
        buffer = (buffer << 6) | index;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            output += String.fromCharCode((buffer >> bits) & 0xff);
        }
    }
    try {
        return decodeURIComponent(escape(output));
    } catch {
        return output;
    }
}

/**
 * 「多应用兼容」回归集。
 *
 * 每一条都对应一种**真实存在**的 CalDAV 实现差异，而不是凭空构造：
 * - 空 multistatus（Vikunja 类实现：REPORT 不返回事件，只能 PROPFIND 枚举）；
 * - 只给 ETag 不给正文（企业微信实测）；
 * - 不认 time-range（须退回无过滤的查询）；
 * - 自定义 TZID（TZ08 / Xmail Custome Time）；
 * - BOM、非 CRLF 换行、裸 VEVENT；
 * - ETag 的 W/ 前缀、引号、尾随空格。
 */

const account = {
    id: "acct_compat",
    name: "兼容测试",
    serverUrl: "https://dav.example.com/dav/",
    username: "alice",
    password: "secret",
    enabled: true,
};

function client(): CalDavClient {
    return new CalDavClient({
        account,
        credentials: { username: account.username, secret: account.password, authType: "basic" },
        timeoutMs: 5000,
    });
}

const CAL_URL = "https://dav.example.com/dav/calendars/alice/work/";

const EVENT_ICS = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Compat//EN",
    "BEGIN:VTIMEZONE",
    "TZID:TZ08",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:compat-1",
    "DTSTAMP:20260101T000000Z",
    "DTSTART;TZID=TZ08:20261004T100000",
    "DTEND;TZID=TZ08:20261004T110000",
    "SUMMARY:兼容测试日程",
    "RRULE:FREQ=DAILY;COUNT=2",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
].join("\r\n");

const EMPTY_MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"/>`;

const ETAG_ONLY_MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/dav/calendars/alice/work/compat-1.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"etag-1"</d:getetag></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

const PROPFIND_LIST = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/calendars/alice/work/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/calendars/alice/work/compat-1.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"etag-1"</d:getetag></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

function mockFetch(overrides: Record<string, () => unknown> = {}): string[] {
    const calls: string[] = [];
    responder.current = (_endpoint, payload) => {
        const record = payload as { method?: string; url?: string; payload?: string };
        const xml = decodeBase64(String(record.payload ?? ""));
        const method = String(record.method ?? "");
        const kind = xml.includes("calendar-multiget")
            ? "MULTIGET"
            : xml.includes("calendar-query")
              ? "QUERY"
              : xml.includes("propfind")
                ? "PROPFIND"
                : "";
        calls.push(`${method}${kind ? `:${kind}` : ""}`);
        const key = `${method}:${kind}`;
        const handler = overrides[key];
        if (handler) {
            return handler();
        }
        return { code: 0, msg: "", data: { status: 207, body: EMPTY_MULTISTATUS, bodyEncoding: "text", headers: {} } };
    };
    return calls;
}

function adapter(): CalDavSourceAdapter {
    return new CalDavSourceAdapter({
        accountId: account.id,
        calendar: { url: CAL_URL, readOnly: false, components: ["VEVENT"] },
        info: {
            id: `caldav:${account.id}:work`,
            name: "work",
            source: { kind: "caldav", accountId: account.id, calendarUrl: CAL_URL },
        },
        client: () => client(),
        zone: "Asia/Shanghai",
    });
}

beforeEach(() => {
    resetKernelMock();
});

describe("ETag 归一化", () => {
    it("去掉引号、W/ 前缀与元素内空白", () => {
        expect(normalizeEtag('"abc"')).toBe("abc");
        expect(normalizeEtag("abc")).toBe("abc");
        expect(normalizeEtag('W/"abc"')).toBe("abc");
        expect(normalizeEtag(" 1791041436 ")).toBe("1791041436");
        expect(normalizeEtag("")).toBeUndefined();
        expect(normalizeEtag(undefined)).toBeUndefined();
    });

    it("发回服务端时还原为强校验形式", () => {
        expect(quoteEtag("abc")).toBe('"abc"');
        expect(quoteEtag('"abc"')).toBe('"abc"');
        expect(quoteEtag(undefined)).toBeUndefined();
    });
});

describe("多应用兼容：事件拉取", () => {
    it("REPORT 返回空 multistatus 时，退回 PROPFIND 枚举再取正文", async () => {
        const calls = mockFetch({
            "REPORT:QUERY": () => ({
                code: 0,
                msg: "",
                data: { status: 207, body: EMPTY_MULTISTATUS, bodyEncoding: "text", headers: {} },
            }),
            "PROPFIND:PROPFIND": () => ({
                code: 0,
                msg: "",
                data: { status: 207, body: PROPFIND_LIST, bodyEncoding: "text", headers: {} },
            }),
            "REPORT:MULTIGET": () => ({
                code: 0,
                msg: "",
                data: {
                    status: 207,
                    body: `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/dav/calendars/alice/work/compat-1.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"etag-1"</d:getetag><c:calendar-data>${EVENT_ICS.replace(/\r\n/g, "&#x0D;&#x0A;")}</c:calendar-data></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`,
                    bodyEncoding: "text",
                    headers: {},
                },
            }),
        });

        const result = await adapter().loadResource(Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
        expect(calls).toContain("PROPFIND:PROPFIND");
        // 通过 PROPFIND 枚举到的资源最终解析出事件
        expect(result.events.length).toBeGreaterThan(0);
        expect(result.events[0].title).toBe("兼容测试日程");
    });

    it("服务端拒绝带 time-range 的查询时，自动改用无过滤查询", async () => {
        let querySeen = 0;
        const calls = mockFetch({
            "REPORT:QUERY": () => {
                querySeen++;
                // 第一次（带 time-range）拒绝，第二次（不带）成功
                if (querySeen === 1) {
                    return { code: 0, msg: "", data: { status: 400, body: "", bodyEncoding: "text", headers: {} } };
                }
                return {
                    code: 0,
                    msg: "",
                    data: {
                        status: 207,
                        body: `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/dav/calendars/alice/work/compat-1.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"etag-1"</d:getetag><c:calendar-data>${EVENT_ICS.replace(/\r\n/g, "&#x0D;&#x0A;")}</c:calendar-data></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`,
                        bodyEncoding: "text",
                        headers: {},
                    },
                };
            },
        });

        const result = await adapter().loadResource(Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
        expect(calls.filter((item) => item === "REPORT:QUERY").length).toBeGreaterThanOrEqual(2);
        expect(result.events.map((event) => event.title)).toContain("兼容测试日程");
    });

    it("只给 ETag 不给正文时，multiget 不受支持则逐条 GET 补齐", async () => {
        const calls = mockFetch({
            "REPORT:QUERY": () => ({
                code: 0,
                msg: "",
                data: { status: 207, body: ETAG_ONLY_MULTISTATUS, bodyEncoding: "text", headers: {} },
            }),
            "REPORT:MULTIGET": () => ({
                code: 0,
                msg: "",
                data: { status: 400, body: "", bodyEncoding: "text", headers: {} },
            }),
            "GET:": () => ({
                code: 0,
                msg: "",
                data: { status: 200, body: EVENT_ICS, bodyEncoding: "text", headers: { ETag: ['"etag-1"'] } },
            }),
        });

        const result = await adapter().loadResource(Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
        expect(calls).toContain("GET");
        expect(result.events[0].title).toBe("兼容测试日程");
        expect(result.events[0].start).toBe(Date.UTC(2026, 9, 4, 2));
    });
});

describe("多应用兼容：VTODO（任务型服务端，如 Vikunja）", () => {
    /** Vikunja 风格的 VTODO：只有 DUE、PERCENT-COMPLETE、STATUS，没有 VEVENT */
    const TODO_ICS = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Vikunja//CalDAV//EN",
        "BEGIN:VTODO",
        "UID:2757509497386878722",
        "DTSTAMP:20260101T000000Z",
        "DUE;TZID=TZ08:20261006T180000",
        "SUMMARY:交季度报告",
        "DESCRIPTION:整理数据并提交",
        "STATUS:NEEDS-ACTION",
        "PERCENT-COMPLETE:40",
        "CATEGORIES:工作",
        "END:VTODO",
        "END:VCALENDAR",
        "",
    ].join("\r\n");

    it("VTODO 被解析成条目，DUE 作为时间点，时区按 TZOFFSETTO 换算", () => {
        const events = parseIcs(TODO_ICS, {
            calendarId: "c1",
            sourceKind: "caldav",
            defaultTimeZone: "UTC",
        });
        expect(events).toHaveLength(1);
        expect(events[0].title).toBe("交季度报告");
        expect(events[0].uid).toBe("2757509497386878722");
        expect(events[0].start).toBe(Date.UTC(2026, 9, 6, 10));
        expect(isTodoEvent(events[0])).toBe(true);
        expect(events[0].categories).toEqual(["工作"]);
    });

    it("VTODO 只有 DTSTART（无 DUE）时也能定位", () => {
        const ics = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "BEGIN:VTODO",
            "UID:todo-2",
            "DTSTAMP:20260101T000000Z",
            "DTSTART:20261007T010000Z",
            "SUMMARY:只有开始时间",
            "END:VTODO",
            "END:VCALENDAR",
            "",
        ].join("\r\n");
        const events = parseIcs(ics, { calendarId: "c1", sourceKind: "caldav", defaultTimeZone: "UTC" });
        expect(events).toHaveLength(1);
        expect(events[0].start).toBe(Date.UTC(2026, 9, 7, 1));
    });

    it("写回时仍生成 VTODO（不会被改写成 VEVENT）", () => {
        const events = parseIcs(TODO_ICS, { calendarId: "c1", sourceKind: "caldav", defaultTimeZone: "Asia/Shanghai" });
        const ics = buildIcs(events[0]);
        expect(ics).toContain("BEGIN:VTODO");
        expect(ics).toContain("DUE");
        expect(ics).not.toContain("BEGIN:VEVENT");
        expect(ics).not.toContain("DTEND");
        // STATUS 必须落在 VTODO 的取值域内
        expect(ics).toMatch(/STATUS:(IN-PROCESS|COMPLETED|CANCELLED|NEEDS-ACTION)/);

        // 往返一致：再解析回来仍是同一条任务
        const again = parseIcs(ics, { calendarId: "c1", sourceKind: "caldav", defaultTimeZone: "Asia/Shanghai" });
        expect(again).toHaveLength(1);
        expect(again[0].uid).toBe("2757509497386878722");
        expect(again[0].title).toBe("交季度报告");
    });

    it("VTODO 与 VEVENT 混在同一个日历里时都被解析", () => {
        const mixed = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "BEGIN:VTODO",
            "UID:t1",
            "DUE:20261008T000000Z",
            "SUMMARY:任务",
            "END:VTODO",
            "BEGIN:VEVENT",
            "UID:e1",
            "DTSTART:20261008T020000Z",
            "DTEND:20261008T030000Z",
            "SUMMARY:事件",
            "END:VEVENT",
            "END:VCALENDAR",
            "",
        ].join("\r\n");
        const events = parseIcs(mixed, { calendarId: "c1", sourceKind: "caldav", defaultTimeZone: "UTC" });
        expect([...events.map((event) => event.title)].sort()).toEqual(["事件", "任务"]);
        expect(events.filter(isTodoEvent)).toHaveLength(1);
    });

    it("服务端只支持 VTODO 时，会继续尝试带 VTODO 的变体并拿到内容", async () => {
        const bodies: string[] = [];
        const empty = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"/>`;
        responder.current = (_endpoint, payload) => {
            const record = payload as { method?: string; payload?: string };
            const xml = decodeBase64(String(record.payload ?? ""));
            if (record.method === "REPORT" && xml.includes("calendar-query")) {
                bodies.push(xml);
                // 任务型服务端：只对带 VTODO 的过滤器返回资源（复刻真实行为）
                const body = xml.includes('name="VTODO"')
                    ? `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/dav/projects/3/2757509497386878722.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"7-1"</d:getetag><c:calendar-data>${TODO_ICS.replace(/\r\n/g, "&#x0D;&#x0A;")}</c:calendar-data></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`
                    : empty;
                return { code: 0, msg: "", data: { status: 207, body, bodyEncoding: "text", headers: {} } };
            }
            return { code: 0, msg: "", data: { status: 207, body: empty, bodyEncoding: "text", headers: {} } };
        };

        const result = await client().fetchEvents(
            { url: "https://vikunja.example.com/api/v1/dav/projects/3", readOnly: false, components: ["VTODO"] },
            Date.UTC(2026, 9, 1),
            Date.UTC(2026, 10, 1),
        );
        // 必须至少发出一个带 VTODO 的查询，并且最终拿到正文
        expect(bodies.some((xml) => xml.includes('name="VTODO"'))).toBe(true);
        expect(result.resources).toHaveLength(1);
        expect(result.hasContent).toBe(true);
    });
});

describe("多应用兼容：href 不含挂载前缀（Vikunja 挂在 /api/v1/dav）", () => {
    it("把根相对的 /dav/... 重新挂到账户基地址下", async () => {
        const calls: string[] = [];
        const vikunjaClient = new CalDavClient({
            account: {
                id: "acct_v",
                name: "Vikunja",
                serverUrl: "https://vikunja.example.com/api/v1/dav/principals/alice/",
                username: "alice",
                password: "token",
                enabled: true,
            },
            credentials: { username: "alice", secret: "token", authType: "basic" },
            timeoutMs: 5000,
        });
        responder.current = (_endpoint, payload) => {
            const record = payload as { method?: string; url?: string; payload?: string };
            const xml = decodeBase64(String(record.payload ?? ""));
            calls.push(`${record.method} ${record.url}`);
            if (record.method === "REPORT" && xml.includes("calendar-query")) {
                return {
                    code: 0,
                    msg: "",
                    data: {
                        status: 207,
                        body: `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/dav/projects/3/2757509497386878722.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"7-1"</d:getetag></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`,
                        bodyEncoding: "text",
                        headers: {},
                    },
                };
            }
            if (record.method === "GET") {
                return {
                    code: 0,
                    msg: "",
                    data: {
                        status: 200,
                        body: [
                            "BEGIN:VCALENDAR",
                            "VERSION:2.0",
                            "BEGIN:VTODO",
                            "UID:2757509497386878722",
                            "DUE:20261009T000000Z",
                            "SUMMARY:补前缀任务",
                            "END:VTODO",
                            "END:VCALENDAR",
                            "",
                        ].join("\r\n"),
                        bodyEncoding: "text",
                        headers: {},
                    },
                };
            }
            return { code: 0, msg: "", data: { status: 404, body: "", bodyEncoding: "text", headers: {} } };
        };

        const result = await vikunjaClient.fetchEvents(
            { url: "https://vikunja.example.com/api/v1/dav/projects/3", readOnly: false, components: ["VTODO"] },
            Date.UTC(2026, 9, 1),
            Date.UTC(2026, 10, 1),
        );
        // href 必须被补上 /api/v1 前缀，否则后续 GET 会 404
        expect(result.resources[0].href).toBe(
            "https://vikunja.example.com/api/v1/dav/projects/3/2757509497386878722.ics",
        );
    });

    it("已带挂载前缀的 href 不会被重复拼接", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: {
                status: 207,
                body: `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/api/v1/dav/projects/3/a.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"1"</d:getetag></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`,
                bodyEncoding: "text",
                headers: {},
            },
        });
        const vikunjaClient = new CalDavClient({
            account: {
                id: "acct_v",
                name: "Vikunja",
                serverUrl: "https://vikunja.example.com/api/v1/dav/",
                username: "alice",
                password: "token",
                enabled: true,
            },
            credentials: { username: "alice", secret: "token", authType: "basic" },
            timeoutMs: 5000,
        });
        const result = await vikunjaClient.fetchEvents(
            { url: "https://vikunja.example.com/api/v1/dav/projects/3", readOnly: false, components: ["VTODO"] },
            Date.UTC(2026, 9, 1),
            Date.UTC(2026, 10, 1),
        );
        expect(result.resources[0].href).toBe("https://vikunja.example.com/api/v1/dav/projects/3/a.ics");
    });
});

describe("多应用兼容：iCalendar 格式差异", () => {
    it("非 IANA 的 TZID 用文档自带 TZOFFSETTO 换算（不按本机时区猜）", () => {
        const events = parseIcs(EVENT_ICS, {
            calendarId: "c1",
            sourceKind: "caldav",
            defaultTimeZone: "America/New_York",
        });
        expect(events).toHaveLength(1);
        // TZ08 = +0800 → 10:00 本地 = 02:00 UTC（若误用本机时区会差 12 小时）
        expect(events[0].start).toBe(Date.UTC(2026, 9, 4, 2));
        expect(events[0].end).toBe(Date.UTC(2026, 9, 4, 3));
    });

    it("带 BOM、用 LF 换行、缺 PRODID 也能解析", () => {
        const raw = EVENT_ICS.replace(/\r\n/g, "\n").replace("PRODID:-//Compat//EN\n", "");
        const events = parseIcs(`\uFEFF${raw}`, {
            calendarId: "c1",
            sourceKind: "caldav",
            defaultTimeZone: "Asia/Shanghai",
        });
        expect(events).toHaveLength(1);
        expect(events[0].title).toBe("兼容测试日程");
    });

    it("裸 VEVENT（没有 VCALENDAR 外壳）也能解析", () => {
        const bare = [
            "BEGIN:VEVENT",
            "UID:bare-1",
            "DTSTAMP:20260101T000000Z",
            "DTSTART:20261005T010000Z",
            "DTEND:20261005T020000Z",
            "SUMMARY:裸事件",
            "END:VEVENT",
        ].join("\r\n");
        const events = parseIcs(bare, {
            calendarId: "c1",
            sourceKind: "caldav",
            defaultTimeZone: "Asia/Shanghai",
        });
        expect(events).toHaveLength(1);
        expect(events[0].title).toBe("裸事件");
        expect(events[0].start).toBe(Date.UTC(2026, 9, 5, 1));
    });

    it("ICS 前后有噪声文本时仍能截取 VCALENDAR 段", () => {
        const noisy = `some wrapper text\n${EVENT_ICS.trim()}\ntrailing garbage`;
        const events = parseIcs(noisy, {
            calendarId: "c1",
            sourceKind: "caldav",
            defaultTimeZone: "Asia/Shanghai",
        });
        expect(events).toHaveLength(1);
        expect(events[0].title).toBe("兼容测试日程");
    });

    it("TZID 为常见但非 IANA 的 CST8 时按 +0800 处理", () => {
        const ics = EVENT_ICS.replace(/TZ08/g, "CST8");
        const events = parseIcs(ics, {
            calendarId: "c1",
            sourceKind: "caldav",
            defaultTimeZone: "UTC",
        });
        expect(events[0].start).toBe(Date.UTC(2026, 9, 4, 2));
    });

    it("重复规则实例落在正确日期（跨时区一致性）", async () => {
        const events = parseIcs(EVENT_ICS, {
            calendarId: "c1",
            sourceKind: "caldav",
            defaultTimeZone: "Asia/Shanghai",
        });
        const { expandEvents } = await import("./ics");
        const instances = expandEvents(events, {
            windowStart: Date.UTC(2026, 9, 1),
            windowEnd: Date.UTC(2026, 9, 10),
            timeZone: "Asia/Shanghai",
        });
        expect(instances.map((event) => dateKey(event.start, "Asia/Shanghai"))).toEqual([
            "2026-10-04",
            "2026-10-05",
        ]);
    });
});
