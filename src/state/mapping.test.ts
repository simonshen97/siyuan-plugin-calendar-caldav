import { beforeEach, describe, expect, it } from "vitest";
import { MappingStore, mappingKey, normalizeMappingData } from "./mapping";
import type { EventMapping } from "../types";

interface Harness {
    store: MappingStore;
    saved: unknown[];
    loadResult: unknown;
}

function harness(loadResult: unknown = undefined, debounceMs = 5): Harness {
    const saved: unknown[] = [];
    const state = { loadResult };
    const store = new MappingStore(
        {
            load: async () => state.loadResult,
            save: async (_name, data) => {
                saved.push(data);
                return { code: 0, msg: "", data: null };
            },
        },
        debounceMs,
    );
    return { store, saved, loadResult };
}

const sample: EventMapping = {
    uid: "uid-1",
    calendarUrl: "https://dav.example.com/c/work/",
    href: "https://dav.example.com/c/work/uid-1.ics",
    etag: '"e1"',
    remoteHash: "abc",
    localHash: "def",
    local: { kind: "block", blockID: "20250101120000-abc123", writtenAt: 1 },
    syncedAt: 1,
    lastDirection: "pull",
};

describe("normalizeMappingData", () => {
    it("过滤结构非法的条目，并把非法数值归零", () => {
        const data = normalizeMappingData({
            version: 2,
            events: {
                [mappingKey(sample.calendarUrl, sample.uid)]: sample,
                broken1: { uid: "x" }, // 缺少 calendarUrl
                broken2: null,
                broken3: { uid: "y", calendarUrl: "z", syncedAt: "not-a-number" },
            },
        });
        // sample 与 broken3 保留，broken1（缺 calendarUrl）与 broken2（非对象）被丢弃
        expect(Object.keys(data.events)).toHaveLength(2);
        expect(data.events[mappingKey(sample.calendarUrl, sample.uid)]?.etag).toBe('"e1"');
        expect(data.events.broken3?.syncedAt).toBe(0);
    });

    it("非法输入返回空表", () => {
        expect(normalizeMappingData(undefined).events).toEqual({});
        expect(normalizeMappingData("nope").events).toEqual({});
        expect(normalizeMappingData({ events: [] }).events).toEqual({});
    });
});

describe("MappingStore", () => {
    let h: Harness;

    beforeEach(() => {
        h = harness();
    });

    it("load 后为空表，set/get/delete 生效", async () => {
        await h.store.load();
        expect(h.store.size).toBe(0);
        h.store.set(sample);
        expect(h.store.size).toBe(1);
        expect(h.store.get(sample.calendarUrl, sample.uid)?.etag).toBe('"e1"');
        expect(h.store.findByUid("uid-1")).toHaveLength(1);
        h.store.delete(sample.calendarUrl, sample.uid);
        expect(h.store.size).toBe(0);
    });

    it("findByLocal 支持 blockID 与 itemID", async () => {
        await h.store.load();
        h.store.set(sample);
        h.store.set({
            ...sample,
            uid: "uid-av",
            local: { kind: "avItem", itemID: "20250101120000-rowid", avID: "av-1", dateKeyID: "key-1" },
        });
        expect(h.store.findByLocal({ blockID: "20250101120000-abc123" })?.uid).toBe("uid-1");
        expect(h.store.findByLocal({ itemID: "20250101120000-rowid" })?.uid).toBe("uid-av");
        expect(h.store.findByLocal({ blockID: "other" })).toBeUndefined();
        expect(h.store.findByLocal({})).toBeUndefined();
    });

    it("deleteByCalendar 只清理该日历", async () => {
        await h.store.load();
        h.store.set(sample);
        h.store.set({ ...sample, uid: "uid-2", calendarUrl: "https://dav.example.com/c/other/" });
        h.store.deleteByCalendar(sample.calendarUrl);
        expect(h.store.size).toBe(1);
        expect(h.store.get("https://dav.example.com/c/other/", "uid-2")).toBeDefined();
    });

    it("flush 落盘并记录最近一次同步报告", async () => {
        await h.store.load();
        h.store.set(sample);
        h.store.setLastReport({
            startedAt: 1,
            finishedAt: 2,
            pulled: 3,
            pushed: 4,
            created: 1,
            updated: 1,
            deleted: 0,
            skipped: 0,
            conflicts: 0,
            errors: [],
        });
        await h.store.flush();
        expect(h.saved.length).toBeGreaterThan(0);
        const last = h.saved[h.saved.length - 1] as { version: number; events: Record<string, unknown>; lastReport?: { pulled: number } };
        expect(last.version).toBe(2);
        expect(Object.keys(last.events)).toHaveLength(1);
        expect(last.lastReport?.pulled).toBe(3);
    });

    it("去抖写入：短时间多次 set 只落盘一次", async () => {
        await h.store.load();
        for (let index = 0; index < 5; index++) {
            h.store.set({ ...sample, uid: `uid-${index}` });
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        await h.store.flush();
        expect(h.saved.length).toBe(1);
        expect(Object.keys((h.saved[0] as { events: Record<string, unknown> }).events)).toHaveLength(5);
    });

    it("载入已有映射后可继续读写", async () => {
        const existing = harness({ version: 2, events: { [mappingKey(sample.calendarUrl, sample.uid)]: sample } });
        await existing.store.load();
        expect(existing.store.size).toBe(1);
        existing.store.delete(sample.calendarUrl, sample.uid);
        await existing.store.flush();
        expect(existing.store.size).toBe(0);
    });

    it("保存失败不抛出（避免同步流程被持久化问题打断）", async () => {
        const saved: unknown[] = [];
        const store = new MappingStore(
            {
                load: async () => undefined,
                save: async (_name, data) => {
                    saved.push(data);
                    throw new Error("disk full");
                },
            },
            5,
        );
        await store.load();
        store.set(sample);
        await expect(store.flush()).resolves.toBeUndefined();
        expect(saved).toHaveLength(1);
    });
});
