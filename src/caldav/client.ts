import { XMLParser } from "fast-xml-parser";
import type { CalDavAccount, CalendarInfo } from "../types";
import { forwardProxy, type ForwardProxyResponse } from "../kernel/api";
import { hashString } from "../util/misc";
import { extractUid, looksLikeIcs } from "./ics";
import { onelineJson } from "../util/logger";

/** 由账户生成认证信息；密钥库优先，其次明文密码 */
export interface CalDavCredentials {
    username: string;
    secret: string;
    authType: "basic" | "digest" | "bearer";
}

export interface CalDavClientOptions {
    account: CalDavAccount;
    credentials: CalDavCredentials;
    timeoutMs?: number;
    /** 调试日志 */
    log?: (message: string, ...rest: unknown[]) => void;
    /** 更啰嗦的日志：额外打印响应体（用于排查「返回了但内容不对」） */
    verbose?: boolean;
}

export interface RemoteCalendar {
    url: string;
    displayName?: string;
    color?: string;
    readOnly: boolean;
    components: string[];
    description?: string;
    ctag?: string;
    syncToken?: string;
}

export interface RemoteEventResource {
    href: string;
    etag?: string;
    /** ICS 文本；`calendar-data` 为空表示服务端没有内联返回正文，需要补取 */
    ics?: string;
    uid?: string;
    hash?: string;
    lastModified?: string;
}

export interface RemoteCalendarObjects {
    resources: RemoteEventResource[];
    syncToken?: string;
    /** 服务器不支持 sync-collection 时为 true，调用方应退化为全量查询 */
    fullSync: boolean;
    /** 本次结果是否内联了 calendar-data（false 时调用方需要按 href 补取正文） */
    hasContent?: boolean;
}

const DAV_NAMESPACE = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"';

/** 解析 DAV:multistatus 响应；忽略命名空间前缀差异 */
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
    if (value === undefined || value === null) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string | undefined {
    const raw = rawTextOf(value);
    return raw === undefined ? undefined : decodeXmlEntities(raw);
}

function rawTextOf(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (value && typeof value === "object" && "#text" in (value as Record<string, unknown>)) {
        const inner = (value as Record<string, unknown>)["#text"];
        return inner === undefined ? undefined : String(inner);
    }
    return undefined;
}

/**
 * 解码 XML 字符实体。
 *
 * 必需的原因：XML 解析器（本项目配置为不自动处理实体）会把 `&#x0D;&#x0A;` 原样留在文本里，
 * 而 QQ 邮箱正是用这种形式编码 iCalendar 的换行 —— 于是整份 ICS 变成「一行」，
 * `ical.js` 解析不到任何 VEVENT（表现为「集合能列出、事件永远为空」）。
 * 这里统一还原成一个字符，`&amp;` 必须最后处理以避免二次解码。
 */
export function decodeXmlEntities(value: string): string {
    if (value.indexOf("&") === -1) {
        return value;
    }
    return value
        .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => safeCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_match, dec: string) => safeCodePoint(parseInt(dec, 10)))
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

function safeCodePoint(code: number): string {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        return "";
    }
    try {
        return String.fromCodePoint(code);
    } catch {
        return "";
    }
}

function hrefToUrl(href: string, base: string): string {
    if (/^https?:\/\//i.test(href)) {
        return href;
    }
    try {
        const resolved = new URL(href, base).toString();
        return rerootIfNeeded(base, resolved);
    } catch {
        return href;
    }
}

/**
 * 修正「服务端 href 不含挂载前缀」的情况。
 *
 * 典型：Vikunja 挂在 `/api/v1/dav/`，但它返回的 href 是根相对的 `/dav/projects/3/x.ics`。
 * 直接用 `new URL(href, base)` 会得到 `https://host/dav/projects/3/x.ics`（缺少 `/api/v1`），
 * 于是后续 GET/PUT/DELETE 全部 404 —— 表现又是「能列出日历、事件取不到」。
 *
 * 判据：href 的第一段与 base 的第一段不同，但 href 出现在 base 的后半段里
 * （例如 base=/api/v1/dav/ 与 href=/dav/projects/…）。此时把 base 的前缀补回。
 */
function rerootIfNeeded(base: string, resolved: string): string {
    try {
        const baseUrl = new URL(base);
        const resolvedUrl = new URL(resolved);
        // 域名不同说明是跨主机引用，不做处理
        if (baseUrl.host !== resolvedUrl.host) {
            return resolved;
        }
        const baseSegments = baseUrl.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
        const hrefSegments = resolvedUrl.pathname.split("/").filter(Boolean);
        if (!baseSegments.length || !hrefSegments.length) {
            return resolved;
        }
        if (baseSegments[0] === hrefSegments[0]) {
            return resolved;
        }
        // base=/api/v1/dav/projects/3 与 href=/dav/projects/3/x.ics
        // → base 的后缀 ["dav"] 正好是 href 的前缀 → 前缀取 ["api","v1"]，
        //   拼成 /api/v1/dav/projects/3/x.ics
        let overlap = Math.min(baseSegments.length, hrefSegments.length);
        while (overlap > 0) {
            const baseTail = baseSegments.slice(baseSegments.length - overlap);
            const hrefHead = hrefSegments.slice(0, overlap);
            if (baseTail.every((segment, index) => segment === hrefHead[index])) {
                break;
            }
            overlap--;
        }
        if (!overlap || overlap === baseSegments.length) {
            return resolved;
        }
        const prefix = baseSegments.slice(0, baseSegments.length - overlap);
        resolvedUrl.pathname = `/${[...prefix, ...hrefSegments].join("/")}`;
        return resolvedUrl.toString();
    } catch {
        /* 解析失败时保持原样 */
    }
    return resolved;
}

/**
 * 判断两个 DAV href 是否指向同一集合。
 * 忽略协议/主机差异（服务端可能返回绝对路径或绝对 URL）、百分号编码差异与结尾斜杠。
 */
