import { beforeEach, describe, expect, it } from "vitest";
import {
    formatSiyuanTime,
    forwardProxy,
    parseSiyuanTime,
    pickCustomAttrs,
    resolveDateAttr,
    sql,
} from "./api";
import { calls, lastCall, resetKernelMock, responder } from "../__mocks__/siyuan";
import { base64ToBytes, bytesToBase64, utf8Bytes } from "../util/misc";

const UTC = "UTC";

beforeEach(() => {
    resetKernelMock();
});

describe("pickCustomAttrs", () => {
    it("只保留 custom- 前缀且非空的值，并去掉前缀", () => {
        const attrs = {
            id: "20240101-abc",
            "custom-due": "20250103",
            "custom-empty": "",
            "custom-flag": "1",
            title: "普通属性",
        };
        expect(pickCustomAttrs(attrs)).toEqual({
            due: "20250103",
            flag: "1",
        });
    });

    it("对空对象与非法输入安全", () => {
        expect(pickCustomAttrs({})).toEqual({});
        expect(pickCustomAttrs(undefined as unknown as Record<string, string>)).toEqual({});
    });
});

describe("parseSiyuanTime", () => {
    it("解析全天属性 20250103", () => {
        const ts = parseSiyuanTime("20250103", false, UTC);
        expect(ts).toBe(Date.UTC(2025, 0, 3));
    });

    it("解析定时属性 20250103120000", () => {
        const ts = parseSiyuanTime("20250103120000", true, UTC);
        expect(ts).toBe(Date.UTC(2025, 0, 3, 12, 0, 0));
    });

    it("按长度自动推断是否含时间", () => {
        expect(parseSiyuanTime("20250103120000", undefined, UTC)).toBe(Date.UTC(2025, 0, 3, 12));
        expect(parseSiyuanTime("20250103", undefined, UTC)).toBe(Date.UTC(2025, 0, 3));
    });

    it("解析带分隔符的写法", () => {
        expect(parseSiyuanTime("2025-01-03 12:00:00", true, UTC)).toBe(Date.UTC(2025, 0, 3, 12));
        expect(parseSiyuanTime("2025-01-03T12:30", true, UTC)).toBe(Date.UTC(2025, 0, 3, 12, 30));
        expect(parseSiyuanTime("2025-01-03", false, UTC)).toBe(Date.UTC(2025, 0, 3));
    });

    it("解析 10 位秒级与 13 位毫秒时间戳", () => {
        expect(parseSiyuanTime("1735905600", undefined, UTC)).toBe(1_735_905_600_000);
        expect(parseSiyuanTime("1735905600123", undefined, UTC)).toBe(1_735_905_600_123);
    });

    it("拒绝非法输入", () => {
        expect(parseSiyuanTime("", undefined, UTC)).toBeUndefined();
        expect(parseSiyuanTime("0", undefined, UTC)).toBeUndefined();
        expect(parseSiyuanTime("20251303", false, UTC)).toBeUndefined();
        expect(parseSiyuanTime("20250230", false, UTC)).toBeUndefined();
        expect(parseSiyuanTime("不是日期", undefined, UTC)).toBeUndefined();
        expect(parseSiyuanTime(null, undefined, UTC)).toBeUndefined();
        expect(parseSiyuanTime(undefined, undefined, UTC)).toBeUndefined();
    });
});

describe("formatSiyuanTime", () => {
    it("全天输出 yyyyMMdd，定时输出 yyyyMMddHHmmss", () => {
        const ts = Date.UTC(2025, 0, 3, 12, 34, 56);
        expect(formatSiyuanTime(ts, false, UTC)).toBe("20250103");
        expect(formatSiyuanTime(ts, true, UTC)).toBe("20250103123456");
    });

    it("与 parseSiyuanTime 往返一致", () => {
        const allDay = Date.UTC(2025, 5, 18);
        const timed = Date.UTC(2025, 5, 18, 9, 15, 30);
        expect(parseSiyuanTime(formatSiyuanTime(allDay, false, UTC), false, UTC)).toBe(allDay);
        expect(parseSiyuanTime(formatSiyuanTime(timed, true, UTC), true, UTC)).toBe(timed);
    });

    it("按指定时区输出", () => {
        const ts = Date.UTC(2025, 0, 3, 20, 0, 0);
        expect(formatSiyuanTime(ts, true, "Asia/Shanghai")).toBe("20250104040000");
        expect(formatSiyuanTime(ts, true, "UTC")).toBe("20250103200000");
    });
});

