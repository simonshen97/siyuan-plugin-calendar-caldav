/**
 * 轻量工具：base64（不依赖 Node Buffer，插件运行在渲染进程且 `crypto` 被 external 化）。
 */

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
    const table = new Int16Array(256).fill(-1);
    for (let i = 0; i < CHARS.length; i++) {
        table[CHARS.charCodeAt(i)] = i;
    }
    return table;
})();

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export function bytesToBase64(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += CHARS[b0 >> 2];
        out += CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
        out += i + 1 < bytes.length ? CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
        out += i + 2 < bytes.length ? CHARS[b2 & 0x3f] : "=";
    }
    return out;
}

export function base64ToBytes(base64: string): Uint8Array {
    const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
    const length = Math.floor((clean.length * 3) / 4);
    const bytes = new Uint8Array(length);
    let byteIndex = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const c0 = LOOKUP[clean.charCodeAt(i)];
        const c1 = LOOKUP[clean.charCodeAt(i + 1)];
        const c2 = i + 2 < clean.length ? LOOKUP[clean.charCodeAt(i + 2)] : -1;
        const c3 = i + 3 < clean.length ? LOOKUP[clean.charCodeAt(i + 3)] : -1;
        if (c0 < 0 || c1 < 0) {
            continue;
        }
        if (byteIndex < length) {
            bytes[byteIndex++] = (c0 << 2) | (c1 >> 4);
        }
        if (c2 >= 0 && byteIndex < length) {
            bytes[byteIndex++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
        }
        if (c3 >= 0 && byteIndex < length) {
            bytes[byteIndex++] = ((c2 & 0x03) << 6) | c3;
        }
    }
    return bytes;
}

export function encodeBase64(text: string): string {
    return bytesToBase64(encoder.encode(text));
}

export function decodeBase64(base64: string): string {
    return decoder.decode(base64ToBytes(base64));
}

export function utf8Bytes(text: string): Uint8Array {
    return encoder.encode(text);
}

/** 非加密哈希（FNV-1a 32bit，十六进制）：用于变更检测，不用于安全场景 */
export function hashString(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 生成 UUID（优先 crypto.randomUUID） */
export function uuid(): string {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
        return cryptoObj.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
        const random = (Math.random() * 16) | 0;
        const value = char === "x" ? random : (random & 0x3) | 0x8;
        return value.toString(16);
    });
}

export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): T {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return ((...args: never[]) => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = null;
            fn(...args);
        }, wait);
    }) as T;
}

/** 把异步任务并发执行（限制并发数，保持结果顺序） */
export async function mapLimit<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const run = async (): Promise<void> => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
    return results;
}

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
