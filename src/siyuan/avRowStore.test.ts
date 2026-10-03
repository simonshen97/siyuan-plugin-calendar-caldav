import { describe, expect, it, vi } from "vitest";
import { AvRowStore, buildCellValue, toRawValue, uidFromMarker, type AvCellValue } from "./avRowStore";
import type { AvRawValue } from "../kernel/api";
import type { CalendarEvent } from "../types";

/**
 * 数据库块（属性视图）行写入的格式回归。
 *
 * 这些断言的来源是内核**读回**的形态（见 `avStore.ts` 的解析侧）：
 * 只要写入形态与读回不一致，数据库里就会显示为空值——这是最容易出错的地方。
 */

const AV = "20260101120000-abcdefg";

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        uid: "uid-1",
        calendar: "caldav:acct:http://x/dav/projects/3/",
        calendarName: "任务清单",
        sourceKind: "caldav",
        title: "写周报",
        description: "本周进展",
        location: "会议室",
        start: Date.UTC(2026, 9, 6, 2),
        end: Date.UTC(2026, 9, 6, 3),
        allDay: false,
        ...overrides,
    };
}

function store(
    types: Record<string, string>,
    binding = {
        dateKeyID: "date-1",
        titleKeyID: "title-1",
        endKeyID: "end-1",
        descriptionKeyID: "desc-1",
        calendarKeyID: "source-1",
        uidKeyID: "uid-col",
        statusKeyID: "status-1",
    },
): AvRowStore {
    return new AvRowStore({ avID: AV, binding, fieldTypes: types });
}

function valueOf(cells: AvCellValue[], keyID: string): unknown {
    return cells.find((cell) => cell.keyID === keyID)?.value;
}

describe("buildCellValue：与内核读回形态对齐", () => {
    it("日期列是 {content: 毫秒, isNotEmpty}", () => {
        expect(buildCellValue("date", 1_700_000_000_000)).toEqual({ content: 1_700_000_000_000, isNotEmpty: true });
    });

    it("文本列是 block.content（内核读回形态）", () => {
        expect(buildCellValue("text", "写周报")).toEqual({ block: { content: "写周报" } });
    });

    it("数字列是 {number:{content, isNotEmpty}}", () => {
        expect(buildCellValue("number", 42)).toEqual({ number: { content: 42, isNotEmpty: true } });
    });

    it("单选 / 多选 / 复选框 / 链接", () => {
        expect(buildCellValue("select", "未完成")).toEqual({ content: "未完成" });
        expect(buildCellValue("mSelect", "未完成")).toEqual([{ content: "未完成" }]);
        // checkbox 是对象（内核 AVValueCheckbox），不是布尔
        expect(buildCellValue("checkbox", true)).toEqual({ checked: true });
        expect(buildCellValue("url", "https://example.com")).toEqual({ content: "https://example.com" });
    });

    it("空值不写入（返回 undefined）", () => {
        expect(buildCellValue("text", "")).toBeUndefined();
        expect(buildCellValue("text", undefined)).toBeUndefined();
        expect(buildCellValue("date", "不是数字")).toBeUndefined();
    });

    it("未知列类型退化为文本，而不是丢弃", () => {
        expect(buildCellValue("template", "x")).toEqual({ block: { content: "x" } });
    });
});

