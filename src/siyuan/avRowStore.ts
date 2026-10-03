import type { CalendarEvent } from "../types";
import {
    appendAttributeViewDetachedBlocksWithValues,
    batchSetAttributeViewBlockAttrs,
    getBlockAttrs,
    removeAttributeViewBlocks,
    setAttributeViewBlockAttr,
    setBlockAttrs,
    type AvRawValue,
} from "../kernel/api";
import { onelineJson } from "../util/logger";

/**
 * 把 CalDAV/QQ 邮箱/企业微信/Vikunja 等来源的事件写入思源「数据库块」（属性视图）的一行。
 *
 * 关键事实（已对照内核与社区文档核实）：
 * - 新增行：`POST /api/av/appendAttributeViewDetachedBlocksWithValues`
 *   （`{avID, rowValues: [{cellValues: [{keyID, value}]}]}`，返回 `data.blockIDs`）；
 * - 修改行：`/api/transactions` 的 `updateAttrViewCell` 动作；
 * - 删除行：`/api/transactions` 的 `removeAttrViewBlock` 动作；
 * - 单元格值必须与内核**读回**的形态一致（见 `avStore.ts` 的解析侧），
 *   否则数据库里会显示为空值。本模块的 `buildCellValue` 就是这份格式的唯一来源。
 *
 * 远端身份（UID/href/etag）写在行块的自定义属性里，因此不需要额外映射表，
 * 也能在数据库里直接看出某一行对应哪个远端事件。
 */

/** 数据库同步的字段绑定（均为数据库列的 keyID） */
export interface AvSyncBinding {
    /** 日期列（必填）：写入事件开始时间，日历视图据此排布 */
    dateKeyID: string;
    /** 标题列 */
    titleKeyID?: string;
    /** 结束时间列 */
    endKeyID?: string;
    /** 描述列 */
    descriptionKeyID?: string;
    /** 来源列（日历名，用于区分 QQ 邮箱 / 企业微信 / Vikunja） */
    calendarKeyID?: string;
    /** 唯一标识列（写入远端 UID） */
    uidKeyID?: string;
    /** 状态列 */
    statusKeyID?: string;
    /** 地点列 */
    locationKeyID?: string;
    /**
     * 「插件标识」列（建议绑定）。
     *
     * 插件写入 `caldav:<远端 UID>`：既是「这行归插件管」的判据，也顺便记录远端 UID。
     * **用户手写的行该列为空，因此不会被插件改写或删除。**
     */
    markerKeyID?: string;
}

export interface AvSyncOptions {
    /** 属性视图 ID（avID），即数据库块 ID */
    avID: string;
    binding: AvSyncBinding;
    /** 列 keyID → 列类型；缺失时按 text 处理 */
    fieldTypes?: Record<string, string>;
    zone?: string;
    /** 行块属性前缀，默认 custom-caldav */
    attrPrefix?: string;
    /** 来源列写入的名称（默认用账户名，便于区分 QQ 邮箱 / 企业微信 / Vikunja） */
    sourceLabel?: string;
    /** 诊断日志 */
    log?: (message: string, ...rest: unknown[]) => void;
}

export interface AvCellValue {
    keyID: string;
    value: unknown;
}

const DATE_TYPES = new Set(["date", "created", "updated"]);

/** 「插件标识」列的值格式：`caldav:<远端 UID>` */
export const MARKER_PREFIX = "caldav:";

export function markerValue(uid: string): string {
    return `${MARKER_PREFIX}${uid}`;
}

/** 从「插件标识」列的值里取回远端 UID；不是本插件写的返回 undefined */
export function uidFromMarker(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const text = value.trim();
    return text.startsWith(MARKER_PREFIX) ? text.slice(MARKER_PREFIX.length) || undefined : undefined;
}

/**
 * 从内核响应里尽量挖出新行的 ID。
 *
 * `appendAttributeViewDetachedBlocksWithValues` 按规范返回 `null`，但不同版本可能
 * 附带 `blockIDs` / `itemIDs` / `ids`；能拿到就用，拿不到返回空串，
 * 由上层通过「回读属性视图比对」来认领（见 `AvLocalStore.create`）。
 */
