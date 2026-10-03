import { fetchPost, fetchSyncPost, type IWebSocketData } from "siyuan";
import { decodeBase64, encodeBase64 } from "../util/misc";
import { getLocalTimeZone, partsOf, zonedTimeToTs } from "../util/date";
import { extractUid, looksLikeIcs } from "../caldav/ics";

/**
 * 思源内核 HTTP API 的薄封装。
 *
 * 约定：
 * - 所有调用走 `fetchSyncPost`/`fetchPost`（思源前端注入的 `siyuan` 模块）；
 * - `request` 自动拆包 `{code, msg, data}`，`code !== 0` 抛 `KernelError`；
 * - 需要「非 2xx 也是正常结果」的场景（例如 CalDAV 的 404/412）使用 `forwardProxy`，
 *   它只在**内核层面**失败时抛错，远端 HTTP 状态码原样返回。
 *
 * 关于 `/api/network/forwardProxy`（已对照 SiYuan v3.8.6 内核源码核实）：
 * 请求体：
 * ```json
 * {
 *   "url": "https://...",
 *   "method": "PROPFIND",
 *   "timeout": 30000,
 *   "contentType": "application/xml; charset=utf-8",
 *   "headers": [{"Authorization": "Basic ..."}, {"Depth": "1"}],
 *   "payload": "PFxkajpwcm9wZmluZCB4bWxuczpkPSJEQVY6Ii8+",
 *   "payloadEncoding": "base64",
 *   "redirect": true
 * }
 * ```
 * 要点：
 * - `headers` 是「每项单个键值对」的对象数组（内核逐项 `SetHeader`），不是 `{name, value}`；
 * - 方法名在内核侧不做白名单校验，PROPFIND / REPORT / MKCALENDAR / PUT / DELETE 均可透传；
 * - 默认跟随重定向（最多 3 跳）；
 * - 内网地址仅在「安全模式（SafeMode）」下被 SSRF 防护拦截，普通模式下局域网 CalDAV 可用。
 * 响应 `data`：`{url, status, contentType, body, bodyEncoding, headers, elapsed}`
 * （`headers` 是 Go `http.Header`，值一律是数组；`body` 恒为字符串）。
 */
export class KernelError extends Error {
    code: number;
    endpoint: string;
    payload?: unknown;

    constructor(endpoint: string, code: number, message: string, payload?: unknown) {
        super(message || `内核接口调用失败：${endpoint}（code=${code}）`);
        this.name = "KernelError";
        this.endpoint = endpoint;
        this.code = code;
        this.payload = payload;
    }
}

export interface RequestOptions {
    /** 请求超时（毫秒），0 表示不限（思源默认行为） */
    timeoutMs?: number;
    /** 静默模式：失败时不弹出思源消息提示 */
    silent?: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number | undefined, label: string): Promise<T> {
    if (!ms || ms <= 0) {
        return promise;
    }
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new KernelError(label, -1, `请求超时（${ms}ms）：${label}`));
        }, ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function unwrap<T>(endpoint: string, response: IWebSocketData | undefined): T {
    if (!response || typeof response !== "object") {
        throw new KernelError(endpoint, -1, `接口无响应：${endpoint}`);
    }
    if (typeof response.code === "number" && response.code !== 0) {
        throw new KernelError(endpoint, response.code, response.msg, response.data);
    }
    return response.data as T;
}

/** 调用内核接口并拆包 data；失败抛 `KernelError` */
export async function request<T = unknown>(
    endpoint: string,
    payload?: Record<string, unknown>,
    options?: RequestOptions,
): Promise<T> {
    const response = (await withTimeout(
        fetchSyncPost(endpoint, payload ?? {}),
        options?.timeoutMs,
        endpoint,
    ).catch((error: unknown) => {
        if (error instanceof KernelError) {
            throw error;
        }
        throw new KernelError(endpoint, -1, error instanceof Error ? error.message : String(error), payload);
    })) as IWebSocketData | undefined;
    try {
        return unwrap<T>(endpoint, response);
    } catch (error) {
        if (!options?.silent && error instanceof KernelError) {
            void pushErrMsg(error.message, 5000).catch(() => undefined);
        }
        throw error;
    }
}