describe("AvRowStore.buildRow", () => {
    it("写入全部已绑定列，且日期为毫秒数字", () => {
        const cells = store({
            "date-1": "date",
            "title-1": "text",
            "end-1": "date",
            "desc-1": "text",
            "source-1": "text",
            "uid-col": "text",
            "status-1": "select",
        }).buildRow(event());

        expect(valueOf(cells, "date-1")).toEqual({ content: Date.UTC(2026, 9, 6, 2), isNotEmpty: true });
        expect(valueOf(cells, "title-1")).toEqual({ block: { content: "写周报" } });
        expect(valueOf(cells, "end-1")).toEqual({ content: Date.UTC(2026, 9, 6, 3), isNotEmpty: true });
        expect(valueOf(cells, "desc-1")).toEqual({ block: { content: "本周进展" } });
        expect(valueOf(cells, "source-1")).toEqual({ block: { content: "任务清单" } });
        expect(valueOf(cells, "uid-col")).toEqual({ block: { content: "uid-1" } });
        expect(valueOf(cells, "status-1")).toEqual({ content: "未完成" });
    });

    it("未绑定的列一律不写（不覆盖用户手填的字段）", () => {
        const cells = new AvRowStore({
            avID: AV,
            binding: { dateKeyID: "date-1" },
            fieldTypes: { "date-1": "date" },
        }).buildRow(event());
        expect(cells.map((cell) => cell.keyID)).toEqual(["date-1"]);
    });

    it("没有描述/地点时对应列被跳过，而不是写入空字符串", () => {
        const cells = store({
            "date-1": "date",
            "title-1": "text",
            "desc-1": "text",
            "end-1": "date",
        }).buildRow(event({ description: undefined, location: undefined }));
        expect(valueOf(cells, "desc-1")).toBeUndefined();
    });

    it("状态列绑到复选框列时被跳过（否则会变成「一排勾」）", () => {
        const cells = store({ "date-1": "date", "status-1": "checkbox" }).buildRow(event());
        expect(valueOf(cells, "status-1")).toBeUndefined();
        // 其余列照常写入
        expect(valueOf(cells, "date-1")).toBeDefined();
    });

    it("来源列优先写「来源名称」（账户名/数据源名），而不是日历名", () => {
        const withSource = new AvRowStore({
            avID: AV,
            binding: { dateKeyID: "date-1", calendarKeyID: "source-1" },
            fieldTypes: { "date-1": "date", "source-1": "text" },
            sourceLabel: "QQ 邮箱",
        }).buildRow(event());
        expect(valueOf(withSource, "source-1")).toEqual({ block: { content: "QQ 邮箱" } });

        // 未配置来源名称时退回日历名
        const withoutSource = store({ "date-1": "date", "source-1": "text" }).buildRow(event());
        expect(valueOf(withoutSource, "source-1")).toEqual({ block: { content: "任务清单" } });
    });

    it("「插件标识」列写入 caldav:<UID>（用于识别插件管理的行）", () => {
        const cells = new AvRowStore({
            avID: AV,
            binding: { dateKeyID: "date-1", markerKeyID: "marker-1" },
            fieldTypes: { "date-1": "date", "marker-1": "text" },
        }).buildRow(event());
        expect(valueOf(cells, "marker-1")).toEqual({ block: { content: "caldav:uid-1" } });
    });

    it("未绑定「插件标识」列时不写该列", () => {
        const cells = new AvRowStore({
            avID: AV,
            binding: { dateKeyID: "date-1" },
            fieldTypes: { "date-1": "date" },
        }).buildRow(event());
        expect(cells.map((cell) => cell.keyID)).toEqual(["date-1"]);
    });

    it("绑定「插件标识」列后不再写行块属性（彻底避开 tree not found）", async () => {
        const writeAttrs = vi.fn(async (_blockID: string, _attrs: Record<string, string>) => undefined);
        const av = new AvRowStore(
            {
                avID: AV,
                binding: { dateKeyID: "date-1", markerKeyID: "marker-1" },
                fieldTypes: { "date-1": "date", "marker-1": "text" },
            },
            { append: async () => ({ blockIDs: ["row-1"] }), writeAttrs },
        );
        const blockID = await av.createRow(event());
        expect(blockID).toBe("row-1");
        expect(writeAttrs).not.toHaveBeenCalled();
        // 显式补写属性时也应直接跳过
        await av.writeRowAttributes("row-1", event());
        expect(writeAttrs).not.toHaveBeenCalled();
    });

    it("uidFromMarker 只认本插件的标识", () => {
        expect(uidFromMarker("caldav:uid-1")).toBe("uid-1");
        expect(uidFromMarker("caldav:")).toBeUndefined();
        expect(uidFromMarker("用户手写")).toBeUndefined();
        expect(uidFromMarker(undefined)).toBeUndefined();
    });

    it("状态列在文本类型下写文本、在 select 类型下写选项", () => {
        const textCells = store({ "date-1": "date", "status-1": "text" }).buildRow(event());
        expect(valueOf(textCells, "status-1")).toEqual({ block: { content: "未完成" } });
        const selectCells = store({ "date-1": "date", "status-1": "select" }).buildRow(event());
        expect(valueOf(selectCells, "status-1")).toEqual({ content: "未完成" });
    });
});

