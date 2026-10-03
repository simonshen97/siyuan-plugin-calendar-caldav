import { beforeEach, describe, expect, it, vi } from "vitest";
import { AvLocalStore } from "./avLocalStore";
import { AvRowStore } from "./avRowStore";
import type { AvRawValue } from "../kernel/api";
import type { CalendarEvent } from "../types";
import { resetKernelMock, responder } from "../__mocks__/siyuan";

/**
 * 「数据库行」作为同步落库目标的回归。
 *
 * 关键安全边界：只接管带 `custom-caldav-uid` 属性的行；
 * 用户在数据库里手写的行（没有该属性）绝不能被更新或删除。
 */

const AV = "20260101120000-avavava";
const DATE_KEY = "date-col";
const TITLE_KEY = "title-col";
const MARKER_KEY = "marker-col";

/** 依据内核 v3.8.6 的真实响应形态构造 renderAttributeView 结果（与 avStore.test.ts 一致） */
function renderPayload(
    rows: Array<{ id: string; title: string; start: number; marker?: string }>,
): Record<string, unknown> {
    return {
        id: AV,
        name: "项目排期",
        viewType: "calendar",
        viewID: "view-1",
        view: {
            id: "view-1",
            type: "calendar",
            name: "日历",
            calendar: { dateKeyID: DATE_KEY, weekStart: 1 },
            columns: [
                { id: DATE_KEY, name: "日期", type: "date", hidden: false },
                { id: TITLE_KEY, name: "标题", type: "text", hidden: false },
                { id: MARKER_KEY, name: "插件标识", type: "text", hidden: false },
            ],
            rows: rows.map((row) => ({
                id: row.id,
                cells: [
                    {
                        id: `${row.id}-date`,
                        valueType: "date",
                        value: {
                            id: `${row.id}-date`,
                            keyID: DATE_KEY,
                            type: "date",
                            date: { content: row.start, isNotEmpty: true, isNotTime: true },
                        },
                    },
                    {
                        id: `${row.id}-title`,
                        valueType: "text",
                        value: {
                            id: `${row.id}-title`,
                            keyID: TITLE_KEY,
                            type: "text",
                            text: { content: row.title },
                        },
                    },
                    {
                        id: `${row.id}-marker`,
                        valueType: "text",
                        value: {
                            id: `${row.id}-marker`,
                            keyID: MARKER_KEY,
                            type: "text",
                            text: { content: row.marker ?? "" },
                        },
                    },
                ],
            })),
        },
    };
}

function event(uid: string, title = "事件"): CalendarEvent {
    return {
        uid,
        calendar: "caldav:acct:http://x/dav/projects/3/",
        calendarName: "任务清单",
        sourceKind: "caldav",
        title,
        start: Date.UTC(2026, 9, 6, 2),
        end: Date.UTC(2026, 9, 6, 3),
        allDay: false,
    };
}

/** 记录内核调用，并按「行是否为插件所写」返回块属性 */
function fakeRows(managed: Record<string, string>, log: string[]): AvRowStore {
    return new AvRowStore(
        { avID: AV, binding: { dateKeyID: DATE_KEY, titleKeyID: TITLE_KEY }, fieldTypes: { [DATE_KEY]: "date" } },
        {
            readAttrs: async (blockID): Promise<Record<string, string>> =>
                managed[blockID] ? { "custom-caldav-uid": managed[blockID] } : { "custom-user": "1" },
            append: async (_avID, _blocksValues) => {
                log.push("append");
                return { blockIDs: ["row-new"] };
            },
            setCells: async (_avID, itemID) => {
                log.push(`setCells:${itemID}`);
            },
            removeRows: async (_avID, srcIDs) => {
                log.push(`removeRows:${srcIDs.join(",")}`);
            },
            write: async (operations) => {
                log.push(`write:${String(operations[0].action)}`);
            },
            writeAttrs: async (blockID, attrs) => {
                log.push(`attrs:${blockID}:${attrs["custom-caldav-uid"] ?? ""}`);
            },
        },
    );
}

function store(managed: Record<string, string>, log: string[] = []): { store: AvLocalStore; log: string[] } {
    const local = new AvLocalStore(
        {
            avID: AV,
            zone: "Asia/Shanghai",
            label: "任务清单",
            binding: { dateKeyID: DATE_KEY, titleKeyID: TITLE_KEY },
            fieldTypes: { [DATE_KEY]: "date" },
            // 属性视图单次最多 63 天，测试里给出覆盖样本日期的窗口
            window: () => ({ start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 10, 1) }),
        },
        fakeRows(managed, log),
    );
    return { store: local, log };
}