/** 返回完整 `{code, msg, data}` 信封，不抛内核错误（网络异常仍会 reject） */
export async function requestRaw(
    endpoint: string,
    payload?: Record<string, unknown>,
    options?: RequestOptions,
): Promise<IWebSocketData> {
    return withTimeout(fetchSyncPost(endpoint, payload ?? {}), options?.timeoutMs, endpoint);
}

/**
 * 回调式 POST（思源前端的 `fetchPost`），适用于无需等待结果的交互，
 * 例如 `openFileByURL` 这类「打开界面」的调用。
 */
export function requestCallback(
    endpoint: string,
    payload?: Record<string, unknown>,
    cb?: (response: IWebSocketData) => void,
): void {
    fetchPost(endpoint, payload ?? {}, cb);
}

/* —— 网络代理 —— */

export interface ForwardProxyRequest {
    url: string;
    /** GET/PUT/POST/DELETE/PROPFIND/REPORT/MKCALENDAR/OPTIONS/HEAD */
    method?: string;
    headers?: Record<string, string>;
    /** 文本 body（ICS / XML） */
    body?: string;
    contentType?: string;
    timeoutMs?: number;
    /** 需要下载二进制（如附件）时置 true，响应 body 为 base64 */
    base64Body?: boolean;
    /** 是否跟随重定向（内核默认最多 3 跳）；CalDAV 建议保持默认 true */
    redirect?: boolean;
}

export interface ForwardProxyResponse {
    status: number;
    /** 已归一化为小写键、多值以逗号连接的响应头 */
    headers: Record<string, string>;
    /** 响应 Content-Type */
    contentType?: string;
    /** 响应体（已按内核声明的编码解码为 UTF-8 文本） */
    body: string;
    /** 内核记录的耗时（毫秒） */
    elapsed?: number;
}

/** 内核 forwardProxy 的原始响应 data（v3.5.9+ 字段名全小写） */
interface RawProxyResponse {
    url?: string;
    status?: number;
    contentType?: string;
    body?: string;
    bodyEncoding?: string;
    headers?: unknown;
    elapsed?: number;
}

/**
 * 归一化远端响应头。
 *
 * 内核返回的是 Go `http.Header`：`{"Content-Type": ["text/calendar"]}`，
 * 键保留原始大小写、值一律是数组。这里统一折算为小写键 + 逗号连接的字符串，
 * 同时兼容 `[{name, value}]` 数组形式（老版本/社区文档）。
 */
function normalizeHeaders(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (item && typeof item === "object") {
                const entry = item as { name?: unknown; value?: unknown };
                if (typeof entry.name === "string") {
                    out[entry.name.toLowerCase()] = typeof entry.value === "string" ? entry.value : String(entry.value ?? "");
                }
            }
        }
        return out;
    }
    if (raw && typeof raw === "object") {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof value === "string") {
                out[key.toLowerCase()] = value;
            } else if (Array.isArray(value)) {
                out[key.toLowerCase()] = value.map((item) => String(item)).join(", ");
            }
        }
    }
    return out;
}

/**
 * 通过内核转发 HTTP 请求。
 *
 * 为什么必须走内核：浏览器的 `fetch` 无法发送 PROPFIND/REPORT 等自定义方法，
 * 也会被 CORS 拦截；内核转发同时解决了方法与跨域问题。
 *
 * 实现上有两个刻意的选择：
 * 1. 请求体一律用 `payloadEncoding: "base64"` 发送。`"text"` 在不同内核版本上
 *    处理不一致（有一版实现直接忽略 payload），base64 是文档与源码都明确支持的解码分支；
 * 2. 响应体先按 `bodyEncoding` 判断是否需要 base64 解码，再交给调用方。
 *    这样不依赖内核按 Content-Type 自动解码的行为。
 */