describe("toRawValue：写入用的裸值形态", () => {
    it("日期写成 keyID + type:date + date.content", () => {
        expect(toRawValue("d", "date", { content: 123, isNotEmpty: true })).toEqual({
            keyID: "d",
            type: "date",
            date: { content: 123, isNotEmpty: true, isNotTime: false },
        });
    });

    it("文本同时填 text 与 block 两种负载（主键列与文本列都能写入）", () => {
        expect(toRawValue("t", "text", { block: { content: "标题" } })).toEqual({
            keyID: "t",
            type: "text",
            text: { content: "标题" },
            block: { content: "标题" },
        });
    });

    it("数字 / 单选 / 多选 / 复选框", () => {
        expect(toRawValue("n", "number", { number: { content: 5, isNotEmpty: true } })).toMatchObject({
            type: "number",
        });
        expect(toRawValue("s", "select", { content: "未完成" })).toMatchObject({ type: "select" });
        expect(toRawValue("m", "mSelect", [{ content: "a" }])).toMatchObject({ type: "mSelect" });
        // 必须是对象：裸布尔会被内核拒绝
        expect(toRawValue("c", "checkbox", true)).toEqual({
            keyID: "c",
            type: "checkbox",
            checkbox: { checked: true },
        });
        expect(toRawValue("c2", "checkbox", false)).toMatchObject({ checkbox: { checked: false } });
    });

    it("每种列类型的裸值都不会出现「裸标量」字段（内核按结构体解码）", () => {
        const cases: Array<[string, unknown]> = [
            ["date", { content: 1, isNotEmpty: true }],
            ["number", { number: { content: 1, isNotEmpty: true } }],
            ["text", { block: { content: "x" } }],
            ["select", { content: "x" }],
            ["mSelect", [{ content: "x" }]],
            ["checkbox", { checked: true }],
            ["url", { content: "https://x" }],
        ];
        for (const [type, value] of cases) {
            const raw = toRawValue("k", type, value);
            expect(raw, `${type} 应能转换`).toBeDefined();
            const { keyID: _keyID, type: _type, ...payload } = raw as Record<string, unknown>;
            const inner = Object.values(payload)[0];
            // 除数组外，负载必须是对象：布尔/字符串/数字都会被 Go 的解码器拒绝
            if (!Array.isArray(inner)) {
                expect(typeof inner, `${type} 的负载应为对象`).toBe("object");
            }
        }
    });

    it("空值返回 undefined（不写该列）", () => {
        expect(toRawValue("t", "text", undefined)).toBeUndefined();
        expect(toRawValue("d", "date", {})).toBeUndefined();
    });
});