export function extractNewBlockID(response: unknown): string {
    if (typeof response === "string") {
        return response.trim();
    }
    if (!response || typeof response !== "object") {
        return "";
    }
    const record = response as Record<string, unknown>;
    for (const key of ["blockIDs", "itemIDs", "ids", "ID", "id", "blockID", "itemID"]) {
        const value = record[key];
        if (typeof value === "string" && value) {
            return value;
        }
        if (Array.isArray(value) && value.length && typeof value[0] === "string") {
            return value[0];
        }
    }
    return "";
}

/**
 * 由「列类型 + 取值」生成写入用的单元格载荷（`renderAttributeView` 读回形态的子集）。
 *
 * 返回 `undefined` 表示不写这一列（例如事件没有描述）。
 */
export function buildCellValue(
    fieldType: string | undefined,
    value: string | number | boolean | undefined,
): unknown {
    if (value === undefined || value === "") {
        return undefined;
    }
    const type = (fieldType ?? "text").toLowerCase();
    if (DATE_TYPES.has(type)) {
        return typeof value === "number" ? { content: value, isNotEmpty: true } : undefined;
    }
    switch (type) {
        case "number":
            return typeof value === "number" ? { number: { content: value, isNotEmpty: true } } : undefined;
        case "select":
            return { content: String(value) };
        case "mselect":
            return [{ content: String(value) }];
        case "checkbox":
            // 与 toRawValue 保持一致：内核的 checkbox 是对象而非布尔
            return { checked: Boolean(value) };
        case "url":
            return { content: String(value) };
        case "text":
        case "phone":
        case "email":
        case "":
            // 文本与「主键」列在内核里都是 block 类型：读回是 block.content
            return { block: { content: String(value) } };
        default:
            // 未知类型（模板列、关系列等）：一律按文本写入，至少不会写成空
            return { block: { content: String(value) } };
    }
}

/** 把「列类型 + 取值」包装成内核 `blocksValues` 需要的 `{keyID, type, ...}` 结构 */
export function toRawValue(keyID: string, fieldType: string | undefined, value: unknown): AvRawValue | undefined {
    const type = (fieldType ?? "text").toLowerCase();
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const asRecord = (input: unknown): Record<string, unknown> =>
        input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const record = asRecord(value);
    /** 兼容三种取值形态：{content}、{block:{content}}、{text:{content}} */
    const readText = (): string => {
        if (typeof value === "string") {
            return value;
        }
        if (typeof record.content === "string") {
            return record.content;
        }
        const block = asRecord(record.block);
        if (typeof block.content === "string") {
            return block.content;
        }
        const text = asRecord(record.text);
        if (typeof text.content === "string") {
            return text.content;
        }
        return record.content === undefined ? "" : String(record.content);
    };
    if (DATE_TYPES.has(type)) {
        const direct = typeof value === "number" ? value : undefined;
        const content = direct ?? (typeof record.content === "number" ? record.content : undefined);
        if (content === undefined) {
            return undefined;
        }
        return {
            keyID,
            type: "date",
            date: { content, isNotEmpty: true, isNotTime: Boolean(record.isNotTime) },
        };
    }
    if (type === "number") {
        const inner = asRecord(record.number);
        const content = typeof value === "number" ? value : typeof inner.content === "number" ? inner.content : undefined;
        if (content === undefined) {
            return undefined;
        }
        return { keyID, type: "number", number: { content, isNotEmpty: true } };
    }
    if (type === "select") {
        const content = readText() || String(record.content ?? "");
        return { keyID, type: "select", mSelect: [{ content }] };
    }
    if (type === "mselect") {
        const list = Array.isArray(value) ? value : [{ content: readText() }];
        return {
            keyID,
            type: "mSelect",
            mSelect: list.map((item) => ({ content: String(asRecord(item).content ?? "") })),
        };
    }
    if (type === "checkbox") {
        // 内核的 checkbox 是对象（apicontract.AVValueCheckbox），发裸布尔会报
        // `cannot unmarshal bool into Go struct field AVValue.checkbox`
        return { keyID, type: "checkbox", checkbox: { checked: Boolean(value) } };
    }
    // 文本 / 主键 / url / 未知类型
    //
    // 内核 `av.Value` 同时有 `Text` 与 `Block` 两个字段：主键列读回是 `block.content`，
    // 普通文本列读回是 `text.content`。为了让两种列都能写入，这里**同时**填 `text` 与 `block`
    // 两种负载（内核只会采用与列类型匹配的那个）。
    const content = readText();
    return {
        keyID,
        type: type === "url" ? "url" : "text",
        text: { content },
        block: { content },
    };
}