export async function forwardProxy(req: ForwardProxyRequest): Promise<ForwardProxyResponse> {
    // 内核把 headers 逐项 SetHeader(k, v)，因此每项必须是「单个键值对」的对象；
    // {name, value} 形式不会被识别。
    const headers: Array<Record<string, string>> = Object.entries(req.headers ?? {})
        .filter(([name]) => !!name)
        .map(([name, value]) => ({ [name]: String(value) }));
    const payload: Record<string, unknown> = {
        url: req.url,
        method: (req.method ?? "GET").toUpperCase(),
        timeout: req.timeoutMs ?? 30_000,
        headers,
    };
    if (typeof req.redirect === "boolean") {
        payload.redirect = req.redirect;
    }
    if (req.body !== undefined && req.body !== null) {
        // 已经是 base64 的二进制体直接透传，否则把 UTF-8 文本编码为 base64
        payload.payload = req.base64Body ? req.body : encodeBase64(req.body);
        payload.payloadEncoding = "base64";
        payload.contentType = req.contentType ?? (req.base64Body
            ? "application/octet-stream"
            : "application/xml; charset=utf-8");
        if (req.base64Body) {
            // 二进制响应必须显式声明，否则内核按文本回传会损坏数据
            payload.responseEncoding = "base64";
        }
    } else if (req.contentType) {
        payload.contentType = req.contentType;
    }
    const data = await request<RawProxyResponse>("/api/network/forwardProxy", payload, {
        timeoutMs: req.timeoutMs ? req.timeoutMs + 5_000 : 35_000,
        silent: true,
    });
    const status = typeof data?.status === "number" ? data.status : 0;
    const rawBody = typeof data?.body === "string" ? data.body : "";
    const body = data?.bodyEncoding && data.bodyEncoding !== "text"
        ? safeDecodeBase64(rawBody)
        : rawBody;
    return {
        status,
        contentType: data?.contentType,
        headers: normalizeHeaders(data?.headers),
        body,
        elapsed: data?.elapsed,
    };
}

function safeDecodeBase64(value: string): string {
    if (!value) {
        return "";
    }
    try {
        return decodeBase64(value);
    } catch {
        return value;
    }
}

/* —— 通用 —— */

/**
 * SQL 查询（`/api/query/sql`）。
 *
 * 注意：内核不接受 `limit` 请求参数，它按 `search.limit` 自行截断，
 * 并在**信封顶层**返回 `limit` / `truncated`。因此 `limit` 形参已废弃，
 * 调用方需要在 SQL 里自行写 `LIMIT n`。
 */
export async function sql<T = Record<string, unknown>>(stmt: string, _limit?: number): Promise<T[]> {
    void _limit;
    const data = await request<T[] | null>("/api/query/sql", { stmt }, { silent: true });
    return Array.isArray(data) ? data : [];
}

export async function pushMsg(msg: string, timeout = 3000): Promise<unknown> {
    return request("/api/notification/pushMsg", { msg, timeout }, { silent: true });
}

export async function pushErrMsg(msg: string, timeout = 5000): Promise<unknown> {
    return request("/api/notification/pushErrMsg", { msg, timeout }, { silent: true });
}

export async function getBlockAttrs(id: string): Promise<Record<string, string>> {
    const data = await request<Record<string, string> | null>("/api/attr/getBlockAttrs", { id }, { silent: true });
    return data && typeof data === "object" ? data : {};
}

export async function setBlockAttrs(id: string, attrs: Record<string, string | null>): Promise<unknown> {
    return request("/api/attr/setBlockAttrs", { id, attrs });
}

export async function getBlockKramdown(id: string): Promise<{ id: string; kramdown: string }> {
    return request<{ id: string; kramdown: string }>("/api/block/getBlockKramdown", { id });
}

/**
 * 读取块的面包屑。
 *
 * 注意：`/api/block/getBlockBreadcrumb` 返回的是 `BlockPath[]`（**单元素数组**，
 * 该元素带 `children` 树），不是扁平的祖先列表；这里取 `[0].children` 展开成
 * `{id,name,type,subType}`，这是调用方（文档路径展示）需要的形状。
 */