describe("resolveDateAttr", () => {
    it("按候选顺序命中首个可用属性", () => {
        const attrs = { "custom-due": "20250103", "custom-start": "20250104100000" };
        expect(resolveDateAttr(attrs, ["start", "due"], UTC)).toEqual({
            ts: Date.UTC(2025, 0, 4, 10),
            hasTime: true,
            attr: "start",
        });
        expect(resolveDateAttr(attrs, ["missing", "due"], UTC)?.attr).toBe("due");
    });

    it("无命中时返回 undefined", () => {
        expect(resolveDateAttr({ "custom-x": "bad" }, ["x"], UTC)).toBeUndefined();
    });
});

describe("sql", () => {
    it("只发送 stmt，不发送内核不支持的 limit", async () => {
        responder.current = () => ({ code: 0, msg: "", data: [{ id: "x" }] });
        const rows = await sql("SELECT 1", 100);
        expect(rows).toEqual([{ id: "x" }]);
        expect(lastCall()?.endpoint).toBe("/api/query/sql");
        expect(lastCall()?.payload).toEqual({ stmt: "SELECT 1" });
    });

    it("data 非数组时返回空数组", async () => {
        responder.current = () => ({ code: 0, msg: "", data: null });
        await expect(sql("SELECT 1")).resolves.toEqual([]);
    });
});

describe("forwardProxy", () => {
    it("headers 使用单键对象数组，请求体用 base64 编码", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { url: "https://x", status: 207, body: "ok", bodyEncoding: "text", headers: {} },
        });
        await forwardProxy({
            url: "https://dav.example.com/calendars/u/",
            method: "PROPFIND",
            headers: { Authorization: "Basic abc", Depth: "1" },
            body: "<d:propfind/>",
            contentType: "application/xml; charset=utf-8",
        });
        const payload = lastCall()?.payload as Record<string, unknown>;
        expect(lastCall()?.endpoint).toBe("/api/network/forwardProxy");
        expect(payload.method).toBe("PROPFIND");
        expect(payload.headers).toEqual([{ Authorization: "Basic abc" }, { Depth: "1" }]);
        expect(payload.payloadEncoding).toBe("base64");
        // 解码后应还原原始 XML
        const decoded = new TextDecoder().decode(base64ToBytes(String(payload.payload)));
        expect(decoded).toBe("<d:propfind/>");
        expect(payload.contentType).toBe("application/xml; charset=utf-8");
    });

    it("解析响应头（Go http.Header 数组值）并小写化", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: {
                url: "https://x",
                status: 200,
                body: "body",
                bodyEncoding: "text",
                headers: { ETag: ['"abc"'], "Content-Type": ["text/calendar; charset=utf-8"] },
                elapsed: 42,
            },
        });
        const response = await forwardProxy({ url: "https://x", method: "GET" });
        expect(response.status).toBe(200);
        expect(response.headers.etag).toBe('"abc"');
        expect(response.headers["content-type"]).toBe("text/calendar; charset=utf-8");
        expect(response.elapsed).toBe(42);
    });

    it("bodyEncoding 非 text 时自动 base64 解码", async () => {
        const raw = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
        const base64 = bytesToBase64(utf8Bytes(raw));
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { url: "https://x", status: 200, body: base64, bodyEncoding: "base64", headers: {} },
        });
        const response = await forwardProxy({ url: "https://x", method: "GET" });
        expect(response.body).toBe(raw);
    });

    it("base64Body 请求会要求内核返回 base64 响应", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: { url: "https://x", status: 200, body: "", bodyEncoding: "base64", headers: {} },
        });
        await forwardProxy({ url: "https://x", method: "GET", base64Body: true, body: "QUJD" });
        const payload = lastCall()?.payload as Record<string, unknown>;
        expect(payload.responseEncoding).toBe("base64");
        expect(payload.payload).toBe("QUJD");
        expect(payload.contentType).toBe("application/octet-stream");
    });

    it("内核失败时抛出 KernelError", async () => {
        responder.current = () => ({ code: 8, msg: "request failed", data: null });
        await expect(forwardProxy({ url: "https://x", method: "GET" })).rejects.toMatchObject({
            name: "KernelError",
            code: 8,
        });
    });

    it("把内核错误完整记录到调用列表（便于调试）", async () => {
        responder.current = () => ({ code: 0, msg: "", data: { status: 404, body: "", headers: {} } });
        await forwardProxy({ url: "https://x/missing.ics", method: "DELETE" });
        expect(calls).toHaveLength(1);
    });
});