/** 读取行块属性的最小依赖（便于测试注入） */
export type RowAttrReader = (blockID: string) => Promise<Record<string, string>>;

export interface AvRowStoreDeps {
    readAttrs: RowAttrReader;
    /**
     * 新增行：把若干行的单元格值写入属性视图。
     * 返回内核接口的原始响应（该接口按规范返回 null，不返回块 ID）。
     */
    append: (avID: string, blocksValues: AvRawValue[][]) => Promise<unknown>;
    /** 设置单个单元格（用于在行 ID 已知时补写/纠正值） */
    setCell?: (avID: string, keyID: string, itemID: string, value: unknown) => Promise<unknown>;
    /** 批量设置单元格值（内核 `batchSetAttributeViewBlockAttrs`：itemID 放在每个 value 里） */
    setCells?: (
        avID: string,
        itemID: string,
        values: Array<{ keyID: string; value: unknown }>,
    ) => Promise<unknown>;
    /** 删除行（内核 `removeAttributeViewBlocks`） */
    removeRows?: (avID: string, srcIDs: string[]) => Promise<unknown>;
    /**
     * 兼容旧签名：内部派发到上面两个方法。
     * 保留是为了不破坏既有测试注入，新代码请直接用 `setCells` / `removeRows`。
     */
    write?: (operations: Array<{ action: string; [key: string]: unknown }>) => Promise<unknown>;
    writeAttrs: (blockID: string, attrs: Record<string, string>) => Promise<unknown>;
}

const defaultDeps: AvRowStoreDeps = {
    readAttrs: (blockID) => getBlockAttrs(blockID),
    append: (avID, blocksValues) => appendAttributeViewDetachedBlocksWithValues(avID, blocksValues),
    setCell: (avID, keyID, itemID, value) => setAttributeViewBlockAttr(avID, keyID, itemID, value),
    setCells: (avID, itemID, values) => batchSetAttributeViewBlockAttrs(avID, itemID, values),
    removeRows: (avID, srcIDs) => removeAttributeViewBlocks(avID, srcIDs),
    writeAttrs: (blockID, attrs) => setBlockAttrs(blockID, attrs),
};

export class AvRowStore {
    private readonly prefix: string;
    private readonly types: Record<string, string>;
    private readonly deps: AvRowStoreDeps;

    constructor(
        private readonly options: AvSyncOptions,
        deps: Partial<AvRowStoreDeps> = {},
    ) {
        this.prefix = options.attrPrefix ?? "custom-caldav";
        this.types = options.fieldTypes ?? {};
        this.deps = { ...defaultDeps, ...deps };
    }

    get avID(): string {
        return this.options.avID;
    }

    get binding(): AvSyncBinding {
        return this.options.binding;
    }

    /** 数据库中已存在的行：块 ID（行 ID） */
    rowID(event: CalendarEvent): string | undefined {
        return event.siyuan?.blockID;
    }

    private cell(keyID: string | undefined, value: string | number | boolean | undefined): AvCellValue | undefined {
        if (!keyID) {
            return undefined;
        }
        const built = buildCellValue(this.types[keyID], value);
        return built === undefined ? undefined : { keyID, value: built };
    }

