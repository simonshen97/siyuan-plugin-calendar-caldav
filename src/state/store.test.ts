import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarStore } from "./store";
import { MappingStore } from "./mapping";
import type { ISourceAdapter } from "./sources";
import type { CalendarEvent, CalendarInfo, PluginSettings } from "../types";
import { defaultSettings } from "../settings";

function settings(): PluginSettings {
    const value = defaultSettings();
    value.sync.pastDays = 30;
    value.sync.futureDays = 30;
    value.advanced.concurrency = 2;
    return value;
}

class FakeAdapter implements ISourceAdapter {
    calls = 0;
    fail = false;

    constructor(
        readonly info: CalendarInfo,
        private readonly events: CalendarEvent[],
        private readonly writable = true,
    ) {}

    isWritable(): boolean {
        return this.writable;
    }

    owns(event: CalendarEvent): boolean {
        return event.calendar === this.info.id;
    }

    async loadEvents(_start: number, _end: number): Promise<CalendarEvent[]> {
        this.calls++;
        if (this.fail) {
            throw new Error("网络错误");
        }
        return this.events.map((event) => ({ ...event }));
    }
}

const DAY = 86_400_000;

function event(uid: string, calendar: string, start: number, end = start + 3_600_000): CalendarEvent {
    return {
        uid,
        calendar,
        sourceKind: "caldav",
        title: uid,
        start,
        end,
        allDay: false,
    };
}

function info(id: string, name = id): CalendarInfo {
    return {
        id,
        name,
        source: { kind: "caldav", accountId: "acct_1", calendarUrl: `https://dav/${id}/` },
    };
}

