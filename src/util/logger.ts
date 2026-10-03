/**
 * 统一日志器。
 *
 * 为什么要自己实现：思源桌面版没有浏览器控制台入口（要在「设置 → 关于」里打开/
 * 或用快捷键），普通用户根本看不到 `console.log`。因此这里额外做两件事：
 *
 * 1. 把日志缓存在内存里（默认最近 500 条），可以在插件内直接查看并复制；
 * 2. 可选写入思源自身的系统日志（`/api/log/pushMsg`），在「设置 → 关于 → 系统日志」里可见。
 *
 * 敏感信息（Authorization / Basic / 密码等）在入库前会被脱敏。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
    time: number;
    level: LogLevel;
    message: string;
}

const MAX_ENTRIES = 500;
const PREFIX = "[calendar-caldav]";
/** 命中这些模式的片段会被替换，避免把凭据写进日志 */
const SENSITIVE_PATTERNS: RegExp[] = [
    /(Basic|Bearer)\s+[A-Za-z0-9+/=._-]{6,}/gi,
    // 同时覆盖带引号与不带引号两种写法：password=xxx / "password": "xxx"
    /("?(?:password|token|secret|authorization)"?\s*[:=]\s*)(?:"[^"]*"|[^\s,;&#]+)/gi,
];

export function redact(text: string): string {
    let out = text;
    for (const pattern of SENSITIVE_PATTERNS) {
        out = out.replace(pattern, (_match, group?: string) => (group ? `${group}"***"` : "***"));
    }
    return out;
}

function stringify(value: unknown): string {
    if (value === undefined) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (value instanceof Error) {
        return `${value.name}: ${value.message}`;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/** 调试日志里 JSON 的最大长度：超长截断，避免一条日志把缓冲区占满 */
const MAX_JSON_LENGTH = 4000;

/**
 * 把任意值格式化成「适合贴进日志」的一行 JSON。
 *
 * 用途：排查内核接口问题时需要看到**真实请求体与响应体**，但又不能把日志撑爆，
 * 因此这里统一做脱敏 + 截断（`onelineJson(payload)`）。
 */
export function onelineJson(value: unknown, maxLength = MAX_JSON_LENGTH): string {
    let text: string;
    if (typeof value === "string") {
        text = value;
    } else {
        try {
            text = JSON.stringify(value);
        } catch {
            text = String(value);
        }
    }
    if (text === undefined) {
        text = "";
    }
    const redacted = redact(text);
    return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…(+${redacted.length - maxLength})` : redacted;
}

class Logger {
    private entries: LogEntry[] = [];
    private enabled = false;
    /** 当无法访问 console 时兜底（例如被宿主环境屏蔽） */
    private consoleAvailable = true;

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    /** 关闭/恢复控制台镜像输出（单测里用来避免污染测试输出） */
    setConsoleOutput(enabled: boolean): void {
        this.consoleAvailable = enabled;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /** 记录一条日志；`level` 为非 debug 时即使未开启调试也记录（错误始终保留） */
    log(message: string, ...rest: unknown[]): void {
        const level: LogLevel = rest.length && rest[0] instanceof Error ? "error" : "info";
        this.write(level, message, rest);
    }

    debug(message: string, ...rest: unknown[]): void {
        if (!this.enabled) {
            return;
        }
        this.write("debug", message, rest);
    }

    warn(message: string, ...rest: unknown[]): void {
        this.write("warn", message, rest);
    }

    error(message: string, ...rest: unknown[]): void {
        this.write("error", message, rest);
    }

    private write(level: LogLevel, message: string, rest: unknown[]): void {
        const suffix = rest.length ? ` ${rest.map(stringify).filter(Boolean).join(" ")}` : "";
        const line = redact(`${message}${suffix}`);
        this.entries.push({ time: Date.now(), level, message: line });
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        }
        if (this.consoleAvailable) {
            try {
                if (level === "error") {
                    console.error(`${PREFIX} ${line}`);
                } else if (level === "warn") {
                    console.warn(`${PREFIX} ${line}`);
                } else {
                    console.log(`${PREFIX} ${line}`);
                }
            } catch {
                this.consoleAvailable = false;
            }
        }
    }

    /** 供查看面板使用的快照 */
    snapshot(): LogEntry[] {
        return [...this.entries];
    }

    /** 导出为可复制的纯文本（最新在最后） */
    toText(): string {
        return this.entries
            .map((entry) => `${new Date(entry.time).toLocaleTimeString()} ${entry.level.toUpperCase()} ${entry.message}`)
            .join("\n");
    }

    /**
     * 导出为「带时间戳」的文本，适合写入文件后发给他人排查。
     *
     * `toText` 只有时分秒；这里补上完整日期与毫秒，跨天排查时不会混淆。
     */
    toDump(header: string[] = []): string {
        const lines: string[] = [...header];
        if (lines.length) {
            lines.push("");
        }
        for (const entry of this.entries) {
            const time = new Date(entry.time);
            const stamp =
                `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, "0")}-${String(time.getDate()).padStart(2, "0")} ` +
                `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}:${String(
                    time.getSeconds(),
                ).padStart(2, "0")}.${String(time.getMilliseconds()).padStart(3, "0")}`;
            lines.push(`${stamp} ${entry.level.toUpperCase()} ${entry.message}`);
        }
        return lines.join("\n");
    }

    clear(): void {
        this.entries = [];
    }

    get size(): number {
        return this.entries.length;
    }
}

export const logger = new Logger();

/**
 * 把日志镜像到思源自身的系统日志（`/api/log/pushMsg`），
 * 这样在「设置 → 关于 → 系统日志」里也能看到（手机端尤其有用）。
 * 仅在调试开启时写入，避免污染思源日志。
 */
export function mirrorToSystemLog(push: (msg: string) => Promise<unknown>): void {
    const original = logger.log.bind(logger);
    logger.log = (message: string, ...rest: unknown[]) => {
        original(message, ...rest);
        if (logger.isEnabled()) {
            const suffix = rest.length ? ` ${rest.map(stringify).filter(Boolean).join(" ")}` : "";
            void push(redact(`${PREFIX} ${message}${suffix}`)).catch(() => undefined);
        }
    };
}