beforeEach(() => {
    resetKernelMock();
});

describe("AvLocalStore.refresh：只认领本插件写入的行", () => {
    it("带 custom-caldav-uid 的行被认领，用户手写的行被忽略", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: renderPayload([
                { id: "row-mine", title: "我的同步行", start: Date.UTC(2026, 9, 6) },
                { id: "row-user", title: "用户手写", start: Date.UTC(2026, 9, 7) },
            ]),
        });
        const { store: local } = store({ "row-mine": "uid-1" });
        const index = await local.refresh();
        expect([...index.keys()]).toEqual(["uid-1"]);
        expect(index.get("uid-1")?.blockID).toBe("row-mine");
        expect(index.has("row-user")).toBe(false);
    });

    it("属性读取失败时该行被跳过，而不是抛错中断整轮同步", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: renderPayload([{ id: "row-mine", title: "x", start: Date.UTC(2026, 9, 6) }]),
        });
        const rows = new AvRowStore(
            { avID: AV, binding: { dateKeyID: DATE_KEY } },
            {
                readAttrs: async () => {
                    throw new Error("kernel busy");
                },
            },
        );
        const local = new AvLocalStore(
            { avID: AV, zone: "Asia/Shanghai", binding: { dateKeyID: DATE_KEY } },
            rows,
        );
        await expect(local.refresh()).resolves.toEqual(new Map());
    });
});

describe("AvLocalStore 写路径", () => {
    it("create 新增一行并返回行块 ID", async () => {
        const { store: local, log } = store({});
        const link = await local.create(event("uid-9"));
        expect(link.blockID).toBe("row-new");
        expect(log).toContain("append");
        expect(log.some((item) => item.startsWith("attrs:row-new:uid-9"))).toBe(true);
    });

    it("update 走 batchSetAttributeViewBlockAttrs", async () => {
        const { store: local, log } = store({});
        await local.update({ uid: "uid-9", blockID: "row-9", rootID: AV }, event("uid-9", "改过"));
        expect(log).toContain("setCells:row-9");
    });

    it("unlink / deleteDocument 走 removeAttributeViewBlocks", async () => {
        const first = store({});
        await first.store.unlink({ uid: "uid-9", blockID: "row-9", rootID: AV });
        expect(first.log).toContain("removeRows:row-9");

        const second = store({});
        await second.store.deleteDocument("row-8");
        expect(second.log).toContain("removeRows:row-8");
    });

    it("loadEvent 用 refresh 记录的 UID 回填，并保留行内数据", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: renderPayload([
                { id: "row-mine", title: "数据库里的标题", start: Date.UTC(2026, 9, 6, 1) },
            ]),
        });
        const { store: local } = store({ "row-mine": "uid-1" });
        await local.refresh();
        const loaded = await local.loadEvent("row-mine");
        expect(loaded?.uid).toBe("uid-1");
        expect(loaded?.title).toBe("数据库里的标题");
        expect(loaded?.readOnly).toBe(false);
    });

    it("未知行块返回 undefined（表示条目已不存在）", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: renderPayload([]),
        });
        const { store: local } = store({});
        expect(await local.loadEvent("row-unknown")).toBeUndefined();
    });
});

describe("AvLocalStore：用「插件标识」列识别插件行（不再依赖块属性）", () => {
    it("标识列有值的行被认领，用户手写的行被忽略，且不读块属性", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: renderPayload([
                { id: "row-mine", title: "插件写的行", start: Date.UTC(2026, 9, 6), marker: "caldav:uid-1" },
                { id: "row-user", title: "用户手写", start: Date.UTC(2026, 9, 7) },
            ]),
        });
        const readAttrs = vi.fn(async (_blockID: string): Promise<Record<string, string>> => ({}));
        const rows = new AvRowStore(
            {
                avID: AV,
                binding: { dateKeyID: DATE_KEY, titleKeyID: TITLE_KEY, markerKeyID: MARKER_KEY },
                fieldTypes: { [DATE_KEY]: "date", [TITLE_KEY]: "text", [MARKER_KEY]: "text" },
            },
            { readAttrs },
        );
        const local = new AvLocalStore(
            {
                avID: AV,
                zone: "Asia/Shanghai",
                binding: { dateKeyID: DATE_KEY, titleKeyID: TITLE_KEY, markerKeyID: MARKER_KEY },
                fieldTypes: { [DATE_KEY]: "date", [TITLE_KEY]: "text", [MARKER_KEY]: "text" },
                window: () => ({ start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 10, 1) }),
            },
            rows,
        );
        const index = await local.refresh();
        expect([...index.keys()]).toEqual(["uid-1"]);
        expect(index.get("uid-1")?.blockID).toBe("row-mine");
        // 关键：标识列可用时完全不读块属性（因此不会出现 tree not found）
        expect(readAttrs).not.toHaveBeenCalled();
    });
});