    /**
     * 把事件映射为一行单元格。
     *
     * 只写入已绑定的列，未绑定的列一律不碰，避免覆盖用户自己手填的字段。
     */
    buildRow(event: CalendarEvent): AvCellValue[] {
        const binding = this.options.binding;
        const candidates: Array<AvCellValue | undefined> = [
            this.cell(binding.dateKeyID, Number.isFinite(event.start) ? event.start : undefined),
            this.cell(binding.titleKeyID, event.title || "(未命名)"),
            this.cell(binding.endKeyID, Number.isFinite(event.end) ? event.end : undefined),
            this.cell(binding.descriptionKeyID, event.description),
            this.cell(binding.locationKeyID, event.location),
            this.cell(binding.calendarKeyID, this.sourceName(event)),
            this.cell(binding.uidKeyID, event.uid),
            this.cell(binding.statusKeyID, this.statusLabel(event)),
            // 「插件标识」列：写入 caldav:<远端 UID>，用于识别插件管理的行
            this.cell(binding.markerKeyID, binding.markerKeyID ? markerValue(event.uid) : undefined),
        ];
        const row = candidates.filter((item): item is AvCellValue => item !== undefined);
        // 安全过滤：被拦下的列会在日志里说明原因，便于用户改绑定，而不是悄悄写错。
        return row.filter((item) => {
            const type = (this.types[item.keyID] ?? "text").toLowerCase();
            const isDateField = item.keyID === binding.dateKeyID || item.keyID === binding.endKeyID;
            if (type === "checkbox" && item.keyID === binding.statusKeyID) {
                this.options.log?.(
                    "已跳过状态列绑定：该列是复选框类型（只能表示是/否）。" +
                        "请改用文本列写「未完成/已完成」，或在设置里取消绑定。",
                );
                return false;
            }
            if (isDateField && !DATE_TYPES.has(type)) {
                this.options.log?.(`日期/结束列绑定的列类型是 ${type}，已跳过（请绑定 date 类型列）`);
                return false;
            }
            return true;
        });
    }

    /**
     * 来源列要写入的名称。
     *
     * 优先用「来源名称」——也就是 CalDAV 账户名或思源数据源在设置里起的名字
     * （例如「QQ 邮箱」「企业微信」「Vikunja」），这样在一个数据库里能直接区分来源；
     * 没配置时退回日历名。
     */
    private sourceName(event: CalendarEvent): string {
        return this.options.sourceLabel?.trim() || event.calendarName || event.calendar;
    }

    private statusLabel(event: CalendarEvent): string {        if (event.status === "CANCELLED") {
            return "已取消";
        }
        if (event.status === "TENTATIVE") {
            return "待定";
        }
        return event.isRecurringInstance ? "重复实例" : "未完成";
    }

    /** 新增一行，返回新行的块 ID（内核不返回时为 ""，由调用方回读认领） */
    async createRow(event: CalendarEvent): Promise<string> {
        const built = this.buildRow(event);
        if (!built.length) {
            throw new Error("没有可写入的列：请先在设置里绑定至少「日期列」");
        }
        // 内核要求 `[{rowID?, cells:[...]}, ...]`；这里提供最完整的形态：
        // 行对象带 cells 数组，每个单元格是 `{keyID, type, ...}` 的裸值。
        const rawCells: AvRawValue[] = [];
        for (const cell of built) {
            const raw = toRawValue(cell.keyID, this.types[cell.keyID], cell.value);
            if (raw) {
                rawCells.push(raw);
            }
        }
        if (!rawCells.length) {
            throw new Error("单元格值转换为空：请检查列类型是否与绑定字段匹配");
        }
        // 把实际写入的列与类型记进日志：某列没写进去时，可以直接对照是哪个 keyID 的问题
        this.options.log?.(
            `写入数据库行（${rawCells.length} 列）：${rawCells
                .map((cell) => `${cell.keyID}:${String(cell.type ?? "?")}`)
                .join(", ")}`,
        );
        // 内核签名的类型是 `[][]*av.Value`，因此请求体必须是**行数组的数组**：
        //   blocksValues: [[{keyID, type, date:{...}}, {keyID, type, block:{...}}]]
        // 传成 `[{cells:[...]}]`（对象）会得到
        //   `json: cannot unmarshal object into Go value of type []*apicontract.AVValue`
        const blocksValues: AvRawValue[][] = [rawCells];
        this.options.log?.(`→ appendAttributeViewDetachedBlocksWithValues avID=${this.options.avID}`);
        this.options.log?.(`  请求体：${onelineJson({ blocksValues })}`);
        const response: unknown = await this.deps.append(this.options.avID, blocksValues);
        this.options.log?.(`  响应：${onelineJson(response)}`);
        const blockID = extractNewBlockID(response);
        if (!blockID) {
            // 该接口按规范返回 null（不返回块 ID）。此时靠「行 ID 由调用方回读定位」：
            // 适配器会在写入后重新枚举数据库行，用 custom-caldav-uid 找不到就下一轮再认领。
            return "";
        }
        await this.writeRowAttrs(blockID, event);
        return blockID;
    }