export async function getBlockBreadcrumb(
    id: string,
): Promise<Array<{ id: string; name: string; type: string; subType?: string }>> {
    const data = await request<unknown>("/api/block/getBlockBreadcrumb", { id });
    if (!Array.isArray(data) || data.length === 0) {
        return [];
    }
    const root = data[0] as { children?: unknown } | undefined;
    if (!root || !Array.isArray(root.children)) {
        return [];
    }
    return (root.children as Array<{ id?: unknown; name?: unknown; type?: unknown; subType?: unknown }>)
        .filter((item) => item && typeof item.id === "string")
        .map((item) => ({
            id: String(item.id),
            name: typeof item.name === "string" ? item.name : "",
            type: typeof item.type === "string" ? item.type : "",
            ...(typeof item.subType === "string" && item.subType ? { subType: item.subType } : {}),
        }));
}

/**
 * 读取文档信息。
 *
 * 注意：`/api/block/getDocInfo` 的 DocInfo **只有** `{id,name,icon,ial,refCount,refIDs,rootID,subFileCount,attrViews}`，
 * 不含 `box`/`path`/`hPath`；为满足返回类型，这里用一次 SQL 补齐这三项。
 */
export async function getDocInfo(
    id: string,
): Promise<{ id: string; rootID: string; box: string; path: string; hPath: string; name: string }> {
    const info = await request<{ id?: string; rootID?: string; name?: string } | null>("/api/block/getDocInfo", { id });
    const docID = typeof info?.id === "string" && info.id ? info.id : id;
    const rootID = typeof info?.rootID === "string" ? info.rootID : "";
    let box = "";
    let path = "";
    let hPath = "";
    try {
        const rows = await request<Array<{ box?: string; path?: string; hPath?: string; content?: string }> | null>(
            "/api/query/sql",
            { stmt: `SELECT box, path, hPath, content FROM blocks WHERE id = '${docID.replace(/'/g, "''")}' LIMIT 1` },
            { silent: true },
        );
        const row = Array.isArray(rows) ? rows[0] : undefined;
        if (row) {
            box = typeof row.box === "string" ? row.box : "";
            path = typeof row.path === "string" ? row.path : "";
            hPath = typeof row.hPath === "string" ? row.hPath : "";
        }
    } catch {
        /* SQL 失败时保留空值，调用方按需降级 */
    }
    return {
        id: docID,
        rootID: rootID || docID,
        box,
        path,
        hPath,
        name: typeof info?.name === "string" ? info.name : "",
    };
}

export async function createDocWithMd(notebook: string, path: string, markdown: string): Promise<string> {
    const data = await request<string>("/api/filetree/createDocWithMd", { notebook, path, markdown });
    return typeof data === "string" ? data : "";
}

export async function appendBlock(
    dataType: "markdown" | "dom",
    data: string,
    parentID: string,
): Promise<Array<{ doOperations: unknown[] }>> {
    const result = await request<Array<{ doOperations: unknown[] }>>("/api/block/appendBlock", {
        dataType,
        data,
        parentID,
    });
    return Array.isArray(result) ? result : [];
}

export async function updateBlock(
    dataType: "markdown" | "dom",
    data: string,
    id: string,
): Promise<Array<{ doOperations: unknown[] }>> {
    const result = await request<Array<{ doOperations: unknown[] }>>("/api/block/updateBlock", {
        dataType,
        data,
        id,
    });
    return Array.isArray(result) ? result : [];
}

export async function deleteBlock(id: string): Promise<unknown> {
    return request("/api/block/deleteBlock", { id });
}

export async function renameDoc(notebook: string, path: string, title: string): Promise<unknown> {
    return request("/api/filetree/renameDoc", { notebook, path, title });
}

export async function moveDocs(fromPaths: string[], toNotebook: string, toPath: string): Promise<unknown> {
    return request("/api/filetree/moveDocs", { fromPaths, toNotebook, toPath });
}

/* —— 属性视图（数据库）—— */

/** 读取属性视图结构（列定义、视图列表等）。请求体只有 `id`（avID） */
export async function getAttributeView(id: string): Promise<unknown> {
    return request("/api/av/getAttributeView", { id });
}

/** 读取属性视图字段列表；带 `avID` + `itemID` 时返回该条目各字段值 */
export async function getAttributeViewKeys(id: string): Promise<unknown> {
    return request("/api/av/getAttributeViewKeys", { id });
}

