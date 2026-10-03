import { beforeEach, describe, expect, it } from "vitest";
import {
    MAX_CALENDAR_RANGE_DAYS,
    SiYuanAttributeViewSourceAdapter,
    attributeViewCalendarId,
    detectAttributeView,
    parseRenderPayload,
} from "./avStore";
import type { CalendarInfo, CalendarSourceAv } from "../types";
import { calls, resetKernelMock, responder } from "../__mocks__/siyuan";
import { dateKeyToTs } from "../util/date";

const UTC = "UTC";
const AV_ID = "20240118120204-kwyzf77";
const DATE_KEY = "20240118120204-w6cggab";
const TITLE_KEY = "20240118120204-title01";
const COLOR_KEY = "20240118120204-color01";

const source: CalendarSourceAv = {
    kind: "av",
    avID: AV_ID,
    blockID: "20240118120201-kldj15t",
    dateKeyID: DATE_KEY,
    titleKeyID: TITLE_KEY,
    colorKeyID: COLOR_KEY,
};

const info: CalendarInfo = {
    id: attributeViewCalendarId(source),
    name: "项目排期",
    color: "#0ea5e9",
    readOnly: true,
    source,
};

interface RowSpec {
    id: string;
    content: number;
    content2?: number;
    hasEndDate?: boolean;
    isNotTime: boolean;
    title: string;
    color?: string;
}

/** 依据内核 v3.8.6 的真实响应形态构造 renderAttributeView 结果 */
function renderPayload(options: {
    rows: RowSpec[];
    dateKeyID?: string;
    viewType?: string;
}): Record<string, unknown> {
    return {
        id: AV_ID,
        name: "项目排期",
        viewType: options.viewType ?? "calendar",
        viewID: "view-1",
        view: {
            id: "view-1",
            type: options.viewType ?? "calendar",
            name: "日历",
            calendar: {
                dateKeyID: options.dateKeyID ?? DATE_KEY,
                colorKeyID: COLOR_KEY,
                weekStart: 1,
                rowLimit: 3,
            },
            columns: [
                { id: DATE_KEY, name: "日期", type: "date", hidden: false },
                { id: TITLE_KEY, name: "标题", type: "text", hidden: false },
                { id: COLOR_KEY, name: "状态", type: "mSelect", hidden: false },
            ],
            rows: options.rows.map((row) => ({
                id: row.id,
                cells: [
                    {
                        id: `${row.id}-date`,
                        valueType: "date",
                        value: {
                            id: `${row.id}-date`,
                            keyID: DATE_KEY,
                            type: "date",
                            date: {
                                content: row.content,
                                isNotEmpty: true,
                                hasEndDate: row.hasEndDate ?? false,
                                isNotTime: row.isNotTime,
                                content2: row.content2 ?? 0,
                                isNotEmpty2: row.hasEndDate ?? false,
                                formattedContent: new Date(row.content).toISOString().slice(0, 10),
                            },
                        },
                    },
                    {
                        id: `${row.id}-title`,
                        valueType: "text",
                        value: { keyID: TITLE_KEY, type: "text", text: { content: row.title } },
                    },
                    {
                        id: `${row.id}-color`,
                        valueType: "mSelect",
                        value: { keyID: COLOR_KEY, type: "mSelect", mSelect: row.color ? [{ content: row.color, color: "1" }] : [] },
                    },
                ],
            })),
            rowCount: options.rows.length,
        },
    };
}

function adapter(): SiYuanAttributeViewSourceAdapter {
    return new SiYuanAttributeViewSourceAdapter({ source, info, zone: UTC });
}

beforeEach(() => {
    resetKernelMock();
});

describe("parseRenderPayload", () => {
    it("取出 view 对象", () => {
        const payload = renderPayload({ rows: [] });
        const view = parseRenderPayload(payload);
        expect(view?.id).toBe("view-1");
    });

    it("兼容 JSON 字符串返回", () => {
        const payload = renderPayload({ rows: [] });
        expect(parseRenderPayload(JSON.stringify(payload))?.id).toBe("view-1");
    });

    it("非法数据返回 undefined", () => {
        expect(parseRenderPayload("not json")).toBeUndefined();
        expect(parseRenderPayload(undefined)).toBeUndefined();
        expect(parseRenderPayload({ foo: 1 })).toBeUndefined();
    });

    it("指定 viewID 时从 views 数组匹配", () => {
        const view = parseRenderPayload(
            { views: [{ id: "a", type: "table" }, { id: "b", type: "calendar" }] },
            "b",
        );
        expect(view?.type).toBe("calendar");
    });
});

