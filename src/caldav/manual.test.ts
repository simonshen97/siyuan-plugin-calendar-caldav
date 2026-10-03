import { describe, expect, it } from "vitest";
import { calendarNameFromUrl, mergeManualCalendars, normalizeCalendarUrl } from "./manual";
import type { CalDavAccount, CalendarInfo } from "../types";

const account: CalDavAccount = {
    id: "acct_qq",
    name: "QQ 邮箱",
    serverUrl: "https://dav.qq.com/calendar/",
    username: "user@example.com",
    enabled: true,
};

function discoveredCalDav(url: string, name: string, readOnly = false): CalendarInfo {
    return {
        id: `caldav:acct_qq:${encodeURIComponent(url)}`,
        name,
        color: "#3574f0",
        readOnly,
        source: { kind: "caldav", accountId: "acct_qq", calendarUrl: url, displayName: name },
    };
}

describe("normalizeCalendarUrl", () => {
    it("补结尾斜杠并去掉查询串", () => {
        expect(normalizeCalendarUrl("https://dav.qq.com/calendar/u/")).toBe("https://dav.qq.com/calendar/u/");
        expect(normalizeCalendarUrl("https://dav.qq.com/calendar/u")).toBe("https://dav.qq.com/calendar/u/");
        expect(normalizeCalendarUrl("  https://dav.qq.com/calendar/u?x=1#y  ")).toBe("https://dav.qq.com/calendar/u/");
    });

    it("空输入返回空串", () => {
        expect(normalizeCalendarUrl("   ")).toBe("");
        expect(normalizeCalendarUrl("")).toBe("");
    });
});

describe("calendarNameFromUrl", () => {
    it("取末段并百分号解码", () => {
        expect(calendarNameFromUrl("https://dav.qq.com/calendar/user%40example.com/")).toBe("user@example.com");
        expect(calendarNameFromUrl("https://dav.qq.com/calendar/u/work/")).toBe("work");
    });

    it("非法编码不抛错", () => {
        expect(() => calendarNameFromUrl("https://dav.qq.com/calendar/%E0%A4%A/")).not.toThrow();
    });
});

describe("mergeManualCalendars", () => {
    it("没有手动地址时原样返回已发现日历", () => {
        const calendars = [discoveredCalDav("https://dav.qq.com/calendar/u/work/", "work")];
        expect(mergeManualCalendars({ ...account, calendars })).toEqual(calendars);
    });

    it("服务端枚举为空时，用手动地址合成一个可同步的日历", () => {
        // QQ 邮箱的真实情况：discovery 返回 0 个集合
        const merged = mergeManualCalendars({
            ...account,
            calendars: [],
            manualCalendarUrls: ["https://dav.qq.com/calendar/user%40example.com/"],
        });
        expect(merged).toHaveLength(1);
        expect(merged[0].source.kind).toBe("caldav");
        expect((merged[0].source as { calendarUrl: string }).calendarUrl).toBe(
            "https://dav.qq.com/calendar/user%40example.com/",
        );
        expect(merged[0].name).toBe("user@example.com");
        expect(merged[0].readOnly).toBe(false);
        expect(merged[0].id.startsWith("caldav:acct_qq:")).toBe(true);
    });

    it("手动地址与已发现集合重复时复用已发现项（保留颜色与只读）", () => {
        const existing = discoveredCalDav("https://dav.qq.com/calendar/u/work/", "Work", true);
        const merged = mergeManualCalendars({
            ...account,
            calendars: [existing],
            manualCalendarUrls: ["https://dav.qq.com/calendar/u/work"], // 仅少了结尾斜杠
        });
        expect(merged).toHaveLength(1);
        expect(merged[0]).toBe(existing);
    });

    it("多个手动地址 + 忽略空行，且不产生重复项", () => {
        const merged = mergeManualCalendars({
            ...account,
            calendars: [],
            manualCalendarUrls: [
                "https://dav.qq.com/calendar/u/a/",
                "  ",
                "https://dav.qq.com/calendar/u/b/",
                "https://dav.qq.com/calendar/u/a/",
            ],
        });
        expect(merged.map((item) => item.name)).toEqual(["a", "b"]);
    });

    it("手动地址与已发现集合共存时两者都在，且已发现的排在前面", () => {
        const existing = discoveredCalDav("https://dav.qq.com/calendar/u/work/", "Work");
        const merged = mergeManualCalendars({
            ...account,
            calendars: [existing],
            manualCalendarUrls: ["https://dav.qq.com/calendar/u/extra/"],
        });
        expect(merged).toHaveLength(2);
        expect(merged[0]).toBe(existing);
        expect(merged[1].name).toBe("extra");
    });
});