/**
 * 渲染属性视图并取回行列数据。
 *
 * 内核入参为 `{id, viewID?, query?, page?, pageSize?, calendarRange?}`——
 * **没有 `start` 参数**，偏移量按 `page`（从 1 开始）换算；
 * `calendarRange` 为毫秒半开区间且跨度不得超过 63 天。
 */
export async function renderAttributeView(
    id: string,
    viewID?: string,
    options?: {
        pageSize?: number;
        start?: number;
        calendarRange?: { start: number; end: number; timeZone: string };
        /** 静默失败：不弹内核错误提示（用于「这个视图 ID 可能已失效」的探测） */
        silent?: boolean;
    },
): Promise<unknown> {
    const payload: Record<string, unknown> = { id };
    if (viewID) {
        payload.viewID = viewID;
    }
    const pageSize = typeof options?.pageSize === "number" ? options.pageSize : undefined;
    if (pageSize !== undefined) {
        payload.pageSize = pageSize;
    }
    if (typeof options?.start === "number") {
        // 内核只接受 page（1 起），把行偏移换算成页码
        const size = pageSize && pageSize > 0 ? pageSize : 50;
        payload.page = Math.floor(options.start / size) + 1;
    }
    if (options?.calendarRange) {
        payload.calendarRange = options.calendarRange;
    }
    return request("/api/av/renderAttributeView", payload, options?.silent ? { silent: true } : undefined);
}

/**
 * 单元格值的「裸形态」（写入用）。
 *
 * 与 `renderAttributeView` 读回形态一致：
 * `{keyID, block:{content}}`（文本）、`{keyID, date:{content, isNotEmpty}}`（日期）、
 * `{keyID, number:{content, isNotEmpty}}`（数字）、`{keyID, mSelect:[{content}]}`（多选）等。
 */
export type AvRawValue = Record<string, unknown> & { keyID: string };

/**
 * 向属性视图追加「游离块」行并写入单元格值。
 *
 * 注意（已对照内核 `kernel/api/av.go` 与 `apicontract` 核实）：
 * - 参数名是 **`blocksValues`**（不是社区文档里写的 `rowValues`），
 *   形如 `[[{keyID, block:{content}}, ...], ...]`——**二维数组**，外层是行、内层是该行的值；
 * - 该接口返回 `data: null`，**不返回块 ID**。新行的 ID 需要回读属性视图后比对得出。
 */
export async function appendAttributeViewDetachedBlocksWithValues(
    avID: string,
    blocksValues: AvRawValue[][],
): Promise<void> {
    await request("/api/av/appendAttributeViewDetachedBlocksWithValues", { avID, blocksValues });
}

/**
 * 设置数据库某个单元格的值。
 *
 * `itemID` 是**行的 itemID**（不是块 ID，也不是视图 ID）；
 * 新版本内核已废弃 `rowID` 参数，因此这里只发 `itemID`。
 */
export async function setAttributeViewBlockAttr(
    avID: string,
    keyID: string,
    itemID: string,
    value: unknown,
): Promise<void> {
    await request("/api/av/setAttributeViewBlockAttr", { avID, keyID, itemID, value });
}

/**
 * 从数据库（属性视图）移除若干行。
 *
 * 内核入参：`{avID, srcIDs: string[]}`；**没有 `data` 返回**。
 * 注意：不能用 `/api/transactions` 的 `removeAttrViewBlock`——那个动作名不存在，
 * 请求会「成功返回」但什么都不做（实测：提示已删除、数据仍在）。
 */
export async function removeAttributeViewBlocks(avID: string, srcIDs: string[]): Promise<void> {
    await request("/api/av/removeAttributeViewBlocks", { avID, srcIDs });
}

/**
 * 设置数据库视图为日历布局并绑定日期字段。
 *
 * 注意：**没有 `/api/av/setAttrViewCalendar` 这个 REST 接口**，
 * 该能力由 `/api/transactions` 的 `setAttrViewCalendar` 事务提供，
 * `data` 为 `{dateKeyID, colorKeyID, weekStart, rowLimit?}`。
 */