describe("AvLocalStore 认领新行（内核不返回行 ID）", () => {
    it("写入后按「新出现的行 + 日期标题匹配」立即认领，无需等下一轮", async () => {
        let round = 0;
        responder.current = () => {
            round++;
            // 第 1 次读取（写入前）：已有一行；之后：多出刚写入的那一行
            const rows =
                round <= 1
                    ? [{ id: "row-old", title: "旧任务", start: Date.UTC(2026, 9, 1) }]
                    : [
                          { id: "row-old", title: "旧任务", start: Date.UTC(2026, 9, 1) },
                          { id: "row-new", title: "写周报", start: Date.UTC(2026, 9, 6, 2) },
                      ];
            return { code: 0, msg: "", data: renderPayload(rows) };
        };
        const written: Array<[string, string]> = [];
        const rows = new AvRowStore(
            { avID: AV, binding: { dateKeyID: DATE_KEY, titleKeyID: TITLE_KEY }, fieldTypes: { [DATE_KEY]: "date" } },
            {
                append: async () => null,
                writeAttrs: async (blockID, attrs) => {
                    written.push([blockID, attrs["custom-caldav-uid"] ?? ""]);
                },
            },
        );
        const local = new AvLocalStore(
            {
                avID: AV,
                zone: "Asia/Shanghai",
                binding: { dateKeyID: DATE_KEY, titleKeyID: TITLE_KEY },
                fieldTypes: { [DATE_KEY]: "date" },
                window: () => ({ start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 10, 1) }),
            },
            rows,
        );
        const link = await local.create(event("uid-9", "写周报"));
        expect(link.blockID).toBe("row-new");
        // 认领成功后应把远端身份写进行属性
        expect(written).toContainEqual(["row-new", "uid-9"]);
    });

    it("匹配不到时不硬认领（返回空 ID，交给下一轮 refresh）", async () => {
        responder.current = () => ({
            code: 0,
            msg: "",
            data: renderPayload([{ id: "row-old", title: "旧任务", start: Date.UTC(2026, 9, 1) }]),
        });
        const rows = new AvRowStore(
            { avID: AV, binding: { dateKeyID: DATE_KEY, titleKeyID: TITLE_KEY }, fieldTypes: { [DATE_KEY]: "date" } },
            { append: async () => null, writeAttrs: async () => undefined },
        );
        const local = new AvLocalStore(
            {
                avID: AV,
                zone: "Asia/Shanghai",
                binding: { dateKeyID: DATE_KEY, titleKeyID: TITLE_KEY },
                fieldTypes: { [DATE_KEY]: "date" },
                window: () => ({ start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 10, 1) }),
            },
            rows,
        );
        const link = await local.create(event("uid-9", "写周报"));
        expect(link.blockID).toBe("");
    });
});

describe("AvLocalStore 与行格式契约", () => {
    it("写入的单元格形态与内核读回一致（日期是毫秒数字）", async () => {
        let captured: AvRawValue[] = [];
        const rows = new AvRowStore(
            { avID: AV, binding: { dateKeyID: DATE_KEY, titleKeyID: TITLE_KEY }, fieldTypes: { [DATE_KEY]: "date" } },
            {
                append: async (_avID, blocksValues) => {
                    captured = blocksValues[0];
                    return { blockIDs: ["row-x"] };
                },
                writeAttrs: async () => undefined,
            },
        );
        const local = new AvLocalStore(
            {
                avID: AV,
                zone: "Asia/Shanghai",
                binding: { dateKeyID: DATE_KEY, titleKeyID: TITLE_KEY },
                fieldTypes: { [DATE_KEY]: "date" },
            },
            rows,
        );
        await local.create(event("uid-1", "写周报"));
        const dateCell = captured.find((cell) => cell.keyID === DATE_KEY);
        // 写入形态：{keyID, type:'date', date:{content}}
        expect((dateCell?.date as { content?: number })?.content).toBe(Date.UTC(2026, 9, 6, 2));
        const titleCell = captured.find((cell) => cell.keyID === TITLE_KEY);
        expect((titleCell?.block as { content?: string })?.content).toBe("写周报");
    });
});
