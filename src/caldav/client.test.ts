import { beforeEach, describe, expect, it } from "vitest";
import { CalDavClient, CalDavError, calendarId, decodeXmlEntities, parseCalendarId } from "./client";
import { CalDavSourceAdapter } from "./adapter";
import type { CalDavAccount } from "../types";
import { calls, lastCall, resetKernelMock, responder } from "../__mocks__/siyuan";
import { decodeBase64 } from "../util/misc";

const account: CalDavAccount = {
    id: "acct_1",
    name: "Test",
    serverUrl: "https://dav.example.com",
    username: "alice",
    password: "secret",
    enabled: true,
};

function client(): CalDavClient {
    return new CalDavClient({
        account,
        credentials: { username: "alice", secret: "secret", authType: "basic" },
        timeoutMs: 5000,
    });
}

/** 生成 PROPFIND/REPORT 的 multistatus 响应 */
function multiStatus(resources: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">
${resources}
</d:multistatus>`;
}

const PRINCIPAL_RESPONSE = multiStatus(`
  <d:response>
    <d:href>/</d:href>
    <d:propstat>
      <d:prop>
        <d:current-user-principal><d:href>/dav/principals/alice/</d:href></d:current-user-principal>
        <c:calendar-home-set><d:href>/dav/calendars/alice/</d:href></c:calendar-home-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`);

const CALENDAR_LIST_RESPONSE = multiStatus(`
  <d:response>
    <d:href>/dav/calendars/alice/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype><d:displayname>Home</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/calendars/alice/work/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname>Work</d:displayname>
        <ic:calendar-color>#3574F0FF</ic:calendar-color>
        <c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set>
        <d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>
        <cs:getctag>ctag-1</cs:getctag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/calendars/alice/holidays/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname>Holidays</d:displayname>
        <d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`);

beforeEach(() => {
    resetKernelMock();
});

describe("CalDavClient 发现", () => {
    it("解析 principal / calendar-home-set 并列举日历（含只读判定与颜色）", async () => {
        responder.current = (_endpoint, payload) => {
            const body = String((payload as Record<string, unknown>).payload ?? "");
            // 请求体是 base64 编码的 XML
            const xml = body ? decodeBase64(body) : "";
            const isCalendarList = xml.includes("supported-calendar-component-set") && xml.includes("resourcetype");
            const data = isCalendarList ? CALENDAR_LIST_RESPONSE : PRINCIPAL_RESPONSE;
            return { code: 0, msg: "", data: { status: 207, body: data, bodyEncoding: "text", headers: {} } };
        };
        const result = await client().discover();
        expect(result.principalUrl).toBe("https://dav.example.com/dav/principals/alice/");
        expect(result.homeSet).toBe("https://dav.example.com/dav/calendars/alice/");
        expect(result.calendars).toHaveLength(2);
        const work = result.calendars.find((item) => item.displayName === "Work");
        const holidays = result.calendars.find((item) => item.displayName === "Holidays");
        expect(work?.url).toBe("https://dav.example.com/dav/calendars/alice/work/");
        expect(work?.color).toBe("#3574F0");
        expect(work?.readOnly).toBe(false);
        expect(work?.components).toEqual(["VEVENT", "VTODO"]);
        expect(holidays?.readOnly).toBe(true);
    });

    it("认证信息以 Basic 头传出，且 headers 为单键对象数组", async () => {        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 207, body: PRINCIPAL_RESPONSE, bodyEncoding: "text", headers: {} },
        });
        await client().discover().catch(() => undefined);
        const payload = lastCall()?.payload as Record<string, unknown>;
        const headers = payload.headers as Array<Record<string, string>>;
        expect(headers).toContainEqual({ Authorization: `Basic ${btoa("alice:secret")}` });
        expect(headers.some((item) => "Depth" in item)).toBe(true);
    });

    it("HTTP 401 抛出可读的认证错误", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 401, body: "", bodyEncoding: "text", headers: {} },
        });
        await expect(client().discover()).rejects.toBeInstanceOf(CalDavError);
        await expect(client().discover()).rejects.toMatchObject({ status: 401 });
    });
});

describe("CalDavClient 事件读取", () => {    const calendar = {
        url: "https://dav.example.com/dav/calendars/alice/work/",
        displayName: "Work",
        readOnly: false,
        components: ["VEVENT"],
    };

    const REPORT_RESPONSE = multiStatus(`
  <d:response>
    <d:href>/dav/calendars/alice/work/meeting.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-1"</d:getetag>
        <d:getlastmodified>Fri, 03 Jan 2025 04:00:00 GMT</d:getlastmodified>
        <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:meeting-1
SUMMARY:周会
DTSTART:20250103T020000Z
DTEND:20250103T030000Z
END:VEVENT
END:VCALENDAR
</c:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`);

    it("REPORT 查询发送时间区间与 Depth:1，并解析出资源", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 207, body: REPORT_RESPONSE, bodyEncoding: "text", headers: {} },
        });
        const result = await client().fetchEvents(calendar, Date.UTC(2025, 0, 1), Date.UTC(2025, 1, 1));
        expect(result.fullSync).toBe(true);
        expect(result.resources).toHaveLength(1);
        // ETag 会被归一化（去引号/去 W- 前缀），发回服务端时再重新加引号
        expect(result.resources[0].etag).toBe("etag-1");
        expect(result.resources[0].uid).toBe("meeting-1");
        const payload = lastCall()?.payload as Record<string, unknown>;
        const headers = payload.headers as Array<Record<string, string>>;
        expect(headers).toContainEqual({ Depth: "1" });
        expect(payload.method).toBe("REPORT");
        const xml = decodeBase64(String(payload.payload));
        expect(xml).toContain('start="20250101T000000Z"');
        expect(xml).toContain('end="20250201T000000Z"');
        expect(xml).toContain('comp-filter name="VEVENT"');
    });

    it("syncCollection 失败时回退全量查询", async () => {
        const seen: string[] = [];
        responder.current = (_endpoint, payload) => {
            const xml = decodeBase64(String((payload as Record<string, unknown>).payload ?? ""));
            seen.push(xml.includes("sync-collection") ? "sync" : "query");
            if (xml.includes("sync-collection")) {
                return { code: 0, msg: "", data: { status: 403, body: "", bodyEncoding: "text", headers: {} } };
            }
            return { code: 0, msg: "", data: { status: 207, body: REPORT_RESPONSE, bodyEncoding: "text", headers: {} } };
        };
        const result = await client().fetchEvents(calendar, Date.UTC(2025, 0, 1), Date.UTC(2025, 1, 1), "token-1");
        expect(seen).toEqual(["sync", "query"]);
        expect(result.resources).toHaveLength(1);
    });

    it("sync-collection 成功时返回新的 syncToken", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: {
                status: 207,
                body: REPORT_RESPONSE.replace(
                    "</d:multistatus>",
                    "<d:sync-token>token-2</d:sync-token></d:multistatus>",
                ),
                bodyEncoding: "text",
                headers: {},
            },
        });
        const result = await client().fetchEvents(calendar, Date.UTC(2025, 0, 1), Date.UTC(2025, 1, 1), "token-1");
        expect(result.fullSync).toBe(false);
        expect(result.syncToken).toBe("token-2");
    });

    it("日历不可访问时抛出 CalDavError", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 403, body: "", bodyEncoding: "text", headers: {} },
        });
        await expect(
            client().fetchEvents(calendar, Date.UTC(2025, 0, 1), Date.UTC(2025, 1, 1)),
        ).rejects.toMatchObject({ status: 403 });
    });

    it("非法 XML 抛出可诊断的错误而非静默失败", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 207, body: "<<<not xml", bodyEncoding: "text", headers: {} },
        });
        await expect(
            client().fetchEvents(calendar, Date.UTC(2025, 0, 1), Date.UTC(2025, 1, 1)),
        ).rejects.toThrowError(/解析 DAV 响应失败/);
    });
});

describe("CalDavClient 写入", () => {
    const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:new-1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    it("创建事件使用 PUT + If-None-Match，并从响应头取回 ETag", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 201, body: "", bodyEncoding: "text", headers: { ETag: ['"etag-9"'] } },
        });
        const result = await client().createEvent("https://dav.example.com/dav/calendars/alice/work/", "new-1", ICS);
        expect(result.url).toBe("https://dav.example.com/dav/calendars/alice/work/new-1.ics");
        expect(result.etag).toBe('"etag-9"');
        const payload = lastCall()?.payload as Record<string, unknown>;
        expect(payload.method).toBe("PUT");
        expect(String(payload.contentType)).toContain("text/calendar");
        const headers = payload.headers as Array<Record<string, string>>;
        expect(headers).toContainEqual({ "If-None-Match": "*" });
        expect(decodeBase64(String(payload.payload))).toBe(ICS);
    });

    it("UID 中的非法文件名字符会被替换", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 201, body: "", bodyEncoding: "text", headers: {} },
        });
        const result = await client().createEvent("https://dav.example.com/c/", "a/b c:d", ICS);
        expect(result.url).toBe("https://dav.example.com/c/a_b_c_d.ics");
    });

    it("更新事件带 If-Match，412 时抛冲突错误", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 412, body: "", bodyEncoding: "text", headers: {} },
        });
        await expect(
            client().updateEvent("https://dav.example.com/c/e.ics", ICS, '"etag-old"'),
        ).rejects.toMatchObject({ status: 412, name: "CalDavError" });
        const payload = lastCall()?.payload as Record<string, unknown>;
        const headers = payload.headers as Array<Record<string, string>>;
        expect(headers).toContainEqual({ "If-Match": '"etag-old"' });
    });

    it("删除事件遇 404 视为成功（幂等）", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 404, body: "", bodyEncoding: "text", headers: {} },
        });
        await expect(client().deleteEvent("https://dav.example.com/c/gone.ics")).resolves.toBeUndefined();
    });

    it("删除失败时抛出错误", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 500, body: "boom", bodyEncoding: "text", headers: {} },
        });
        await expect(client().deleteEvent("https://dav.example.com/c/e.ics")).rejects.toMatchObject({ status: 500 });
    });
});

describe("不返回 resourcetype 的服务端（QQ 邮箱 dav.qq.com 实测行为）", () => {
    /**
     * 真实响应（PROPFIND depth 0，`/calendar/user%40example.com/`）：
     * 只有 displayname，没有 resourcetype、没有 supported-calendar-component-set；
     * depth 1 枚举不到任何子集合；REPORT calendar-query 返回空 multistatus。
     */
    const QQ_PRINCIPAL = multiStatus(`
  <d:response>
    <d:href>/calendar/</d:href>
    <d:propstat>
      <d:prop>
        <d:current-user-principal><d:href>/calendar/user%40example.com</d:href></d:current-user-principal>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
    <d:propstat>
      <d:prop><d:principal-URL/></d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
  </d:response>`);

    const QQ_USER_COLLECTION = multiStatus(`
  <d:response>
    <d:href>/calendar/user%40example.com/</d:href>
    <d:propstat>
      <d:prop><d:displayname>1234567890&apos;s QQMail Calendars</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`);

    const QQ_EMPTY = multiStatus("");

    function qqResponder(): void {
        // 按调用顺序返回更可靠（与真实 QQ 行为一致）：
        // 1) principal 发现 → 返回 current-user-principal
        // 2) home 探测 → 空（QQ 不返回 calendar-home-set）
        // 3) depth 0/1 探测主目录 → 只有 displayname、无 resourcetype
        // 4) 其余 PROPFIND / 所有 REPORT → 空 multistatus（拉不到事件）
        let propfindCount = 0;
        responder.current = (_endpoint, payload) => {
            const record = payload as { method?: string };
            let body = QQ_EMPTY;
            if (record.method === "PROPFIND") {
                propfindCount++;
                if (propfindCount === 1) {
                    body = QQ_PRINCIPAL;
                } else if (propfindCount >= 3) {
                    body = QQ_USER_COLLECTION;
                }
            }
            return { code: 0, msg: "", data: { status: 207, body, bodyEncoding: "text", headers: {} } };
        };
    }

    it("只有 displayname、且不返回 calendar-home-set 时，仍能定位到可用的日历集合", async () => {
        qqResponder();
        const result = await client().discover();
        // QQ 不返回 calendar-home-set：principal = /calendar/<邮箱>（无结尾斜杠，与真实响应一致），
        // 该集合本身即日历，因此探测主目录后应得到 1 个带结尾斜杠的日历地址
        expect(result.principalUrl).toBe("https://dav.example.com/calendar/user%40example.com");
        expect(result.calendars.length).toBeGreaterThanOrEqual(1);
        const calendar = result.calendars[0];
        expect(calendar.url).toBe("https://dav.example.com/calendar/user%40example.com/");
        expect(calendar.components).toEqual(["VEVENT"]);
        expect(calendar.readOnly).toBe(false);
    });

    it("depth 1 枚举到「无 resourcetype 但有 displayname」的子集合时，也视为日历", async () => {
        const nestedCollection = multiStatus(`
  <d:response>
    <d:href>/dav/calendars/alice/qq-nested/</d:href>
    <d:propstat>
      <d:prop><d:displayname>Nested</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/calendars/alice/</d:href>
    <d:propstat>
      <d:prop><d:displayname>Home</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`);
        const homeSetResponse = multiStatus(`
  <d:response>
    <d:href>/</d:href>
    <d:propstat>
      <d:prop><c:calendar-home-set><d:href>/dav/calendars/alice/</d:href></c:calendar-home-set></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`);
        responder.current = (_endpoint, payload) => {
            const record = payload as { method?: string; payload?: string };
            const xml = decodeBase64(String(record.payload ?? ""));
            const body =
                record.method === "GET"
                    ? ""
                    : xml.includes("current-user-principal")
                      ? PRINCIPAL_RESPONSE
                      : xml.includes("calendar-home-set")
                        ? homeSetResponse
                        : nestedCollection;
            const status = record.method === "GET" ? 404 : 207;
            return { code: 0, msg: "", data: { status, body, bodyEncoding: "text", headers: {} } };
        };
        const result = await client().discover();
        const names = result.calendars.map((item) => item.displayName);
        expect(names).toContain("Nested");
        // 主目录自身（Home）不应被当成额外日历
        expect(names).not.toContain("Home");
    });

    it("REPORT 打到集合地址且返回空时，得到空事件列表而不是抛错", async () => {
        qqResponder();
        const result = await client().discover();
        const objects = await client().fetchEvents(result.calendars[0], Date.UTC(2025, 0, 1), Date.UTC(2025, 1, 1));
        expect(objects.resources).toEqual([]);
        const payload = lastCall()?.payload as { method?: string; url?: string };
        expect(payload.method).toBe("REPORT");
        expect(payload.url).toBe("https://dav.example.com/calendar/user%40example.com/");
    });

    it("通讯录集合不会被当成日历", async () => {
        const carddavHome = multiStatus(`
  <d:response>
    <d:href>/card/user%40example.com/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><B:addressbook/></d:resourcetype>
        <d:displayname>QQMail Contacts</d:displayname>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`);
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 207, body: carddavHome, bodyEncoding: "text", headers: {} },
        });
        // 通讯录不是日历：不应抛错，也不应产生任何日历
        const result = await client().discover();
        expect(result.calendars).toEqual([]);
    });
});

describe("XML 字符实体解码（QQ 邮箱用实体编码 ICS 换行）", () => {
    /** 真实响应片段：换行与引号都是 XML 实体 */
    const QQ_ENTITY_RESPONSE = `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<A:multistatus xmlns:A="DAV:" xmlns:D="urn:ietf:params:xml:ns:caldav">
    <A:response>
        <A:href>/calendar/F23EXAMPLEopaque~i~8zRqAQAS/7200000001.ics</A:href>
        <A:propstat>
            <A:prop>
                <A:getetag>1791042276</A:getetag>
                <D:calendar-data>BEGIN:VCALENDAR&#x0D;&#x0A;VERSION:2.0&#x0D;&#x0A;BEGIN:VEVENT&#x0D;&#x0A;UID:7200000001&#x0D;&#x0A;DTSTAMP:20261003T154436Z&#x0D;&#x0A;DTSTART;VALUE=DATE:19800101&#x0D;&#x0A;DTEND;VALUE=DATE:19800102&#x0D;&#x0A;SUMMARY:7200000001&#x751F;&#x65E5;&#x0D;&#x0A;RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=14;BYMONTH=10&#x0D;&#x0A;END:VEVENT&#x0D;&#x0A;END:VCALENDAR</D:calendar-data>
            </A:prop>
            <A:status>HTTP/1.1 200 OK</A:status>
        </A:propstat>
    </A:response>
</A:multistatus>`;

    it("decodeXmlEntities 还原换行、引号与中日韩字符", () => {
        expect(decodeXmlEntities("a&#x0D;&#x0A;b")).toBe("a\r\nb");
        expect(decodeXmlEntities("a&#13;&#10;b")).toBe("a\r\nb");
        expect(decodeXmlEntities("&lt;x&gt; &quot;q&quot; &apos;a&apos; &amp; &amp;lt;")).toBe(
            "<x> \"q\" 'a' & &lt;",
        );
        expect(decodeXmlEntities("&#x751F;&#x65E5;")).toBe("生日");
        expect(decodeXmlEntities("无实体")).toBe("无实体");
        expect(decodeXmlEntities("非法 &#xZZ; 与 &#99999999999;")).toBe("非法 &#xZZ; 与 ");
    });

    it("实体编码的 ICS 能被解析成事件（曾经整份 ICS 变成一行导致 0 事件）", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 207, body: QQ_ENTITY_RESPONSE, bodyEncoding: "text", headers: {} },
        });
        const objects = await client().fetchEvents(
            { url: "https://dav.example.com/calendar/F23EXAMPLEopaque~i~8zRqAQAS/", readOnly: false, components: ["VEVENT"] },
            Date.UTC(2025, 0, 1),
            Date.UTC(2027, 0, 1),
        );
        expect(objects.resources).toHaveLength(1);
        const resource = objects.resources[0];
        expect(resource.uid).toBe("7200000001");
        expect(resource.etag).toBe("1791042276");
        // href 中的 ~ 必须原样保留（QQ 的集合 ID 含波浪号）
        expect(resource.href).toBe(
            "https://dav.example.com/calendar/F23EXAMPLEopaque~i~8zRqAQAS/7200000001.ics",
        );
        expect(resource.ics).toContain("BEGIN:VEVENT");
        expect(resource.ics).toContain("SUMMARY:7200000001生日");
        expect(resource.ics).toMatch(/RRULE:FREQ=YEARLY/);
        // ICS 必须有真实换行，而不是一整行
        expect(resource.ics?.split("\n").length).toBeGreaterThan(5);
    });
});

describe("企业微信 caldav.wecom.work 兼容（命名空间敏感 + 根路径 403）", () => {
    /**
     * 实测行为：
     * - `PROPFIND /` → 403（HTML，且没有 WWW-Authenticate）→ 不能据此判定「认证失败」；
     * - `GET /.well-known/caldav` → 301 → `/calendar/`；
     * - `PROPFIND /calendar/` 带 `xmlns:cs="http://calendarserver.org/ns/"` → **400**；
     *   去掉该命名空间后 depth 1 → 207，返回 principal 与两个日历集合。
     */
    const PRINCIPAL_AT_ROOT = multiStatus(`
  <d:response>
    <d:href>/calendar/</d:href>
    <d:propstat>
      <d:prop>
        <d:current-user-principal><d:href>/calendar/user%40example.com</d:href></d:current-user-principal>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.0 200 OK</d:status>
    </d:propstat>
  </d:response>`);

    const HOME_WITH_CALENDARS = multiStatus(`
  <d:response>
    <d:href>/calendar/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.0 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/calendar/1000000000000001/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname>admin的日历</d:displayname>
      </d:prop>
      <d:status>HTTP/1.0 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/calendar/user%40example.com/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><d:principal/><c:calendar/></d:resourcetype>
        <d:displayname>shenziqi</d:displayname>
      </d:prop>
      <d:status>HTTP/1.0 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/calendar/inbox/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/><d:schedule-inbox/></d:resourcetype></d:prop>
      <d:status>HTTP/1.0 200 OK</d:status>
    </d:propstat>
  </d:response>`);

    /** 企微在 principal 上的 home-set 探测会明确返回 calendar-home-set = /calendar/ */
    const HOME_SET_RESPONSE = multiStatus(`
  <d:response>
    <d:href>/calendar/user%40example.com/</d:href>
    <d:propstat>
      <d:prop>
        <c:calendar-home-set><d:href>/calendar/</d:href></c:calendar-home-set>
        <d:displayname>shenziqi</d:displayname>
      </d:prop>
      <d:status>HTTP/1.0 200 OK</d:status>
    </d:propstat>
  </d:response>`);

    /** 复刻企微：请求 cs:getctag 就 400；根路径 403 + HTML；按 depth/属性区分应答 */
    function wecomResponder(): { requests: string[] } {
        const requests: string[] = [];
        const base = account.serverUrl.replace(/\/+$/, "");
        responder.current = (_endpoint, payload) => {
            const record = payload as { method?: string; url?: string; payload?: string };
            const url = String(record.url ?? "");
            const xml = decodeBase64(String(record.payload ?? ""));
            const auth = (record as { headers?: Array<Record<string, string>> }).headers ?? [];
            requests.push(`${record.method} ${url}`);
            const respond = (status: number, body: string, headers: Record<string, string[]> = {}) => ({
                code: 0,
                msg: "",
                data: { status, body, bodyEncoding: "text" as const, headers },
            });
            void auth;

            if (record.method === "GET" && url.includes(".well-known/caldav")) {
                return respond(301, "", { Location: ["/calendar/"] });
            }
            // 根路径（客户端配置的服务器地址）对未授权请求直接 403 + HTML
            if (url.replace(/\/+$/, "") === base) {
                return respond(403, "<html><head><title>403 Forbidden</title></head></html>");
            }
            // 企微真正的怪癖：请求 `cs:getctag`（calendarserver 命名空间）时返回 400
            if (/cs:getctag/.test(xml)) {
                return respond(400, "");
            }
            if (xml.includes("current-user-principal")) {
                return respond(207, PRINCIPAL_AT_ROOT);
            }
            if (xml.includes("calendar-home-set")) {
                return respond(207, HOME_SET_RESPONSE);
            }
            return respond(207, HOME_WITH_CALENDARS);
        };
        return { requests };
    }

    it("根路径 403 不会被误判为认证失败，改用 .well-known 找到 /calendar/", async () => {
        const { requests } = wecomResponder();
        const result = await client().discover().catch((error: unknown) => {
            throw new Error(`discover 失败：${String(error)}；请求序列：${requests.join(" | ")}`);
        });
        expect(result.principalUrl?.endsWith("/calendar/user%40example.com")).toBe(true);
        expect(result.homeSet?.endsWith("/calendar/")).toBe(true);
        // 必须在 .well-known 上做过发现
        expect(requests.some((item) => item.includes(".well-known/caldav"))).toBe(true);
    });

    it("列举日历遇 400 时自动退回精简属性集，并识别出两个日历（排除 inbox）", async () => {
        wecomResponder();
        const result = await client().discover();
        const names = result.calendars.map((item) => item.displayName).sort();
        expect(names).toEqual(["admin的日历", "shenziqi"]);
        const paths = result.calendars.map((item) => new URL(item.url).pathname).sort();
        expect(paths).toEqual([
            "/calendar/1000000000000001/",
            "/calendar/user%40example.com/",
        ]);
        // inbox 不是日历
        expect(result.calendars.some((item) => item.url.includes("inbox"))).toBe(false);
    });

    it("403 且响应不像 DAV 应答时，仍抛出可读的认证/地址提示", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: {
                status: 403,
                body: "<html><head><title>403 Forbidden</title></head></html>",
                bodyEncoding: "text",
                headers: {},
            },
        });
        await expect(client().listCalendars("https://caldav.wecom.work/calendar/")).rejects.toMatchObject({
            status: 403,
        });
    });
});

describe("REPORT 不返回 calendar-data 的服务端（企业微信实测行为）", () => {
    /**
     * 企微的 `calendar-query` 只返回 `getetag`，`calendar-data` 单独回 404：
     * 必须再按 href 取一次内容，否则永远拿不到事件。
     */
    const QUERY_RESPONSE = `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/calendar/1000000000000001/</D:href>
    <D:propstat>
      <D:prop><d:getetag/><c:calendar-data/></D:prop>
      <D:status>HTTP/1.0 404 Not Found</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/calendar/1000000000000001/abc123.ics</D:href>
    <D:propstat>
      <D:prop><d:getetag>1791041436 </d:getetag></D:prop>
      <D:status>HTTP/1.0 200 OK</D:status>
    </D:propstat>
    <D:propstat>
      <D:prop><c:calendar-data/></D:prop>
      <D:status>HTTP/1.0 404 Not Found</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

    /** 真实 ICS：自定义 TZID=CST8 + VALARM */
    const EVENT_ICS = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Tencent Inc.//QQMail//CalDAV v1.0//EN",
        "CALSCALE:GREGORIAN",
        "BEGIN:VTIMEZONE",
        "TZID:CST8",
        "BEGIN:STANDARD",
        "DTSTART:19700101T000000",
        "TZOFFSETFROM:+0800",
        "TZOFFSETTO:+0800",
        "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        "UID:abc123",
        "DTSTAMP:20261003T233036",
        "CREATED:20261003T233036",
        "DTSTART;TZID=CST8:20261004T100000",
        "DTEND;TZID=CST8:20261004T110000",
        "SUMMARY:测试日程",
        "TRANSP:OPAQUE",
        "BEGIN:VALARM",
        "TRIGGER:-PT15M",
        "ACTION:DISPLAY",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
    ].join("\r\n");

    it("逐条 GET 补取内容后能解析出事件", async () => {
        const calls: string[] = [];
        responder.current = (_endpoint, payload) => {
            const record = payload as { method?: string; url?: string; payload?: string };
            const xml = decodeBase64(String(record.payload ?? ""));
            calls.push(`${record.method} ${record.url}`);
            // GET 单个资源 → 返回真正的 ICS
            if (record.method === "GET") {
                return {
                    code: 0,
                    msg: "",
                    data: { status: 200, body: EVENT_ICS, bodyEncoding: "text", headers: { ETag: ['"1791041436"'] } },
                };
            }
            // multiget 不支持 → 400，逼出逐条 GET 分支
            if (xml.includes("calendar-multiget")) {
                return { code: 0, msg: "", data: { status: 400, body: "", bodyEncoding: "text", headers: {} } };
            }
            return { code: 0, msg: "", data: { status: 207, body: QUERY_RESPONSE, bodyEncoding: "text", headers: {} } };
        };

        const adapter = new CalDavSourceAdapter({
            accountId: "acct_wecom",
            calendar: {
                url: "https://caldav.wecom.work/calendar/1000000000000001/",
                readOnly: false,
                components: ["VEVENT"],
            },
            info: {
                id: "caldav:acct_wecom:x",
                name: "admin的日历",
                source: {
                    kind: "caldav",
                    accountId: "acct_wecom",
                    calendarUrl: "https://caldav.wecom.work/calendar/1000000000000001/",
                },
            },
            client: () => client(),
            zone: "Asia/Shanghai",
        });

        const result = await adapter.loadResource(Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
        expect(calls.some((item) => item.startsWith("GET"))).toBe(true);
        expect(result.events).toHaveLength(1);
        const event = result.events[0];
        expect(event.title).toBe("测试日程");
        // TZID=CST8 (+0800) 10:00 → UTC 02:00
        expect(event.start).toBe(Date.UTC(2026, 9, 4, 2));
        expect(event.alarms?.[0].trigger).toBe(-15 * 60_000);
    });

    it("multiget 可用时优先用它，不做逐条 GET", async () => {
        const calls: string[] = [];
        responder.current = (_endpoint, payload) => {
            const record = payload as { method?: string; url?: string; payload?: string };
            const xml = decodeBase64(String(record.payload ?? ""));
            calls.push(`${record.method} ${xml.includes("calendar-multiget") ? "MULTIGET " : ""}${record.url}`);
            if (record.method === "GET") {
                return { code: 0, msg: "", data: { status: 200, body: EVENT_ICS, bodyEncoding: "text", headers: {} } };
            }
            if (xml.includes("calendar-multiget")) {
                return {
                    code: 0,
                    msg: "",
                    data: {
                        status: 207,
                        body: multiStatus(`
  <d:response>
    <d:href>/calendar/1000000000000001/abc123.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"1791041436"</d:getetag><c:calendar-data>${EVENT_ICS.replace(/\r\n/g, "&#x0D;&#x0A;")}</c:calendar-data></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`),
                        bodyEncoding: "text",
                        headers: {},
                    },
                };
            }
            return { code: 0, msg: "", data: { status: 207, body: QUERY_RESPONSE, bodyEncoding: "text", headers: {} } };
        };

        const adapter = new CalDavSourceAdapter({
            accountId: "acct_wecom",
            calendar: {
                url: "https://caldav.wecom.work/calendar/1000000000000001/",
                readOnly: false,
                components: ["VEVENT"],
            },
            info: {
                id: "caldav:acct_wecom:x",
                name: "admin的日历",
                source: {
                    kind: "caldav",
                    accountId: "acct_wecom",
                    calendarUrl: "https://caldav.wecom.work/calendar/1000000000000001/",
                },
            },
            client: () => client(),
            zone: "Asia/Shanghai",
        });
        const result = await adapter.loadResource(Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
        expect(calls.join(" ; ")).toContain("MULTIGET");
        expect(result.events).toHaveLength(1);
        expect(result.events[0].title).toBe("测试日程");
    });
    it("multiget 必须使用 Depth: 0（实测企业微信用 Depth:1 会 403）", async () => {
        const depths: string[] = [];
        const withData = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendar/1000000000000001/a.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"1"</d:getetag><c:calendar-data>BEGIN:VCALENDAR&#x0D;&#x0A;VERSION:2.0&#x0D;&#x0A;BEGIN:VEVENT&#x0D;&#x0A;UID:a&#x0D;&#x0A;DTSTART:20261006T100000Z&#x0D;&#x0A;SUMMARY:x&#x0D;&#x0A;END:VEVENT&#x0D;&#x0A;END:VCALENDAR</c:calendar-data></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
        responder.current = (_endpoint, payload) => {
            const record = payload as { headers?: Array<Record<string, string>>; method?: string };
            const depth = (record.headers ?? []).map((item) => item.Depth ?? item.depth).find(Boolean);
            if (record.method === "REPORT" && depth !== undefined) {
                depths.push(depth);
            }
            if (depth === "1") {
                // 复刻企微：Depth:1 的 multiget 直接 403
                return { code: 0, msg: "", data: { status: 403, body: "", bodyEncoding: "text", headers: {} } };
            }
            return { code: 0, msg: "", data: { status: 207, body: withData, bodyEncoding: "text", headers: {} } };
        };
        const resources = await client().multiget("https://dav.example.com/calendar/1000000000000001/", [
            "https://dav.example.com/calendar/1000000000000001/a.ics",
        ]);
        expect(resources).toHaveLength(1);
        expect(depths.length).toBeGreaterThan(0);
        expect(depths[0]).toBe("0");
        expect(depths).not.toContain("1");
    });

    it("同样的日历重复查询时复用变体，不重复试探（避免请求风暴）", async () => {
        const emptyMultistatus = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"/>`;
        const etagOnly = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/dav/calendars/alice/work/a.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"1"</d:getetag></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
        let queryCount = 0;
        responder.current = (_endpoint, payload) => {
            const record = payload as { method?: string; payload?: string };
            const xml = decodeBase64(String(record.payload ?? ""));
            if (record.method !== "REPORT" || !xml.includes("calendar-query")) {
                return { code: 0, msg: "", data: { status: 207, body: emptyMultistatus, bodyEncoding: "text", headers: {} } };
            }
            queryCount++;
            // 只有「不带 time-range」的变体返回资源（复刻企业微信忽略过滤的行为）
            const body = xml.includes("time-range") ? emptyMultistatus : etagOnly;
            return { code: 0, msg: "", data: { status: 207, body, bodyEncoding: "text", headers: {} } };
        };
        const instance = client();
        const calendar = {
            url: "https://dav.example.com/dav/calendars/alice/work/",
            readOnly: false,
            components: ["VEVENT"],
        };
        await instance.fetchEvents(calendar, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
        const first = queryCount;
        await instance.fetchEvents(calendar, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
        // 第二轮只应重放记住的那个变体（一次请求），而不是再从头试一遍
        expect(queryCount - first).toBe(1);
    });
});

describe("日历 ID 工具", () => {
    it("往返编解码", () => {
        const id = calendarId("acct_1", "https://dav.example.com/dav/calendars/alice/work/");
        const parsed = parseCalendarId(id);
        expect(parsed).toEqual({
            accountId: "acct_1",
            calendarUrl: "https://dav.example.com/dav/calendars/alice/work/",
        });
    });

    it("非法 ID 返回 undefined", () => {
        expect(parseCalendarId("av:123")).toBeUndefined();
        expect(parseCalendarId("query:abc")).toBeUndefined();
    });
});

describe("认证失败提示", () => {
    it("401 错误信息包含排查提示", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { status: 401, body: "", bodyEncoding: "text", headers: {} },
        });
        await expect(client().discover()).rejects.toThrowError(/应用专用密码|认证失败/);
        expect(calls.length).toBeGreaterThan(0);
    });
});