export async function setAttrViewCalendar(
    id: string,
    viewID: string,
    calendar: { dateKeyID: string; colorKeyID?: string; weekStart?: number; rowLimit?: number },
): Promise<unknown> {
    const data: Record<string, unknown> = {
        dateKeyID: calendar.dateKeyID,
        colorKeyID: calendar.colorKeyID ?? "",
        weekStart: calendar.weekStart ?? 1,
    };
    if (typeof calendar.rowLimit === "number") {
        data.rowLimit = calendar.rowLimit;
    }
    return transactions([{ action: "setAttrViewCalendar", id, avID: id, blockID: id, viewID, data }]);
}

/**
 * 由绑定块 ID 反查属性视图条目 ID。
 *
 * 注意：接口是 `/api/av/getAttributeViewItemIDsByBoundIDs`，入参为 `{avID, blockIDs}`；
 * 返回 `{blockID: itemID}` 映射，这里按参数顺序取出条目 ID 列表。
 */
export async function getAttributeViewItemIDsByBound(avID: string, blockIDs: string[]): Promise<string[]> {
    const data = await request<Record<string, string> | null>(
        "/api/av/getAttributeViewItemIDsByBoundIDs",
        { avID, blockIDs },
        { silent: true },
    );
    if (!data || typeof data !== "object") {
        return [];
    }
    const out: string[] = [];
    for (const blockID of blockIDs) {
        const itemID = data[blockID];
        if (typeof itemID === "string" && itemID) {
            out.push(itemID);
        }
    }
    return out;
}

/**
 * 批量设置数据库条目字段值。
 *
 * 内核入参为 `{avID, values: [{itemID?, rowID?, keyID, value}]}`——`itemID` 必须放在
 * 每个 value 项里，而不是与 `values` 平级。
 */
export async function batchSetAttributeViewBlockAttrs(
    avID: string,
    itemID: string,
    values: Array<{ keyID: string; value: unknown }>,
): Promise<unknown> {
    return request("/api/av/batchSetAttributeViewBlockAttrs", {
        avID,
        values: values.map((item) => ({ itemID, keyID: item.keyID, value: item.value })),
    });
}

/**
 * 设置单个字段值（接口为 `/api/av/setAttributeViewBlockAttr`，单数）。
 * 入参为 `{avID, itemID, keyID, value}`；传入多个值时逐条调用。
 */
export async function setAttrViewBlockAttrs(
    avID: string,
    itemID: string,
    values: Array<{ keyID: string; value: unknown }>,
): Promise<unknown> {
    for (const item of values) {
        await request("/api/av/setAttributeViewBlockAttr", { avID, itemID, keyID: item.keyID, value: item.value });
    }
    return null;
}

/**
 * 读取条目各字段值。
 *
 * 注意：没有 `/api/av/getAttributeViewBlockAttrs`，应使用
 * `/api/av/getAttributeViewKeys`（`{avID, itemID}`），返回数组首项的 `keyValues`。
 */
export async function getAttrViewBlockAttrs(avID: string, itemID: string): Promise<unknown> {
    const data = await request<unknown>("/api/av/getAttributeViewKeys", { avID, itemID });
    if (Array.isArray(data)) {
        const first = data[0] as { keyValues?: unknown } | undefined;
        return first?.keyValues ?? data;
    }
    return data;
}

/**
 * 新建数据库条目。
 *
 * 内核入参为 `{avID, blockID, viewID?, templateID?, previousID?, groupID?, calendarDate?}`：
 * `blockID` 是必填的绑定块 ID（未绑定时传 `avID`）；插入位置用 `previousID`；
 * 内核不允许 `itemID`/`detached` 字段（schema 为 additionalProperties:false），
 * 因此 `itemID` 参数按 `previousID` 处理，`detached` 仅忽略。
 */
export async function createAttributeViewItem(
    avID: string,
    blockID?: string,
    itemID?: string,
    options?: { calendarDate?: number; detached?: boolean },
): Promise<{ itemID?: string }> {
    const payload: Record<string, unknown> = { avID, blockID: blockID ?? avID };
    if (itemID) {
        payload.previousID = itemID;
    }
    if (typeof options?.calendarDate === "number") {
        payload.calendarDate = options.calendarDate;
    }
    const data = await request<{ itemID?: string } | null>("/api/av/createAttributeViewItem", payload);
    return data && typeof data === "object" ? data : {};
}