describe("AvRowStore 写操作", () => {
    it("createRow 用内核的 blocksValues 参数（不是 rowValues），并把远端身份写进行属性", async () => {
        const append = vi.fn(async (_avID: string, _blocksValues: AvRawValue[][]) => ({ blockIDs: ["row-1"] }));
        const writeAttrs = vi.fn(async (_blockID: string, _attrs: Record<string, string>) => undefined);
        const av = new AvRowStore(
            { avID: AV, binding: { dateKeyID: "date-1", titleKeyID: "title-1" }, fieldTypes: { "date-1": "date" } },
            { append, writeAttrs },
        );
        const blockID = await av.createRow(event());
        expect(blockID).toBe("row-1");
        expect(append).toHaveBeenCalledTimes(1);
        const [avID, blocksValues] = append.mock.calls[0];
        expect(avID).toBe(AV);
        // 必须是「行数组的数组」：blocksValues[0] 直接就是该行的单元格数组
        expect(Array.isArray(blocksValues)).toBe(true);
        expect(Array.isArray(blocksValues[0])).toBe(true);
        const cells = blocksValues[0];
        const dateCell = cells.find((cell) => cell.keyID === "date-1");
        expect(dateCell?.date).toMatchObject({ content: event().start, isNotEmpty: true });
        const titleCell = cells.find((cell) => cell.keyID === "title-1");
        expect(titleCell?.block).toEqual({ content: "写周报" });
        expect(writeAttrs).toHaveBeenCalledWith("row-1", {
            "custom-caldav-uid": "uid-1",
            "custom-caldav-calendar": event().calendar,
        });
    });

    it("内核不返回块 ID 时 createRow 返回空串（由调用方回读认领）", async () => {
        const append = vi.fn(async (_avID: string, _blocksValues: AvRawValue[][]) => null);
        const av = new AvRowStore(
            { avID: AV, binding: { dateKeyID: "date-1" }, fieldTypes: { "date-1": "date" } },
            { append },
        );
        await expect(av.createRow(event())).resolves.toBe("");
    });

    it("updateRow 使用内核 batchSetAttributeViewBlockAttrs（itemID 放在每个 value 里）", async () => {
        const setCells = vi.fn(
            async (
                _avID: string,
                _itemID: string,
                _values: Array<{ keyID: string; value: unknown }>,
            ) => undefined,
        );
        const writeAttrs = vi.fn(async (_blockID: string, _attrs: Record<string, string>) => undefined);
        const av = new AvRowStore(
            { avID: AV, binding: { dateKeyID: "date-1" }, fieldTypes: { "date-1": "date" } },
            { setCells, writeAttrs },
        );
        await av.updateRow("row-9", event());
        expect(setCells).toHaveBeenCalledTimes(1);
        const [avID, itemID, values] = setCells.mock.calls[0];
        expect(avID).toBe(AV);
        expect(itemID).toBe("row-9");
        expect(values.some((cell) => cell.keyID === "date-1")).toBe(true);
    });

    it("deleteRow 使用内核 removeAttributeViewBlocks（不是事务动作）", async () => {
        const removeRows = vi.fn(async (_avID: string, _srcIDs: string[]) => undefined);
        const av = new AvRowStore({ avID: AV, binding: { dateKeyID: "date-1" } }, { removeRows });
        await av.deleteRow("row-9");
        expect(removeRows).toHaveBeenCalledWith(AV, ["row-9"]);
    });

    it("deleteRows 一次请求删除多行", async () => {
        const removeRows = vi.fn(async (_avID: string, _srcIDs: string[]) => undefined);
        const av = new AvRowStore({ avID: AV, binding: { dateKeyID: "date-1" } }, { removeRows });
        await av.deleteRows(["a", "b", "c"]);
        expect(removeRows).toHaveBeenCalledWith(AV, ["a", "b", "c"]);
    });

    it("只认领带本插件属性的行（用户手写的行绝不被接管）", async () => {
        const readAttrs = vi.fn(
            async (blockID: string): Promise<Record<string, string>> =>
                blockID === "mine" ? { "custom-caldav-uid": "uid-1" } : { "custom-other": "x" },
        );
        const av = new AvRowStore({ avID: AV, binding: { dateKeyID: "date-1" } }, { readAttrs });
        expect(await av.readRowIdentity("mine")).toEqual({ uid: "uid-1", calendar: "" });
        expect(await av.readRowIdentity("theirs")).toBeUndefined();
        expect(av.attrNames()).toEqual({ uid: "custom-caldav-uid", calendar: "custom-caldav-calendar" });
    });

    it("属性读取失败时不抛错（该行视为非本插件管理）", async () => {
        const av = new AvRowStore(
            { avID: AV, binding: { dateKeyID: "date-1" } },
            { readAttrs: async () => { throw new Error("kernel busy"); } },
        );
        expect(await av.readRowIdentity("row-x")).toBeUndefined();
    });
});