describe("SiYuanAttributeViewSourceAdapter", () => {
    it("把毫秒时间戳的 date 单元格转换为事件", async () => {
        const day = Date.UTC(2025, 5, 18);
        responder.current = () => ({
            code: 0,
            msg: "",
            data: renderPayload({
                rows: [
                    { id: "row-1", content: day, isNotTime: true, title: "需求评审" },
                    { id: "row-2", content: day + 3 * 3_600_000, isNotTime: false, title: "站会", color: "进行中" },
                ],
            }),
        });
        const events = await adapter().loadEvents(day - 86_400_000, day + 7 * 86_400_000);
        expect(events).toHaveLength(2);
        const allDay = events.find((event) => event.title === "需求评审");
        const timed = events.find((event) => event.title === "站会");
        expect(allDay).toMatchObject({ allDay: true, start: day, end: day + 86_400_000, sourceKind: "av", readOnly: true });
        expect(timed).toMatchObject({ allDay: false, start: day + 3 * 3_600_000 });
        expect(timed?.end).toBe(day + 3 * 3_600_000 + 3_600_000);
        expect(timed?.siyuan).toMatchObject({ itemID: "row-2", avID: AV_ID, dateKeyID: DATE_KEY });
    });

    it("应用结束日期（hasEndDate）", async () => {
        const start = Date.UTC(2025, 5, 18);
        const end = Date.UTC(2025, 5, 20);
        responder.current = () => ({
            code: 0,
            msg: "",
            data: renderPayload({
                rows: [{ id: "row-1", content: start, content2: end, hasEndDate: true, isNotTime: true, title: "出差" }],
            }),
        });
        const events = await adapter().loadEvents(start - 86_400_000, end + 86_400_000);
        expect(events[0]).toMatchObject({ start, end, allDay: true, hasEndDate: true });
    });

    it("请求携带内核要求的 calendarRange（毫秒半开区间 + 时区）", async () => {
        const day = Date.UTC(2025, 5, 18);
        responder.current = () => ({ code: 0, msg: "", data: renderPayload({ rows: [] }) });
        await adapter().loadEvents(day, day + 86_400_000);
        const payload = calls[calls.length - 1].payload as { calendarRange: { start: number; end: number; timeZone: string } };
        expect(payload.calendarRange).toEqual({ start: day, end: day + 86_400_000, timeZone: UTC });
    });

    it("区间超过 63 天时自动切片", async () => {
        const start = Date.UTC(2025, 0, 1);
        const end = start + 200 * 86_400_000;
        responder.current = () => ({ code: 0, msg: "", data: renderPayload({ rows: [] }) });
        await adapter().loadEvents(start, end);
        const ranges = calls
            .filter((call) => call.endpoint === "/api/av/renderAttributeView")
            .map((call) => (call.payload as { calendarRange: { start: number; end: number } }).calendarRange);
        expect(ranges.length).toBeGreaterThan(1);
        for (const range of ranges) {
            expect(range.end - range.start).toBeLessThanOrEqual(MAX_CALENDAR_RANGE_DAYS * 86_400_000);
        }
        expect(ranges[0].start).toBe(start);
        expect(ranges[ranges.length - 1].end).toBe(end);
    });

    it("内核未绑定日期字段时自动选择 date 类型字段", async () => {
        const custom: CalendarSourceAv = { kind: "av", avID: AV_ID, blockID: AV_ID };
        const day = dateKeyToTs("2025-06-18", UTC);
        responder.current = () => ({
            code: 0,
            msg: "",
            data: renderPayload({
                rows: [{ id: "row-1", content: day, isNotTime: true, title: "自动字段" }],
                dateKeyID: "",
            }),
        });
        const instance = new SiYuanAttributeViewSourceAdapter({
            source: custom,
            info: { ...info, source: custom },
            zone: UTC,
        });
        const events = await instance.loadEvents(day - 86_400_000, day + 86_400_000);
        expect(events).toHaveLength(1);
        expect(instance.lastDateKeyID).toBe(DATE_KEY);
        // 检测到的字段被写回数据源，便于持久化
        expect(custom.dateKeyID).toBe(DATE_KEY);
    });

    it("区间外的行被过滤（跨切片去重）", async () => {
        const day = Date.UTC(2025, 5, 18);
        responder.current = () => ({
            code: 0,
            msg: "",
            data: renderPayload({ rows: [{ id: "row-1", content: day, isNotTime: true, title: "区间外" }] }),
        });
        const events = await adapter().loadEvents(day + 30 * 86_400_000, day + 40 * 86_400_000);
        expect(events).toEqual([]);
    });

    it("数据库源始终只读", () => {
        const instance = adapter();
        expect(instance.isWritable()).toBe(false);
        expect(instance.owns({ calendar: info.id } as never)).toBe(true);
    });

    it("缺少日期字段时返回空列表且不抛错", async () => {
        const custom: CalendarSourceAv = { kind: "av", avID: AV_ID, blockID: AV_ID };
        responder.current = () => ({ code: 0, msg: "", data: { view: { id: "v", columns: [], rows: [] } } });
        const instance = new SiYuanAttributeViewSourceAdapter({
            source: custom,
            info: { ...info, source: custom },
            zone: UTC,
        });
        await expect(instance.loadEvents(0, 86_400_000)).resolves.toEqual([]);
    });
});

