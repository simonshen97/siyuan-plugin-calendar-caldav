/**
 * 思源运行时（`siyuan` 模块）在单元测试中的桩实现。
 *
 * 通过 `vitest.config.ts` 的 alias 把 `import ... from "siyuan"` 指向本文件，
 * 这样无需启动思源即可测试依赖内核接口的模块。
 */

import { vi } from "vitest";

export interface RecordedCall {
    endpoint: string;
    payload: unknown;
}

/** 已记录的内核调用（测试断言用） */
export const calls: RecordedCall[] = [];

/** 由测试设置的响应处理器：返回 undefined 时回落到 `{code: 0, msg: "", data: null}` */
export const responder: { current: (endpoint: string, payload: unknown) => unknown } = {
    current: () => ({ code: 0, msg: "", data: null }),
};

export function resetKernelMock(): void {
    calls.length = 0;
    responder.current = () => ({ code: 0, msg: "", data: null });
}

export function lastCall(): RecordedCall | undefined {
    return calls[calls.length - 1];
}

export async function fetchSyncPost(
    endpoint: string,
    payload?: unknown,
    _headers?: Record<string, string>,
    _process?: boolean,
    _signal?: AbortSignal,
): Promise<unknown> {
    calls.push({ endpoint, payload });
    return responder.current(endpoint, payload);
}

export const fetchPost = vi.fn();
export const fetchGet = vi.fn();

export class Plugin {}
export class Custom {}
export class MobileCustom {}
export class Model {}
export class Tab {}
export class Setting {}
export class EventBus {
    on(): void {
        /* noop */
    }
    off(): void {
        /* noop */
    }
    emit(): void {
        /* noop */
    }
}

export const Constants = { SIYUAN_APPID: "test" };
export const platformUtils = { isMobile: () => false, isBrowser: () => true };
export function showMessage(): void {
    /* noop */
}
export function confirm(): void {
    /* noop */
}