describe("CalendarStore", () => {
    let store: CalendarStore;
    let mappings: MappingStore;

    beforeEach(() => {
        mappings = new MappingStore({ load: async () => undefined, save: async () => ({ code: 0 }) }, 1000);
        store = new CalendarStore({ settings, mappings });
    });

    it("windowFor 至少覆盖视图跨度，并按设置扩展", () => {
        const anchor = Date.UTC(2025, 5, 18);
        const month = store.windowFor(anchor, "month");
        expect(month.start).toBeLessThan(anchor - 30 * DAY);
        expect(month.end).toBeGreaterThan(anchor + 30 * DAY);
        const day = store.windowFor(anchor, "day");
        expect(day.start).toBeLessThan(anchor);
        expect(day.end).toBeGreaterThan(anchor + 7 * DAY);
    });

    it("聚合多个数据源的事件并按开始时间排序", async () => {
        const now = Date.now();
        const a = new FakeAdapter(info("a"), [event("a1", "a", now + DAY), event("a2", "a", now + 3 * DAY)]);
        const b = new FakeAdapter(info("b"), [event("b1", "b", now + 2 * DAY)]);
        store.registerAdapter(a, a.info);
        store.registerAdapter(b, b.info);
        const events = await store.eventsIn(now - DAY, now + 10 * DAY);
        expect(events.map((item) => item.uid)).toEqual(["a1", "b1", "a2"]);
        expect(events.every((item) => item.readOnly === false)).toBe(true);
    });

    it("区间缓存命中时不重复请求适配器", async () => {
        const now = Date.now();
        const a = new FakeAdapter(info("a"), [event("a1", "a", now)]);
        store.registerAdapter(a, a.info);
        await store.eventsIn(now - DAY, now + 10 * DAY);
        await store.eventsIn(now - DAY, now + 9 * DAY);
        expect(a.calls).toBe(1);
        // 区间变大时需要重新拉取
        await store.eventsIn(now - 60 * DAY, now + 60 * DAY);
        expect(a.calls).toBe(2);
        // force 时总是重新拉取
        await store.eventsIn(now - DAY, now + 10 * DAY, { force: true });
        expect(a.calls).toBe(3);
    });

    it("隐藏的日历不参与聚合", async () => {
        const now = Date.now();
        const a = new FakeAdapter(info("a"), [event("a1", "a", now)]);
        store.registerAdapter(a, a.info);
        store.setVisible("a", false);
        expect(await store.eventsIn(now - DAY, now + DAY)).toEqual([]);
        expect(a.calls).toBe(0);
        store.setVisible("a", true);
        expect(await store.eventsIn(now - DAY, now + DAY)).toHaveLength(1);
    });

    it("启停变化会回调持久化，重启后可恢复（不再「复活」）", () => {
        const persisted: string[][] = [];
        const withPersist = new CalendarStore({
            settings,
            mappings,
            onVisibilityChange: (ids) => persisted.push([...ids]),
        });
        withPersist.setVisible("cal-a", false);
        withPersist.setVisible("cal-b", false);
        withPersist.setVisible("cal-a", true);
        expect(persisted).toEqual([["cal-a"], ["cal-a", "cal-b"], ["cal-b"]]);

        // 模拟重启：新 store 用保存下来的列表恢复
        const restored = new CalendarStore({ settings, mappings });
        restored.restoreHidden(persisted[persisted.length - 1]);
        expect(restored.isVisible("cal-a")).toBe(true);
        expect(restored.isVisible("cal-b")).toBe(false);
        expect(restored.hiddenIds()).toEqual(["cal-b"]);
    });

    it("restoreHidden 本身不触发持久化回调（避免回写循环）", () => {
        const persisted: string[][] = [];
        const withPersist = new CalendarStore({
            settings,
            mappings,
            onVisibilityChange: (ids) => persisted.push([...ids]),
        });
        withPersist.restoreHidden(["cal-a"]);
        expect(persisted).toEqual([]);
        expect(withPersist.isVisible("cal-a")).toBe(false);
    });

    it("账户被禁用时对应日历视为不可见", async () => {
        const now = Date.now();
        const a = new FakeAdapter(info("a"), [event("a1", "a", now)]);
        store.registerAdapter(a, a.info);
        const custom = new CalendarStore({
            settings: () => {
                const value = settings();
                value.accounts.push({
                    id: "acct_1",
                    name: "x",
                    serverUrl: "https://dav",
                    username: "u",
                    enabled: false,
                });
                return value;
            },
            mappings,
        });
        custom.registerAdapter(a, a.info);
        expect(custom.isVisible("a")).toBe(false);
        expect(await custom.eventsIn(now - DAY, now + DAY)).toEqual([]);
    });

    it("加载失败记录错误且不抛出", async () => {
        const now = Date.now();
        const failing = new FakeAdapter(info("bad"), []);
        failing.fail = true;
        store.registerAdapter(failing, failing.info);
        const result = await store.loadCalendar("bad", now - DAY, now + DAY);
        expect(result.error).toContain("网络错误");
        expect(store.errorOf("bad")).toContain("网络错误");
        await expect(store.eventsIn(now - DAY, now + DAY)).resolves.toEqual([]);
    });

    it("只读适配器的事件标记为 readOnly", async () => {
        const now = Date.now();
        const readonly = new FakeAdapter(info("ro"), [event("r1", "ro", now)], false);
        store.registerAdapter(readonly, readonly.info);
        const events = await store.eventsIn(now - DAY, now + DAY);
        expect(events[0].readOnly).toBe(true);
    });

    it("listCalendars 按数据源类型排序", () => {
        const caldav = new FakeAdapter(info("caldav", "Work"), []);
        const query = new FakeAdapter(
            { id: "query:1", name: "SQL", source: { kind: "query", stmt: "", dateAttr: "due" } },
            [],
        );
        store.registerAdapter(caldav, caldav.info);
        store.registerAdapter(query, query.info);
        expect(store.listCalendars().map((item) => item.id)).toEqual(["caldav", "query:1"]);
    });

    it("unregisterAdapter / clearAdapters / invalidate 清理缓存", async () => {
        const now = Date.now();
        const a = new FakeAdapter(info("a"), [event("a1", "a", now)]);
        store.registerAdapter(a, a.info);
        await store.eventsIn(now - DAY, now + DAY);
        expect(store.lastLoadedAt("a")).toBeTypeOf("number");
        store.invalidate("a");
        expect(store.lastLoadedAt("a")).toBeUndefined();
        await store.eventsIn(now - DAY, now + DAY);
        store.unregisterAdapter("a");
        expect(await store.eventsIn(now - DAY, now + DAY)).toEqual([]);
        store.registerAdapter(a, a.info);
        store.clearAdapters();
        expect(store.listCalendars()).toEqual([]);
    });

    it("未勾选（停用）的日历不发起任何请求，也不出现在可见列表", async () => {
        const now = Date.now();
        const a = new FakeAdapter(info("cal-a"), [event("a1", "cal-a", now)]);
        const b = new FakeAdapter(info("cal-b"), [event("b1", "cal-b", now)]);
        store.registerAdapter(a, a.info);
        store.registerAdapter(b, b.info);

        // 停用 cal-b
        store.setVisible("cal-b", false);
        expect(store.visibleCalendars().map((item) => item.id)).toEqual(["cal-a"]);

        await store.refreshAll(now - DAY, now + DAY);
        await store.eventsIn(now - DAY, now + DAY);
        expect(a.calls).toBeGreaterThan(0);
        // 关键：停用的日历一次请求都不应该发
        expect(b.calls).toBe(0);

        // 重新启用后才会被请求
        store.setVisible("cal-b", true);
        await store.eventsIn(now - DAY, now + DAY);
        expect(b.calls).toBeGreaterThan(0);
    });

    it("所有日历都被停用时，刷新不产生任何请求", async () => {
        const now = Date.now();
        const a = new FakeAdapter(info("cal-a"), [event("a1", "cal-a", now)]);
        store.registerAdapter(a, a.info);
        store.setVisible("cal-a", false);
        await store.refreshAll(now - DAY, now + DAY);
        expect(a.calls).toBe(0);
        expect(store.visibleCalendars()).toEqual([]);
    });

    it("invalidateLocal 只失效本地数据源，不触碰远端日历（避免刷新风暴）", async () => {
        const now = Date.now();
        const remote = new FakeAdapter(info("caldav"), [event("r1", "caldav", now)]);
        const localInfo: CalendarInfo = {
            id: "query:1",
            name: "SQL",
            source: { kind: "query", stmt: "", dateAttr: "due" },
        };
        const localAdapter = new FakeAdapter(localInfo, [event("l1", "query:1", now)]);
        store.registerAdapter(remote, remote.info);
        store.registerLocalAdapter(localAdapter, localInfo);

        await store.eventsIn(now - DAY, now + DAY);
        expect(remote.calls).toBe(1);
        expect(localAdapter.calls).toBe(1);

        // 模拟思源高频 transactions 事件：只应重新读取本地数据源
        store.invalidateLocal();
        await store.eventsIn(now - DAY, now + DAY);
        expect(remote.calls).toBe(1); // 远端仍走缓存
        expect(localAdapter.calls).toBe(2); // 本地重新读取

        // 再次触发也只影响本地数据源，远端不会因为连续事件被反复请求
        store.invalidateLocal();
        store.invalidateLocal();
        await store.eventsIn(now - DAY, now + DAY);
        expect(remote.calls).toBe(1);
        expect(localAdapter.calls).toBe(3);
    });

    it("invalidate() 仍然会清空全部缓存（手动刷新路径）", async () => {
        const now = Date.now();
        const remote = new FakeAdapter(info("caldav"), [event("r1", "caldav", now)]);
        store.registerAdapter(remote, remote.info);
        await store.eventsIn(now - DAY, now + DAY);
        expect(remote.calls).toBe(1);
        store.invalidate();
        await store.eventsIn(now - DAY, now + DAY);
        expect(remote.calls).toBe(2);
    });

    it("subscribe 通知监听者，并在外部写入后触发回调", async () => {
        const onEventsChanged = vi.fn();
        const custom = new CalendarStore({ settings, mappings, onEventsChanged });
        const listener = vi.fn();
        const unsubscribe = custom.subscribe(listener);
        const now = Date.now();
        const a = new FakeAdapter(info("a"), [event("a1", "a", now)]);
        custom.registerAdapter(a, a.info);
        await custom.eventsIn(now - DAY, now + DAY);
        expect(listener).toHaveBeenCalled();
        custom.notifyExternalChange();
        expect(onEventsChanged).toHaveBeenCalledTimes(1);
        unsubscribe();
        const before = listener.mock.calls.length;
        custom.setVisible("a", false);
        expect(listener.mock.calls.length).toBe(before);
    });

    it("refreshAll 并发受限且返回每个日历的结果", async () => {
        const now = Date.now();
        const adapters = ["a", "b", "c", "d"].map((id) => new FakeAdapter(info(id), [event(`${id}1`, id, now)]));
        for (const adapter of adapters) {
            store.registerAdapter(adapter, adapter.info);
        }
        const results = await store.refreshAll(now - DAY, now + DAY);
        expect(results).toHaveLength(4);
        expect(results.every((item) => item.events === 1)).toBe(true);
    });
});