    /** 在行 ID 已知时补写单个单元格（用于修正/补齐某列） */
    async setCell(itemID: string, keyID: string, event: CalendarEvent): Promise<void> {
        if (!this.deps.setCell) {
            return;
        }
        const value = this.valueOf(keyID, event);
        const raw = toRawValue(keyID, this.types[keyID], value);
        if (!raw) {
            return;
        }
        const { keyID: _key, ...payload } = raw;
        await this.deps.setCell(this.options.avID, keyID, itemID, payload);
    }

    /** 按列 keyID 取出该事件对应的取值 */
    private valueOf(keyID: string, event: CalendarEvent): unknown {
        const binding = this.options.binding;
        if (keyID === binding.dateKeyID) {
            return buildCellValue(this.types[keyID], Number.isFinite(event.start) ? event.start : undefined);
        }
        if (keyID === binding.titleKeyID) {
            return buildCellValue(this.types[keyID], event.title || "(未命名)");
        }
        if (keyID === binding.endKeyID) {
            return buildCellValue(this.types[keyID], Number.isFinite(event.end) ? event.end : undefined);
        }
        if (keyID === binding.descriptionKeyID) {
            return buildCellValue(this.types[keyID], event.description);
        }
        if (keyID === binding.locationKeyID) {
            return buildCellValue(this.types[keyID], event.location);
        }
        if (keyID === binding.calendarKeyID) {
            return buildCellValue(this.types[keyID], this.sourceName(event));
        }
        if (keyID === binding.uidKeyID) {
            return buildCellValue(this.types[keyID], event.uid);
        }
        if (keyID === binding.statusKeyID) {
            return buildCellValue(this.types[keyID], this.statusLabel(event));
        }
        return undefined;
    }

    /** 更新已有行；`blockID` 为行块 ID（= 属性视图 itemID） */
    async updateRow(blockID: string, event: CalendarEvent): Promise<void> {
        const cells = this.buildRow(event);
        if (cells.length) {
            const values: Array<{ keyID: string; value: unknown }> = [];
            for (const cell of cells) {
                const raw = toRawValue(cell.keyID, this.types[cell.keyID], cell.value);
                if (!raw) {
                    continue;
                }
                const { keyID: _keyID, type: _type, ...payload } = raw;
                values.push({ keyID: cell.keyID, value: payload });
            }
            this.options.log?.(`→ setAttributeViewBlockAttr/Batch avID=${this.options.avID} itemID=${blockID}`);
            this.options.log?.(`  请求体：${onelineJson({ avID: this.options.avID, itemID: blockID, values })}`);
            await this.writeCells(blockID, values);
        }
        await this.writeRowAttrs(blockID, event);
    }

    /** 删除一行（内核 `removeAttributeViewBlocks`，不可用事务动作替代） */
    async deleteRow(blockID: string): Promise<void> {
        await this.deleteRows([blockID]);
    }