describe("detectAttributeView", () => {
    it("返回名称、视图与字段列表", async () => {
        responder.current = (endpoint) => {
            if (endpoint === "/api/query/sql") {
                return { code: 0, msg: "", data: [{ content: "项目排期", ial: "{}" }] };
            }
            return { code: 0, msg: "", data: renderPayload({ rows: [] }) };
        };
        const detected = await detectAttributeView(AV_ID);
        expect(detected?.name).toBe("项目排期");
        expect(detected?.viewID).toBe("view-1");
        expect(detected?.fields.map((field) => field.id)).toContain(DATE_KEY);
        expect(detected?.calendarDateKeyID).toBe(DATE_KEY);
    });

    it("空 ID 返回 undefined", async () => {
        expect(await detectAttributeView("   ")).toBeUndefined();
        expect(calls).toHaveLength(0);
    });

    it("读取失败时降级为仅 ID，不抛错", async () => {
        responder.current = () => ({ code: -1, msg: "not found", data: null });
        const detected = await detectAttributeView("missing-id");
        expect(detected?.name).toBe("missing-id");
        expect(detected?.fields).toEqual([]);
    });

    // 回归：用户换了数据库块，配置里仍带着上一个数据库的 viewID，
    // 内核会抛 `view not found`（v0.5.0 起引入），表现为「未读取到字段」。
    it("传入别的数据库的 viewID 时自动去掉重试，仍能读到字段（且不弹内核错误）", async () => {
        const requested: Array<string | undefined> = [];
        let pushedError = false;
        responder.current = (endpoint, payload) => {
            if (endpoint === "/api/query/sql") {
                return { code: 0, msg: "", data: [{ content: "新数据库", ial: `{: custom-av-id="${AV_ID}"}` }] };
            }
            if (endpoint === "/api/notification/pushErrMsg") {
                // 探测必须是 silent 请求：失败不该给用户弹「view not found」
                pushedError = true;
                return { code: 0, msg: "", data: null };
            }
            const viewID = (payload as { viewID?: string } | undefined)?.viewID;
            requested.push(viewID);
            if (viewID === "view-from-old-database") {
                // 内核行为：视图不存在 → 报错，无数据
                return { code: -1, msg: "view not found", data: null };
            }
            return { code: 0, msg: "", data: renderPayload({ rows: [] }) };
        };
        const detected = await detectAttributeView(AV_ID, "view-from-old-database");
        expect(requested).toEqual(["view-from-old-database", undefined]);
        expect(pushedError).toBe(false);
        expect(detected?.fields.length).toBeGreaterThan(0);
        // 视图 ID 必须是新读取到的，而不是那个失效的旧值
        expect(detected?.viewID).toBe("view-1");
    });

    it("viewID 有效时只请求一次，并原样使用", async () => {
        const requested: Array<string | undefined> = [];
        responder.current = (endpoint, payload) => {
            if (endpoint === "/api/query/sql") {
                return { code: 0, msg: "", data: [{ content: "项目排期", ial: `{: custom-av-id="${AV_ID}"}` }] };
            }
            requested.push((payload as { viewID?: string } | undefined)?.viewID);
            return { code: 0, msg: "", data: renderPayload({ rows: [] }) };
        };
        const detected = await detectAttributeView(AV_ID, "view-1");
        expect(requested).toEqual(["view-1"]);
        expect(detected?.viewID).toBe("view-1");
    });
});

describe("attributeViewCalendarId", () => {
    it("对同一配置稳定，对不同配置区分", () => {
        const a = attributeViewCalendarId(source);
        const b = attributeViewCalendarId({ ...source });
        const c = attributeViewCalendarId({ ...source, dateKeyID: "other" });
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a.startsWith("av:")).toBe(true);
    });
});