function sameCollection(a: string, b: string): boolean {
    const path = (value: string): string => {
        let pathname = value;
        try {
            pathname = new URL(value).pathname;
        } catch {
            pathname = value.split(/[?#]/)[0];
        }
        try {
            pathname = decodeURIComponent(pathname);
        } catch {
            /* 非法编码时保持原样 */
        }
        return pathname.replace(/\/+$/, "");
    };
    return path(a) === path(b);
}

function normalizeUrl(url: string): string {
    const [base, suffix] = splitQuery(url);
    return base.replace(/\/+$/, "") + "/" + suffix;
}

function splitQuery(url: string): [string, string] {
    const index = url.search(/[?#]/);
    return index === -1 ? [url, ""] : [url.slice(0, index), url.slice(index)];
}

/**
 * 归一化 ETag。
 *
 * 各服务端写法不一：`"abc"`、`abc`、`W/"abc"`（弱校验）、`1791041436 `（元素里带尾随空格）。
 * 插件只把 ETag 当作不透明字符串用于 `If-Match` 与变更检测，因此统一去掉引号、`W/` 前缀与空白；
 * 发回服务端时再按需加引号（见 `quoteEtag`）。
 */
export function normalizeEtag(value: string | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const trimmed = value.trim().replace(/^W\//i, "").trim();
    const unquoted = trimmed.replace(/^"(.*)"$/s, "$1");
    return unquoted.length ? unquoted : undefined;
}

/** 把归一化后的 ETag 还原成 HTTP 头里的强校验形式 */
export function quoteEtag(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const normalized = normalizeEtag(value);
    return normalized ? `"${normalized}"` : undefined;
}

/** 从绝对 URL 中取出用于 multiget 的相对路径（保留百分号编码） */
function relativePath(href: string): string {
    try {
        const url = new URL(href);
        return `${url.pathname}${url.search}`;
    } catch {
        return href;
    }
}

/**
 * 去掉路径里重复出现的相邻前缀段，作为「href 挂载前缀判断失误」时的备用地址。
 * 例：`/api/v1/dav/dav/projects/3/x.ics` → `/api/v1/dav/projects/3/x.ics`
 */
function dropDuplicatedPrefix(href: string): string | undefined {
    try {
        const url = new URL(href);
        const segments = url.pathname.split("/").filter(Boolean);
        for (let index = 0; index + 1 < segments.length; index++) {
            if (segments[index] === segments[index + 1]) {
                url.pathname = `/${[...segments.slice(0, index + 1), ...segments.slice(index + 2)].join("/")}`;
                return url.toString();
            }
        }
    } catch {
        /* 忽略 */
    }
    return undefined;
}

function statusOf(response: Record<string, unknown> | undefined): number {
    const status = textOf(response?.status);
    if (!status) {
        return 200;
    }
    const match = /(\d{3})/.exec(status);
    return match ? parseInt(match[1], 10) : 200;
}

function propstatProps(response: Record<string, unknown>): Record<string, unknown> {
    const propstats = asArray(response.propstat as Record<string, unknown> | Record<string, unknown>[]);
    for (const propstat of propstats) {
        const status = statusOf(propstat);
        if (status >= 200 && status < 300) {
            return (propstat.prop as Record<string, unknown>) ?? {};
        }
    }
    return {};
}

export class CalDavError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly url: string,
        readonly body?: string,
    ) {
        super(message);
        this.name = "CalDavError";
    }
}

/**
 * 极简 CalDAV 客户端（RFC 4791 / 4918 子集）。
 *
 * 所有请求经思源内核的 `/api/network/forwardProxy` 发出：
 * 前端 fetch 无法发 PROPFIND/REPORT 等自定义方法，也无法绕过 CORS，
 * 由内核代为请求同时解决了这两个问题，并且可复用系统证书设置。
 */
export class CalDavClient {
    private readonly timeoutMs: number;
    /** 每个日历「上次奏效的 calendar-query 变体下标」，避免每轮重复试探 */
    private readonly queryVariant = new Map<string, number>();

    constructor(private readonly options: CalDavClientOptions) {
        this.timeoutMs = options.timeoutMs ?? 30_000;
    }

    private authHeaders(): Record<string, string> {
        const { credentials } = this.options;
        if (credentials.authType === "bearer") {
            return { Authorization: `Bearer ${credentials.secret}` };
        }
        const raw = `${credentials.username}:${credentials.secret}`;
        return { Authorization: `Basic ${encodeBase64Utf8(raw)}` };
    }

    private async dav(options: {
        url: string;
        method: string;
        body?: string;
        headers?: Record<string, string>;
        depth?: string;
        contentType?: string;
    }): Promise<ForwardProxyResponse & { url: string }> {
        const target = options.url;
        this.options.log?.(`${options.method} ${target}`);        const response = await forwardProxy({
            url: target,
            method: options.method,
            headers: {
                ...this.authHeaders(),
                Accept: "application/xml, text/xml, text/calendar, */*",
                // 少数服务端（如 QQ 邮箱 dav.qq.com）会按 User-Agent 走不同实现，
                // 这里用通用 CalDAV 客户端标识而不是插件标识，避免被当作未知客户端。
                "User-Agent": "SiYuan/3.0 CalDAVClient/1.0",
                ...(options.depth ? { Depth: options.depth } : {}),
                ...(options.headers ?? {}),
            },
            body: options.body,
            contentType: options.contentType ?? (options.body ? "application/xml; charset=utf-8" : undefined),
            timeoutMs: this.timeoutMs,
        });
        // 响应摘要：状态码 + 长度 + 前若干字节。排查「返回了但内容不对」时最有用。
        this.options.log?.(
            `← ${response.status} ${options.method} ${target}（${response.body?.length ?? 0} 字节）`,
        );
        if (this.options.verbose) {
            this.options.log?.(`  响应体：${onelineJson(response.body ?? "")}`);
        }
        if (response.status === 401) {
            // 标准认证挑战：凭据不对，直接给出可读提示（403 不在此列，见下）
            throw new CalDavError(
                `认证失败（HTTP 401）。请检查用户名/密码，iCloud/Fastmail/QQ 邮箱/企业微信等需使用「应用专用密码」或邮箱授权码。`,
                401,
                target,
                response.body.slice(0, 500),
            );
        }
        if (response.status === 403) {
            // 403 不一定是认证失败：企业微信等服务对未授权请求直接返回 403（HTML、无 WWW-Authenticate），
            // 而同一凭据在 /.well-known/caldav → /calendar/ 上是可用的。
            // 因此这里不抛错，由调用方按上下文处理（发现流程换候选根、列举日历退回精简属性集）。
            // 例外：若响应明确是 DAV 应答（带 DAV 头或 multistatus），说明凭据被识别但无权限。
            const davLike =
                typeof response.headers.dav === "string" || /multistatus/i.test(response.body.slice(0, 2000));
            if (davLike) {
                throw new CalDavError(
                    `无访问权限（HTTP 403）：凭据可用，但该资源被服务端拒绝。`,
                    403,
                    target,
                    response.body.slice(0, 500),
                );
            }
            this.options.log?.(`HTTP 403（${target}），响应不是 DAV 应答，继续尝试其他候选地址`);
        }
        return { ...response, url: target };
    }

    /** 从 HTTP 头中取出 ETag / Schedule-Tag（大小写不敏感） */
    private static header(response: ForwardProxyResponse, name: string): string | undefined {
        const lower = name.toLowerCase();
        for (const [key, value] of Object.entries(response.headers ?? {})) {
            if (key.toLowerCase() === lower) {
                return value;
            }
        }
        return undefined;
    }

    private parseMultiStatus(body: string): Array<{ href: string; props: Record<string, unknown> }> {
        let parsed: Record<string, unknown>;
        try {
            parsed = parser.parse(body) as Record<string, unknown>;
        } catch (error) {
            throw new CalDavError(`解析 DAV 响应失败：${(error as Error).message}`, 200, "", body.slice(0, 500));
        }
        const multistatus = parsed.multistatus as Record<string, unknown> | undefined;
        if (!multistatus) {
            return [];
        }
        return asArray(multistatus.response as Record<string, unknown> | Record<string, unknown>[])
            .map((response) => ({
                href: textOf(response.href) ?? "",
                props: propstatProps(response),
            }))
            .filter((item) => item.href !== "");
    }

    /* —— 发现 —— */

    /**
     * 解析 `.well-known/caldav` 的重定向目标（最多 3 跳）。
     *
     * 为什么需要：企业微信（caldav.wecom.work）与 QQ 邮箱（dav.qq.com）的根路径对未认证请求
     * 直接返回 403，而 `.well-known/caldav` 会 301 到真正可用的 CalDAV 根（两者都是 `/calendar/`）。
     * 跟上这个重定向比让用户手填地址更可靠。
     */
    private async resolveWellKnown(base: string): Promise<string | undefined> {
        let current = `${base.replace(/\/+$/, "")}/.well-known/caldav`;
        for (let hop = 0; hop < 3; hop++) {
            const response = await this.dav({ url: current, method: "GET" }).catch(() => undefined);
            if (!response) {
                return undefined;
            }
            const location = CalDavClient.header(response, "Location") ?? CalDavClient.header(response, "location");
            if (response.status >= 300 && response.status < 400 && location) {
                current = hrefToUrl(location, current);
                continue;
            }
            if (response.status < 400) {
                return normalizeUrl(current);
            }
            return undefined;
        }
        return normalizeUrl(current);
    }

    /**
     * 带命名空间回退的 PROPFIND。
     *
     * 某些服务端对属性集非常敏感：企业微信 CalDAV 只要请求里出现
     * `http://calendarserver.org/ns/` 就返回 400。因此这里按「完整 → 精简」逐级重试，
     * 只要有一次拿到 2xx 就返回。
     */
    private async fetchProps(
        url: string,
        depth: "0" | "1" | "infinity",
        variants: string[],
    ): Promise<{ status: number; body: string; headers: Record<string, string>; url: string }> {
        let lastError: unknown;
        let fallback: { status: number; body: string; headers: Record<string, string>; url: string } | undefined;
        for (const body of variants) {
            try {
                const response = await this.dav({ url, method: "PROPFIND", depth, body });
                if (response.status >= 200 && response.status < 300) {
                    return response;
                }
                // 只要服务端给过非 2xx 应答，就返回它（而不是在全部变体失败后抛错），
                // 让调用方根据状态码决定「换候选地址」还是「报错」。
                fallback ??= response;
            } catch (error) {
                // 认证失败（401）不是「属性集不兼容」，必须向上抛出，避免被重试掩盖
                if (error instanceof CalDavError && error.status === 401) {
                    throw error;
                }
                lastError = error;
                this.options.log?.(`PROPFIND 失败，尝试精简属性集（${url}）`, error);
            }
        }
        if (fallback) {
            return fallback;
        }
        throw lastError instanceof Error ? lastError : new CalDavError("PROPFIND 失败", 0, url);
    }

    private static readonly PROPFIND_MINIMAL =
        `<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`;

    /** 发现当前用户 principal、calendar-home-set 与日历集合（多级回退，兼容不同服务端实现） */
    async discover(): Promise<{ principalUrl?: string; homeSet?: string; calendars: RemoteCalendar[] }> {
        const base = normalizeUrl(this.options.account.serverUrl);
        let principalUrl: string | undefined;
        let homeSet: string | undefined;
        let lastStatus = 0;

        // 0) 若根路径不可用，尝试 .well-known/caldav 找到真正的 CalDAV 根
        const candidates: string[] = [base];
        const wellKnown = await this.resolveWellKnown(base).catch(() => undefined);
        if (wellKnown && wellKnown !== base) {
            candidates.unshift(wellKnown);
        }

        // 1) current-user-principal / calendar-home-set（按候选根逐一尝试）
        const principalVariants = [
            `<d:propfind ${DAV_NAMESPACE}><d:prop><d:current-user-principal/><d:principal-URL/><d:resourcetype/><c:calendar-home-set/></d:prop></d:propfind>`,
            `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:current-user-principal/><d:principal-URL/><d:resourcetype/><c:calendar-home-set/></d:prop></d:propfind>`,
            `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/><d:principal-URL/><d:resourcetype/></d:prop></d:propfind>`,
        ];
        for (const candidate of candidates) {
            const response = await this.fetchProps(candidate, "0", principalVariants).catch((error: unknown) => {
                // 401 需要原样抛出（凭据问题）；其余失败继续尝试下一个候选根
                if (error instanceof CalDavError && error.status === 401) {
                    throw error;
                }
                return undefined;
            });
            if (!response) {
                continue;
            }
            lastStatus = response.status;
            if (response.status >= 400) {
                continue;
            }
            for (const item of this.parseMultiStatus(response.body)) {
                // 同一个响应里可能直接给出 calendar-home-set（少数服务端如此）
                const home = item.props["calendar-home-set"] as Record<string, unknown> | undefined;
                const homeHref = textOf(home?.href) ?? textOf(home);
                if (homeHref && !homeSet) {
                    homeSet = normalizeUrl(hrefToUrl(homeHref, candidate));
                }
                if (!principalUrl) {
                    const cup = item.props["current-user-principal"] as Record<string, unknown> | undefined;
                    const principal = textOf(cup?.href) ?? textOf(cup);
                    if (principal) {
                        principalUrl = hrefToUrl(principal, candidate);
                    } else {
                        const principalUrlProp = textOf(item.props["principal-URL"]);
                        if (principalUrlProp) {
                            principalUrl = hrefToUrl(principalUrlProp, candidate);
                        }
                    }
                }
            }
            if (principalUrl || homeSet) {
                break;
            }
        }
        if (!principalUrl && !homeSet) {
            // 所有候选根都不可用：给出可执行的提示（企业微信需要 /calendar/ 这类路径）
            // 如果上一个候选返回的是合法 DAV 应答（2xx），说明服务确实存在，
            // 只是这个地址上没有日历信息（例如填成了通讯录地址）→ 不抛错，返回空日历列表。
            if (!(lastStatus >= 200 && lastStatus < 300)) {
                throw new CalDavError(
                    lastStatus === 403 || lastStatus === 401
                        ? `服务端拒绝访问（HTTP ${lastStatus}）。请检查账号/授权码；企业微信/QQ 邮箱请把服务器地址填成 https://<域名>/calendar/ 这类可用的 CalDAV 根地址（插件也会尝试 /.well-known/caldav）。`
                        : `未能在 ${base} 上发现 CalDAV 服务（HTTP ${lastStatus || "无响应"}）。请确认服务器地址。`,
                    lastStatus,
                    base,
                );
            }
            return { principalUrl: undefined, homeSet: undefined, calendars: [] };
        }
        if (!principalUrl) {
            principalUrl = homeSet ?? base;
        }
        // 服务端（如 QQ 邮箱）可能只在 principal 上给出 current-user-principal、不提供
        // calendar-home-set。此时沿用历史行为：把 principal 自身当作日历主目录，
        // 这样「主目录即集合」的服务端仍能通过后续兜底被发现。
        if (!homeSet) {
            homeSet = normalizeUrl(principalUrl);
        }

        // 2) calendar-home-set（同样做命名空间回退）
        const homeResponse = await this.fetchProps(principalUrl, "0", [
            `<d:propfind ${DAV_NAMESPACE}><d:prop><c:calendar-home-set/><d:displayname/></d:prop></d:propfind>`,
            `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/><d:displayname/></d:prop></d:propfind>`,
            CalDavClient.PROPFIND_MINIMAL,
        ]).catch(() => undefined);
        if (homeResponse && homeResponse.status < 400) {
            for (const item of this.parseMultiStatus(homeResponse.body)) {
                const home = item.props["calendar-home-set"] as Record<string, unknown> | undefined;
                const href = textOf(home?.href) ?? textOf(home);
                if (href) {
                    homeSet = normalizeUrl(hrefToUrl(href, principalUrl));
                    break;
                }
            }
        }
        if (!homeSet) {
            homeSet = normalizeUrl(principalUrl);
        }

        // 3) 枚举日历集合（depth 1；部分服务端需要 depth infinity，失败时再放开）
        let calendars = await this.listCalendars(homeSet, "1");
        if (!calendars.length) {
            const deeper = await this.listCalendars(homeSet, "infinity").catch(() => [] as RemoteCalendar[]);
            calendars = deeper;
        }
        if (!calendars.length && base !== homeSet) {
            const fallback = await this.listCalendars(base, "1").catch(() => [] as RemoteCalendar[]);
            calendars = fallback;
        }

        // 4) 兜底：某些服务端（如 QQ 邮箱）不通过 PROPFIND 枚举子集合，
        //    而是把「主目录自身」当作唯一日历集合使用。此时若发现结果为空，
        //    把 homeSet 当作一个日历集合，让后续 REPORT 至少打到正确的地址。
        if (!calendars.length) {
            const asCalendar = await this.probeAsCalendar(homeSet);
            if (asCalendar) {
                calendars = [asCalendar];
            }
        }
        return { principalUrl, homeSet, calendars };
    }

    /**
     * 判断某个集合能否直接当作日历使用。
     *
     * 用于 `listCalendars` 无结果的场景：先做一次 depth 0 的 PROPFIND 确认它是可访问的集合
     * （并能拿到 displayname），再确认它不是通讯录；如果可以就把它作为单个日历返回。
     */
    private async probeAsCalendar(url: string): Promise<RemoteCalendar | undefined> {
        const response = await this.fetchProps(url, "0", [
            `<d:propfind ${DAV_NAMESPACE}><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><ic:calendar-color/><cs:getctag/></d:prop></d:propfind>`,
            `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>`,
            CalDavClient.PROPFIND_MINIMAL,
        ]).catch(() => undefined);
        if (!response || response.status >= 400) {
            return undefined;
        }
        for (const item of this.parseMultiStatus(response.body)) {
            const resourceType = item.props.resourcetype as Record<string, unknown> | undefined;
            // 明确的通讯录直接排除；明确的日历直接采用
            if (resourceType?.addressbook !== undefined) {
                continue;
            }
            const displayName = textOf(item.props.displayname)?.trim() || undefined;
            const components = asArray(
                (item.props["supported-calendar-component-set"] as Record<string, unknown> | undefined)?.comp as
                    | Record<string, unknown>
                    | Record<string, unknown>[],
            )
                .map((comp) => String((comp as Record<string, unknown>)["@_name"] ?? ""))
                .filter(Boolean);
            const privileges = item.props["current-user-privilege-set"] as Record<string, unknown> | undefined;
            void privileges;
            return {
                url: normalizeUrl(hrefToUrl(item.href || url, response.url)),
                displayName: displayName ?? this.displayNameFromUrl(url),
                color: normalizeColor(textOf(item.props["calendar-color"])),
                readOnly: false,
                components: components.length ? components : ["VEVENT"],
                ctag: textOf(item.props.getctag),
            };
        }
        return undefined;
    }

    /** 由 URL 末段推断显示名（兜底用） */
    private displayNameFromUrl(url: string): string | undefined {
        const segments = normalizeUrl(url).replace(/\/+$/, "").split("/");
        const last = segments[segments.length - 1];
        if (!last) {
            return undefined;
        }
        try {
            return decodeURIComponent(last);
        } catch {
            return last;
        }
    }

    /** 列举 calendar-home 下的日历集合 */
    async listCalendars(url: string, depth: "0" | "1" | "infinity" = "1"): Promise<RemoteCalendar[]> {
        const homeUrl = normalizeUrl(url);
        // 属性集按「完整 → 精简」逐级回退：
        // 企业微信 CalDAV 只要请求里出现 xmlns:cs="http://calendarserver.org/ns/" 就返回 400，
        // 因此完整请求失败时必须退回更保守的属性集，而不是直接抛错。
        const response = await this.fetchProps(homeUrl, depth, [
            `<d:propfind ${DAV_NAMESPACE}><d:prop><d:resourcetype/><d:displayname/><d:current-user-privilege-set/><c:supported-calendar-component-set/><ic:calendar-color/><cs:getctag/><d:sync-token/><c:calendar-description/></d:prop></d:propfind>`,
            // 去掉 calendarserver / apple 命名空间
            `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><d:current-user-privilege-set/><c:supported-calendar-component-set/><d:sync-token/><c:calendar-description/></d:prop></d:propfind>`,
            // 最保守：只用 DAV 核心属性
            CalDavClient.PROPFIND_MINIMAL,
        ]);
        if (response.status >= 400) {
            throw new CalDavError(
                `列举日历时服务端返回 HTTP ${response.status}`,
                response.status,
                response.url,
                response.body.slice(0, 400),
            );
        }
        const calendars: RemoteCalendar[] = [];
        for (const item of this.parseMultiStatus(response.body)) {
            const resourceType = item.props.resourcetype as Record<string, unknown> | undefined;
            const inCalendarHome = sameCollection(item.href, homeUrl);
            const hasCalendarType = !!resourceType && resourceType.calendar !== undefined;
            const hasAddressbookType = !!resourceType && resourceType.addressbook !== undefined;
            const displayName = textOf(item.props.displayname)?.trim() || undefined;
            // 兼容不做完整 resourcetype 应答的服务端（典型：QQ 邮箱 dav.qq.com
            // 只返回 displayname，不返回 resourcetype / supported-calendar-component-set）。
            // 判定规则：位于日历主目录「之下」的子集合、带 displayname、且不是通讯录，视为日历集合。
            // 主目录自身只有在显式声明 <c:calendar/> 时才算日历，避免把主目录误当集合。
            const isNested = !sameCollection(item.href, homeUrl);
            const looksLikeCalendar =
                hasCalendarType ||
                (isNested && inCalendarHome && !!displayName && !hasAddressbookType);
            if (!looksLikeCalendar || hasAddressbookType) {
                continue;
            }
            const privileges = item.props["current-user-privilege-set"] as Record<string, unknown> | undefined;
            const privilegeNames = asArray(privileges?.privilege as Record<string, unknown> | Record<string, unknown>[])
                .map((entry) => Object.keys(entry)[0])
                .filter(Boolean);
            const readOnly =
                privilegeNames.length > 0 &&
                !privilegeNames.includes("write") &&
                !privilegeNames.includes("write-content") &&
                !privilegeNames.includes("all");
            const components = asArray(
                (item.props["supported-calendar-component-set"] as Record<string, unknown> | undefined)?.comp as
                    | Record<string, unknown>
                    | Record<string, unknown>[],
            )
                .map((comp) => String((comp as Record<string, unknown>)["@_name"] ?? ""))
                .filter(Boolean);
            calendars.push({
                url: normalizeUrl(hrefToUrl(item.href, response.url)),
                displayName: textOf(item.props.displayname)?.trim() || undefined,
                color: normalizeColor(textOf(item.props["calendar-color"])),
                readOnly,
                components: components.length ? components : ["VEVENT"],
                description: textOf(item.props["calendar-description"]),
                ctag: textOf(item.props.getctag),
                syncToken: textOf(item.props["sync-token"]),
            });
        }
        return calendars;
    }

    /* —— 读取事件 —— */

    /**
     * 拉取时间区间内的事件资源。
     * 优先使用 RFC 6578 sync-collection（带 syncToken 时增量），失败则回退 calendar-query 全量。
     */
    async fetchEvents(calendar: RemoteCalendar, start: number, end: number, syncToken?: string): Promise<RemoteCalendarObjects> {
        if (syncToken) {
            try {
                return await this.syncCollection(calendar, syncToken);
            } catch (error) {
                this.options.log?.("sync-collection 失败，回退全量查询", error);
            }
        }
        return this.calendarQuery(calendar, start, end);
    }

    private async calendarQuery(calendar: RemoteCalendar, start: number, end: number): Promise<RemoteCalendarObjects> {
        // 请求体按「兼容性从高到低」排列，逐个尝试。
        //
        // 关键取舍：**不使用 partial retrieval**。RFC 4791 §9.6.5 允许在 <c:calendar-data> 里用
        // <c:comp>/<c:prop> 指定只返回部分属性，合规服务端会据此把 SUMMARY/DTSTART 等全部裁掉
        // （客户端就会看到「有资源、没字段」）。因此这里一律请求完整 calendar-data。
        //
        // 变体顺序：
        //   1. VEVENT + time-range（最标准，兼容性最好）
        //   2. VEVENT + VTODO + time-range（任务型日历需要）
        //   3. 去掉 time-range：部分服务端（实测企业微信）忽略它，本地仍会按窗口过滤
        //   4. 只列资源（href + etag），正文交给 multiget / 逐条 GET / PROPFIND 枚举
        //
        // 顺序要点：**单个 comp-filter 必须排在组合之前**——实测 QQ 邮箱对
        // 「同一个 filter 里两个 comp-filter」返回空结果，会让事件被误判成「没有事件」。
        const bodies = [
            // 1) 只请求 VEVENT + time-range
            `<c:calendar-query ${DAV_NAMESPACE}>
  <d:prop><d:getetag/><d:getlastmodified/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${formatUtcBasic(start)}" end="${formatUtcBasic(end)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
            // 2) 同时请求 VTODO（任务型日历）
            `<c:calendar-query ${DAV_NAMESPACE}>
  <d:prop><d:getetag/><d:getlastmodified/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${formatUtcBasic(start)}" end="${formatUtcBasic(end)}"/>
      </c:comp-filter>
      <c:comp-filter name="VTODO">
        <c:time-range start="${formatUtcBasic(start)}" end="${formatUtcBasic(end)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
            // 3) 去掉 time-range
            `<c:calendar-query ${DAV_NAMESPACE}>
  <d:prop><d:getetag/><d:getlastmodified/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT"/>
      <c:comp-filter name="VTODO"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
            // 4) 只列资源
            `<c:calendar-query ${DAV_NAMESPACE}>
  <d:prop><d:getetag/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"/></c:filter>
</c:calendar-query>`,
        ];

        let best: RemoteCalendarObjects | undefined;
        let lastError: unknown;
        /** 是否至少拿到过一次 2xx 应答：用于区分「日历确实为空」与「所有请求都失败」 */
        let sawSuccess = false;
        // 记忆「上次奏效的变体」：企业微信这类服务端会让前几个变体全部空手而归，
        // 每次都从头试一遍会产生大量多余请求（实测日志里出现过每次刷新 6 个 REPORT）。
        const remembered = this.queryVariant.get(calendar.url);
        const order = remembered === undefined ? bodies.map((_, index) => index) : [remembered];
        let tried = 0;
        for (const index of order) {
            if (index >= bodies.length) {
                continue;
            }
            if (remembered === undefined && tried >= 3) {
                break;
            }
            tried++;
            let response: Awaited<ReturnType<CalDavClient["dav"]>>;            try {
                response = await this.dav({
                    url: calendar.url,
                    method: "REPORT",
                    depth: "1",
                    body: bodies[index],
                });
            } catch (error) {
                lastError = error;
                continue;
            }
            if (response.status === 403 || response.status === 404) {
                // 日历本身不可访问：重试其他请求体没有意义
                throw new CalDavError(
                    `日历不可访问（HTTP ${response.status}）：${calendar.url}`,
                    response.status,
                    response.url,
                );
            }
            if (response.status >= 400) {
                this.options.log?.(`calendar-query 变体 ${index + 1} 被拒绝（HTTP ${response.status}），尝试下一个`);
                lastError = new CalDavError(`查询事件失败（HTTP ${response.status}）`, response.status, response.url);
                this.queryVariant.delete(calendar.url);
                continue;
            }
            const resources = this.parseResources(response.body, calendar.url);
            sawSuccess = true;
            const hasContent = resources.some((item) => item.ics);
            const objects: RemoteCalendarObjects = { resources, fullSync: true, hasContent };
            if (hasContent) {
                this.queryVariant.set(calendar.url, index);
                return objects;
            }
            // 有资源但没正文：记住这个变体，正文交给 multiget / 逐条 GET / PROPFIND
            if (resources.length) {
                best ??= objects;
                this.options.log?.(`calendar-query 变体 ${index + 1} 未返回 calendar-data（${resources.length} 个资源）`);
                this.queryVariant.set(calendar.url, index);
                return objects;
            }
            // 空结果：**不能**就此认定「日历为空」——任务型服务端（Vikunja）对 VEVENT 过滤
            // 本来就返回空，必须继续试带 VTODO 的变体。只有在首次探测、
            // 且已经把所有变体都试过之后才记录该变体，避免每次同步都重复试探。
            this.options.log?.(`calendar-query 变体 ${index + 1} 返回空结果，继续尝试其他变体`);
            if (remembered === undefined && tried >= bodies.length) {
                this.queryVariant.set(calendar.url, index);
            }
        }
        if (best) {
            // 服务端不内联正文：记住本次变体，后续直接复用，避免每轮重复试探
            this.queryVariant.set(calendar.url, remembered ?? Math.min(tried, bodies.length) - 1);
            return best;
        }
        // 所有变体都返回空，但至少有一次成功应答 → 这个日历确实没有内容（不是错误）
        if (sawSuccess) {
            this.queryVariant.set(calendar.url, remembered ?? 0);
            return { resources: [], fullSync: true, hasContent: true };
        }
        throw lastError instanceof CalDavError
            ? lastError
            : new CalDavError(`查询事件失败：所有请求变体均未成功`, 0, calendar.url);
    }

    /**
     * 只枚举资源标识（PROPFIND depth 1 + getetag），不请求正文。
     *
     * 作为最后一道兜底：有些服务端（例如 Vikunja 这类非标准实现）在 `REPORT` 上返回不了事件，
     * 但会把集合内的资源列在 PROPFIND 里；拿到 href 后由适配器逐条 GET 补齐内容。
     */
    async listResources(calendarUrl: string): Promise<RemoteEventResource[]> {
        const response = await this.fetchProps(normalizeUrl(calendarUrl), "1", [
            `<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getcontenttype/><d:getlastmodified/></d:prop></d:propfind>`,
            CalDavClient.PROPFIND_MINIMAL,
        ]);
        if (response.status >= 400) {
            throw new CalDavError(
                `枚举日历资源失败（HTTP ${response.status}）`,
                response.status,
                response.url,
            );
        }
        const base = normalizeUrl(calendarUrl);
        return this.parseMultiStatus(response.body)
            .filter((item) => {
                // 过滤掉集合自身（以及子集合）与非日历资源
                if (sameCollection(item.href, base)) {
                    return false;
                }
                const resourceType = item.props.resourcetype as Record<string, unknown> | undefined;
                if (resourceType && (resourceType.collection !== undefined || resourceType.calendar !== undefined)) {
                    return false;
                }
                // 事件与任务资源都可能是 .ics；少数实现用 .vtodo
                return /\.(ics|vtodo|ifb)(\?|$)/i.test(item.href);
            })
            .map((item) => ({
                href: hrefToUrl(item.href, base),
                etag: normalizeEtag(textOf(item.props.getetag)),
                lastModified: textOf(item.props.getlastmodified),
            }));
    }

    private async syncCollection(calendar: RemoteCalendar, syncToken: string): Promise<RemoteCalendarObjects> {
        const body = `<d:sync-collection ${DAV_NAMESPACE}>
  <d:sync-token>${escapeXml(syncToken)}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
</d:sync-collection>`;
        // RFC 6578 §3.3：sync-collection 的 Depth 必须为 0（范围由 sync-level 决定）
        const response = await this.dav({ url: calendar.url, method: "REPORT", depth: "0", body });
        if (response.status === 403 || response.status === 409 || response.status === 400 || response.status === 412 || response.status === 501) {
            throw new CalDavError("sync-collection 不受支持", response.status, response.url);
        }
        if (response.status >= 400) {
            throw new CalDavError(`增量同步失败（HTTP ${response.status}）`, response.status, response.url);
        }
        const parsed = parser.parse(response.body) as Record<string, unknown>;
        const multistatus = parsed.multistatus as Record<string, unknown> | undefined;
        const resources = this.parseResources(response.body, calendar.url);
        return {
            resources,
            syncToken: textOf(multistatus?.["sync-token"]),
            fullSync: false,
        };
    }

    private parseResources(body: string, baseUrl: string): RemoteEventResource[] {
        return this.parseMultiStatus(body).map((item) => {
            const ics = textOf(item.props["calendar-data"]);
            const etag = normalizeEtag(textOf(item.props.getetag));
            return {
                // href 必须解析为绝对 URL：后续 PUT/DELETE 直接把它当请求地址使用，
                // 而服务端返回的多半是 `/dav/...` 这样的绝对路径。
                href: hrefToUrl(item.href, baseUrl),
                etag,
                ics: ics && looksLikeIcs(ics) ? ics : undefined,
                uid: ics ? extractUid(ics) : undefined,
                hash: ics ? hashString(ics) : undefined,
                lastModified: textOf(item.props.getlastmodified),
            };
        });
    }

    /* —— 写入 —— */

    /** 新建事件资源，返回服务端分配的 ETag 与最终 URL */
    async createEvent(calendarUrl: string, uid: string, ics: string, options?: { etag?: string }): Promise<{ url: string; etag?: string }> {
        const fileName = `${sanitizeFileName(uid)}.ics`;
        const url = normalizeUrl(calendarUrl) + fileName;
        const response = await this.dav({
            url,
            method: "PUT",
            body: ics,
            contentType: "text/calendar; charset=utf-8",
            headers: {
                "If-None-Match": "*",
                ...(options?.etag ? { "If-Match": quoteEtag(options.etag) ?? options.etag } : {}),
            },
        });
        if (response.status === 412) {
            // 同名资源已存在：直接覆盖一次
            const retry = await this.dav({
                url,
                method: "PUT",
                body: ics,
                contentType: "text/calendar; charset=utf-8",
            });
            if (retry.status >= 400) {
                throw new CalDavError(`创建事件失败（HTTP ${retry.status}）`, retry.status, retry.url, retry.body.slice(0, 300));
            }
            return { url: retry.url, etag: CalDavClient.header(retry, "ETag") };
        }
        if (response.status >= 400) {
            throw new CalDavError(`创建事件失败（HTTP ${response.status}）`, response.status, response.url, response.body.slice(0, 300));
        }
        return { url: response.url, etag: CalDavClient.header(response, "ETag") };
    }

    /** 覆盖已有事件资源；带 If-Match 做乐观并发控制 */
    async updateEvent(href: string, ics: string, etag?: string): Promise<{ etag?: string }> {
        const response = await this.dav({
            url: href,
            method: "PUT",
            body: ics,
            contentType: "text/calendar; charset=utf-8",
            headers: etag ? { "If-Match": quoteEtag(etag) ?? etag } : {},
        });
        if (response.status === 412) {
            throw new CalDavError("远端事件已被修改（ETag 不匹配）", 412, href);
        }
        if (response.status >= 400) {
            throw new CalDavError(`更新事件失败（HTTP ${response.status}）`, response.status, href, response.body.slice(0, 300));
        }
        return { etag: normalizeEtag(CalDavClient.header(response, "ETag")) };
    }

    async deleteEvent(href: string, etag?: string): Promise<void> {
        const response = await this.dav({
            url: href,
            method: "DELETE",
            headers: etag ? { "If-Match": quoteEtag(etag) ?? etag } : {},
        });
        if (response.status === 404 || response.status === 410) {
            return;
        }
        if (response.status >= 400) {
            throw new CalDavError(`删除事件失败（HTTP ${response.status}）`, response.status, href, response.body.slice(0, 300));
        }
    }

    /** 下载单个资源（用于冲突时取远端最新版本，或服务端不在 REPORT 里返回内容时补取） */
    async getEvent(href: string): Promise<{ ics: string; etag?: string }> {
        const result = await this.getEventAt(href);
        if (result.status === 404 || result.status === 410) {
            // 少数服务端（如 Vikunja 挂在 /api/v1/dav）返回的 href 不含挂载前缀，
            // 归一化可能仍然不对；这里用「去掉一层重复前缀」的地址再试一次。
            const alternative = dropDuplicatedPrefix(href);
            if (alternative && alternative !== href) {
                const retry = await this.getEventAt(alternative);
                if (retry.ics) {
                    return { ics: retry.ics, etag: retry.etag };
                }
                if (retry.status === 404 || retry.status === 410) {
                    throw new CalDavError(`事件已不存在（HTTP ${retry.status}）`, retry.status, href);
                }
                if (retry.status >= 400) {
                    throw new CalDavError(`读取事件失败（HTTP ${retry.status}）`, retry.status, href);
                }
            }
            throw new CalDavError(`事件已不存在（HTTP ${result.status}）`, result.status, href);
        }
        if (result.status >= 400) {
            throw new CalDavError(`读取事件失败（HTTP ${result.status}）`, result.status, href);
        }
        return { ics: result.ics ?? "", etag: result.etag };
    }

    private async getEventAt(href: string): Promise<{ status: number; ics?: string; etag?: string }> {
        const response = await this.dav({ url: href, method: "GET", headers: { Accept: "text/calendar" } });
        return {
            status: response.status,
            ics: response.status < 400 ? response.body : undefined,
            etag: normalizeEtag(CalDavClient.header(response, "ETag") ?? CalDavClient.header(response, "etag")),
        };
    }

    /**
     * `calendar-multiget`：按 href 批量取回事件内容。
     *
     * 需要它的原因：部分服务端（实测企业微信 caldav.wecom.work）在 `calendar-query` 里
     * 只返回 `getetag`，`calendar-data` 单独回 404；此时必须再按 href 取一次内容。
     * multiget 允许一次请求拿多条，比逐条 GET 省往返。
     */
    async multiget(calendarUrl: string, hrefs: string[]): Promise<RemoteEventResource[]> {
        if (!hrefs.length) {
            return [];
        }
        // 相对路径（规范要求）与绝对 URL（部分实现只认这个）各试一次；
        // Depth 必须是 0（RFC 4791 §7.9）：实测企业微信用 Depth:1 直接返回 403。
        const variants: Array<{ hrefs: string[]; depth: "0" | "1" }> = [
            { hrefs: hrefs.map(relativePath), depth: "0" },
            { hrefs, depth: "0" },
            { hrefs: hrefs.map(relativePath), depth: "1" },
        ];
        let lastError: unknown;
        for (const variant of variants) {
            const body = `<c:calendar-multiget ${DAV_NAMESPACE}>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  ${variant.hrefs.map((href) => `<d:href>${escapeXml(href)}</d:href>`).join("")}
</c:calendar-multiget>`;
            let response: Awaited<ReturnType<CalDavClient["dav"]>>;
            try {
                response = await this.dav({
                    url: normalizeUrl(calendarUrl),
                    method: "REPORT",
                    depth: variant.depth,
                    body,
                });
            } catch (error) {
                lastError = error;
                continue;
            }
            if (response.status >= 400) {
                lastError = new CalDavError(
                    `calendar-multiget 失败（HTTP ${response.status}）`,
                    response.status,
                    response.url,
                );
                continue;
            }
            const resources = this.parseResources(response.body, response.url);
            if (resources.some((item) => item.ics)) {
                return resources;
            }
        }
        if (lastError) {
            throw lastError;
        }
        return [];
    }

    /** 把远端日历转换为插件内的 CalendarInfo */
    toCalendarInfo(accountId: string, remote: RemoteCalendar, colorFallback?: string): CalendarInfo {
        return {
            id: calendarId(accountId, remote.url),
            name: remote.displayName || decodeURIComponent(remote.url.replace(/\/$/, "").split("/").pop() || remote.url),
            color: remote.color || colorFallback,
            readOnly: remote.readOnly,
            source: {
                kind: "caldav",
                accountId,
                calendarUrl: remote.url,
                displayName: remote.displayName,
                color: remote.color || colorFallback,
                readOnly: remote.readOnly,
                components: remote.components,
            },
        };
    }
}

export function calendarId(accountId: string, calendarUrl: string): string {
    return `caldav:${accountId}:${encodeURIComponent(normalizeUrl(calendarUrl))}`;
}

/** 从 CalendarInfo.id 反解账户与日历 URL */
export function parseCalendarId(id: string): { accountId: string; calendarUrl: string } | undefined {
    const parts = id.split(":");
    if (parts.length < 3 || parts[0] !== "caldav") {
        return undefined;
    }
    return { accountId: parts[1], calendarUrl: decodeURIComponent(parts.slice(2).join(":")) };
}

/** 事件映射键（与 MappingStore 保持一致） */
export function mappingKeyOf(calendarUrl: string, uid: string): string {
    return `${calendarUrl}\u0000${uid}`;
}

function sanitizeFileName(uid: string): string {
    const cleaned = uid.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
    return cleaned.length ? cleaned : `event-${Date.now().toString(36)}`;
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function formatUtcBasic(ts: number): string {
    const date = new Date(ts);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function normalizeColor(color: string | undefined): string | undefined {
    if (!color) {
        return undefined;
    }
    const value = color.trim();
    // ical 使用 #RRGGBBAA
    if (/^#[0-9a-fA-F]{8}$/.test(value)) {
        return `${value.slice(0, 7)}`;
    }
    return value;
}

/** 基础认证使用 UTF-8 编码（btoa 只支持 Latin-1） */
function encodeBase64Utf8(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}