/* —— 事务（批量写） —— */

export interface TransactionOperation {
    action: string;
    id?: string;
    data?: unknown;
    [key: string]: unknown;
}

let transactionReqId = 0;
let transactionSession = "";

/** 事务 session：同一会话内的操作可整体撤销，这里按插件实例惰性生成并复用 */
function transactionSessionID(): string {
    if (!transactionSession) {
        transactionSession = `calendar-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    }
    return transactionSession;
}

/**
 * 通过事务接口批量写入（属性视图单元格 / 块属性等）。
 *
 * 内核请求体为 `{reqId, session, transactions:[{timestamp, doOperations, undoOperations}]}`：
 * `doOperations` 位于 `transactions[0]` 内，`reqId` 每次递增、`session` 标识编辑会话。
 */
export async function transactions(doOperations: TransactionOperation[]): Promise<unknown> {
    if (doOperations.length === 0) {
        return [];
    }
    transactionReqId += 1;
    return request("/api/transactions", {
        reqId: transactionReqId,
        session: transactionSessionID(),
        transactions: [{ timestamp: Date.now(), doOperations, undoOperations: [] }],
    });
}

/* —— 其他 —— */

export async function getNotebooks(): Promise<Array<{ id: string; name: string; closed: boolean }>> {
    const data = await request<{ notebooks?: Array<{ id: string; name: string; closed: boolean }> }>(
        "/api/notebook/lsNotebooks",
    );
    return Array.isArray(data?.notebooks) ? data.notebooks : [];
}

export async function lsNotebooks(): Promise<unknown> {
    return request("/api/notebook/lsNotebooks");
}

export async function getWorkspaces(): Promise<unknown> {
    return request("/api/system/getWorkspaces");
}

export async function getCurrentTime(): Promise<number> {
    const data = await request<number>("/api/system/currentTime");
    return typeof data === "number" ? data : Date.now();
}

/**
 * 读取工作区文件。
 *
 * 注意：`/api/file/getFile` **不套 `{code,msg,data}` 信封**——成功时直接返回文件内容
 * （文本为字符串、JSON 被内核解析为对象），失败时返回错误信封（HTTP 202）。
 * 因此这里不能用 `request` 拆 `data`，必须判断返回是否带 `code`。
 */
export async function getFile(path: string): Promise<unknown> {
    const response = (await fetchSyncPost("/api/file/getFile", { path })) as
        | { code?: number; msg?: string; data?: unknown }
        | string
        | null;
    if (response && typeof response === "object" && typeof response.code === "number") {
        if (response.code !== 0) {
            throw new KernelError("/api/file/getFile", response.code, response.msg ?? "", response.data);
        }
        return response.data;
    }
    return response;
}

/** 写入内核文件（`data` 为 Blob/File）。接口是 multipart/form-data，字段 `path`/`file`/`isDir` */
export async function putFile(path: string, data: Blob | File, isDir = false): Promise<unknown> {
    const form = new FormData();
    form.append("path", path);
    form.append("isDir", isDir ? "true" : "false");
    form.append("file", data instanceof File ? data : new File([data], path.split("/").pop() ?? "file"));
    const response = await fetchSyncPost("/api/file/putFile", form);
    return unwrap("/api/file/putFile", response);
}

/* —— 纯函数工具（可单测） —— */

/** 从 IAL / 属性对象里取出 `custom-*` 属性（键去掉 `custom-` 前缀） */
export function pickCustomAttrs(ial: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(ial ?? {})) {
        if (!key.startsWith("custom-") || typeof value !== "string" || value === "") {
            continue;
        }
        out[key.slice("custom-".length)] = value;
    }
    return out;
}

/**
 * 解析思源时间属性。
 * 支持 `20250103120000`（含时间）、`20250103`（全天）、`2025-01-03 12:00:00`、
 * `2025-01-03T12:00:00`、`2025-01-03` 以及毫秒/秒时间戳字符串。
 * 非法输入返回 `undefined`。
 */
export function parseSiyuanTime(
    value: string | undefined | null,
    hasTime?: boolean,
    timeZone: string = getLocalTimeZone(),
): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    const raw = String(value).trim();
    if (!raw) {
        return undefined;
    }
    // 纯数字但不是合法时间戳长度（例如 "0"、"123456"）不是思源时间属性；
    // 8 位以上可能是 yyyyMMdd / yyyyMMddHHmmss，交给下面的分支处理
    if (/^\d+$/.test(raw) && raw.length < 8 && raw.length !== 10 && raw.length !== 13) {
        return undefined;
    }
    if (/^\d{10}$/.test(raw)) {
        const seconds = parseInt(raw, 10);
        return seconds > 0 ? seconds * 1000 : undefined;
    }
    if (/^\d{13}$/.test(raw)) {
        const ms = parseInt(raw, 10);
        return ms > 0 ? ms : undefined;
    }
    const compact = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/.exec(raw);
    if (compact) {
        const [, y, m, d, hh, mm, ss] = compact;
        const withTime = hasTime ?? !!hh;
        return buildTs(Number(y), Number(m), Number(d), withTime ? Number(hh ?? 0) : 0, withTime ? Number(mm ?? 0) : 0, withTime ? Number(ss ?? 0) : 0, timeZone);
    }
    const dashed = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
    if (dashed) {
        const withTime = hasTime ?? !!dashed[4];
        return buildTs(
            Number(dashed[1]),
            Number(dashed[2]),
            Number(dashed[3]),
            withTime ? Number(dashed[4] ?? 0) : 0,
            withTime ? Number(dashed[5] ?? 0) : 0,
            withTime ? Number(dashed[6] ?? 0) : 0,
            timeZone,
        );
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
        return parsed;
    }
    return undefined;
}

function buildTs(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    timeZone: string,
): number | undefined {
    if (
        !Number.isFinite(year) ||
        !Number.isFinite(month) ||
        !Number.isFinite(day) ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31 ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59 ||
        second < 0 ||
        second > 60
    ) {
        return undefined;
    }
    const ts = zonedTimeToTs(year, month, day, hour, minute, Math.min(second, 59), timeZone);
    const check = partsOf(ts, timeZone);
    if (check.year !== year || check.month !== month || check.day !== day) {
        return undefined;
    }
    return ts;
}

/** 生成思源时间属性字符串 */
export function formatSiyuanTime(ts: number, hasTime: boolean, timeZone: string = getLocalTimeZone()): string {
    const p = partsOf(ts, timeZone);
    const pad = (value: number) => String(value).padStart(2, "0");
    const date = `${p.year}${pad(p.month)}${pad(p.day)}`;
    return hasTime ? `${date}${pad(p.hour)}${pad(p.minute)}${pad(p.second)}` : date;
}

/** 逐个候选属性解析日期，返回命中项 */
export function resolveDateAttr(
    attrs: Record<string, string>,
    candidates: string[],
    timeZone: string = getLocalTimeZone(),
): { ts: number; hasTime: boolean; attr: string } | undefined {
    const custom = pickCustomAttrs(attrs);
    for (const candidate of candidates) {
        const key = candidate.startsWith("custom-") ? candidate.slice("custom-".length) : candidate;
        const raw = custom[key] ?? attrs[candidate];
        if (!raw) {
            continue;
        }
        const hasTime = raw.trim().length > 8;
        const ts = parseSiyuanTime(raw, hasTime, timeZone);
        if (ts !== undefined) {
            return { ts, hasTime, attr: key };
        }
    }
    return undefined;
}

/** 判断文本是否像 ICS（转导出便于其他模块复用） */
export function isIcsText(text: string): boolean {
    return looksLikeIcs(text);
}

/** 从 ICS 文本取 UID（转导出） */
export function uidFromIcs(ics: string): string | undefined {
    return extractUid(ics);
}

/** base64 工具转导出（供调用方处理二进制资源） */
export const base64 = { encode: encodeBase64, decode: decodeBase64 };

/** 触发一次思源消息推送（带错误兜底，不抛出） */
export function notify(message: string): void {
    void pushMsg(message, 3000).catch(() => undefined);
}