    /** 批量删除行：一次请求删多行，减少往返 */
    async deleteRows(blockIDs: string[]): Promise<void> {
        const ids = blockIDs.filter(Boolean);
        if (!ids.length) {
            return;
        }
        this.options.log?.(`→ removeAttributeViewBlocks avID=${this.options.avID} 共 ${ids.length} 行`);
        const response = await this.removeRows(ids);
        this.options.log?.(`  响应：${onelineJson(response)}`);
    }

    /** 派发「批量设置单元格」到注入的实现（优先新接口，兼容旧的 write 签名） */
    private async writeCells(
        itemID: string,
        values: Array<{ keyID: string; value: unknown }>,
    ): Promise<unknown> {
        if (this.deps.setCells) {
            return this.deps.setCells(this.options.avID, itemID, values);
        }
        if (this.deps.write) {
            return this.deps.write([
                {
                    action: "batchSetAttributeViewBlockAttrs",
                    avID: this.options.avID,
                    values: values.map((item) => ({ itemID, ...item })),
                },
            ]);
        }
        return undefined;
    }

    /** 派发「移除行」到注入的实现 */
    private async removeRows(srcIDs: string[]): Promise<unknown> {
        if (this.deps.removeRows) {
            return this.deps.removeRows(this.options.avID, srcIDs);
        }
        if (this.deps.write) {
            return this.deps.write([
                { action: "removeAttributeViewBlocks", avID: this.options.avID, srcIDs },
            ]);
        }
        return undefined;
    }

    /**
     * 读取某个行块记录的远端 UID。
     *
     * 只有由本插件写入的行才会有这个属性，因此它是「这行归我管」的判据——
     * 绝不会去更新/删除用户在数据库里手写的行。
     *
     * 说明：绑定「插件标识」列时**不需要**这个方法（标识直接从单元格读）；
     * 未绑定该列时才退回行块属性，但新行可能因内核时序拿不到块属性。
     */
    async readRowIdentity(blockID: string): Promise<{ uid: string; calendar: string } | undefined> {
        try {
            const attrs = await this.deps.readAttrs(blockID);
            const uid = attrs[`${this.prefix}-uid`];
            if (!uid) {
                return undefined;
            }
            return { uid, calendar: attrs[`${this.prefix}-calendar`] ?? "" };
        } catch {
            return undefined;
        }
    }

    /** 本插件的行属性名（供 UI/文档说明使用） */
    attrNames(): { uid: string; calendar: string } {
        return { uid: `${this.prefix}-uid`, calendar: `${this.prefix}-calendar` };
    }

    /**
     * 把远端身份写进行块属性（供「新增后认领」与人工核对使用）。
     *
     * 只有在**没有绑定「插件标识」列**时才需要：绑定后标识随单元格一起写入，
     * 不再触碰块属性，也就不会遇到内核的 `tree not found`。
     */
    async writeRowAttributes(blockID: string, event: CalendarEvent): Promise<void> {
        if (this.options.binding.markerKeyID) {
            return;
        }
        await this.writeRowAttrs(blockID, event);
    }

    /** 把远端身份写进行块属性，便于核对与后续更新 */
    private async writeRowAttrs(blockID: string, event: CalendarEvent): Promise<void> {
        // 绑定「插件标识」列时完全不写块属性：标识已在单元格里，
        // 也就不会碰到新行尚未进块树导致的 `tree not found`。
        if (this.options.binding.markerKeyID) {
            return;
        }
        const names = this.attrNames();
        const attrs: Record<string, string> = {
            [names.uid]: event.uid,
            [names.calendar]: event.calendar,
        };
        // 新行刚创建时块可能还没挂进块树，setBlockAttrs 会报「tree not found」；
        // 延迟重试一次，仍失败也视为非致命（行内容已经写入成功）。
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await this.deps.writeAttrs(blockID, attrs);
                return;
            } catch (error) {
                if (attempt === 0) {
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    continue;
                }
                this.options.log?.(`写入行属性失败（${blockID}）：行内容已写入，仅缺少远端标识`, error);
            }
        }
    }
}
