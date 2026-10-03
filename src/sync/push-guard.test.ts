import { beforeEach, describe, expect, it } from "vitest";
import { SyncEngine, type LocalLink, type LocalSyncStore } from "../sync/engine";
import { MappingStore } from "../state/mapping";
import { CalDavClient } from "../caldav/client";
import { CalDavSourceAdapter } from "../caldav/adapter";
import { buildIcs, parseIcs } from "../caldav/ics";
import type { CalendarEvent, CalDavAccount, CalendarInfo, LocalAttrNames } from "../types";
import { resetKernelMock, responder } from "../__mocks__/siyuan";

/**
 * Vikunja 型（VTODO-only）日历的推送行为回归。
 *
 * 背景：真实环境出现过 `推送事件失败（1122）：更新事件失败（HTTP 500）`，
 * 需要确认插件是否把「本地的日程」错误地推送进了「只支持任务的日历」。
 */

const TASK_URL = "http://scikunja.local:3456/dav/projects/3/";
const account: CalDavAccount = {
    id: "acct_v",
    name: "Vikunja",
    serverUrl: "http://scikunja.local:3456/dav/projects/",
    username: "alice",
    password: "token",
    enabled: true,
};

/** Vikunja 风格的 VTODO 文本 */
function taskIcs(uid: string, summary: string, due: string): string {
    return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Vikunja//CalDAV//EN",
        "BEGIN:VTODO",
        `UID:${uid}`,
        `SUMMARY:${summary}`,
        `DUE;TZID=TZ08:${due}`,
        "STATUS:NEEDS-ACTION",
        "END:VTODO",
        "END:VCALENDAR",
        "",
    ].join("\r\n");
}

function multiStatus(resources: Array<{ href: string; etag: string; ics?: string }>): string {
    const body = resources
        .map(
            (resource) => `
  <d:response>
    <d:href>${resource.href}</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>${resource.etag}</d:getetag>
        ${resource.ics ? `<c:calendar-data>${resource.ics.replace(/\r\n/g, "&#x0D;&#x0A;")}</c:calendar-data>` : ""}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`,
        )
        .join("");
    return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}
</d:multistatus>`;
}

function persist(event: CalendarEvent): CalendarEvent {
    return { ...event, alarms: undefined, attendees: undefined, organizer: undefined, categories: undefined };
}

class MemoryLocalStore implements LocalSyncStore {
    readonly docs = new Map<string, { link: LocalLink; event: CalendarEvent }>();
    /** 若设置，loadEvent 只返回该事件（模拟「本地事件属于另一个数据源」） */
    foreign?: CalendarEvent;
    private seq = 0;

    async refresh(): Promise<Map<string, LocalLink>> {
        const map = new Map<string, LocalLink>();
        for (const [uid, doc] of this.docs) {
            map.set(uid, { ...doc.link, uid, title: doc.event.title });
        }
        return map;
    }
    async create(event: CalendarEvent): Promise<LocalLink> {
        const link: LocalLink = { uid: event.uid, blockID: `doc-${++this.seq}`, rootID: `doc-${this.seq}`, title: event.title };
        this.docs.set(event.uid, { link, event: persist(event) });
        return link;
    }

    async update(link: LocalLink, event: CalendarEvent): Promise<void> {
        this.docs.set(link.uid, { link: { ...link }, event: persist(event) });
    }

    async unlink(link: LocalLink): Promise<void> {
        this.docs.delete(link.uid);
    }

    async loadEvent(blockID: string): Promise<CalendarEvent | undefined> {
        if (this.foreign) {
            return { ...this.foreign };
        }
        for (const doc of this.docs.values()) {
            if (doc.link.blockID === blockID) {
                return { ...doc.event };
            }
        }
        return undefined;
    }

    async deleteDocument(): Promise<void> {
        /* 测试中不需要 */
    }
}

interface RemoteState {
    resources: Array<{ href: string; etag: string; ics: string }>;
    writes: Array<{ method: string; url: string; ics: string }>;
    putResponses: Array<{ status: number; body?: string }>;
    /** 仅让下一次 PUT 失败（模拟「遗留映射指向已删除的远端资源」） */
    putStatusOnce?: number;
}

/** 远端 PUT 的状态码可切换：用于模拟「远端资源已被删除」 */
const putState: { status: number } = { status: 201 };

function harness(components: string[]): {
    engine: SyncEngine;
    local: MemoryLocalStore;
    mappings: MappingStore;
    remote: RemoteState;
    adapter: CalDavSourceAdapter;
} {
    const remote: RemoteState = { resources: [], writes: [], putResponses: [] };
    putState.status = 201;
    const client = new CalDavClient({
        account,
        credentials: { username: account.username, secret: account.password ?? "", authType: "basic" },
        timeoutMs: 5000,
    });
    const info: CalendarInfo = {
        id: `caldav:acct_v:${encodeURIComponent(TASK_URL)}`,
        name: "项目 3",
        source: { kind: "caldav", accountId: "acct_v", calendarUrl: TASK_URL, components },
    };
    const adapter = new CalDavSourceAdapter({
        accountId: "acct_v",
        calendar: { url: TASK_URL, displayName: "项目 3", readOnly: false, components },
        info,
        client: () => client,
        zone: "Asia/Shanghai",
    });

    responder.current = (endpoint, payload) => {
        if (endpoint !== "/api/network/forwardProxy") {
            return { code: 0, msg: "", data: null };
        }
        const request = payload as { method: string; url: string; payload?: string };
        if (request.method === "REPORT") {
            return {
                code: 0,
                msg: "",
                data: { status: 207, body: multiStatus(remote.resources), bodyEncoding: "text", headers: {} },
            };
        }
        if (request.method === "PUT") {
            const ics = decodeURIComponent(escape(atob(request.payload ?? "")));
            remote.writes.push({ method: "PUT", url: request.url, ics });
            // putStatusOnce 优先：仅让这一次 PUT 失败，用于验证「404 → 新建」自愈
            const status = remote.putStatusOnce ?? putState.status;
            remote.putStatusOnce = undefined;
            remote.putResponses.push({ status });
            if (status >= 400) {
                return {
                    code: 0,
                    msg: "",
                    data: { status, body: JSON.stringify({ message: "Internal Server Error" }), bodyEncoding: "text", headers: {} },
                };
            }
            const name = request.url.split("/").pop() ?? "x.ics";
            const existing = remote.resources.find((item) => item.href.endsWith(name));
            if (existing) {
                existing.ics = ics;
            } else {
                remote.resources.push({ href: `/dav/projects/3/${name}`, etag: `"etag-${remote.resources.length + 1}"`, ics });
            }
            return {
                code: 0,
                msg: "",
                data: { status, body: "", bodyEncoding: "text", headers: { ETag: [`"etag-${remote.resources.length}"`] } },
            };
        }
        return { code: 0, msg: "", data: { status: 200, body: "", bodyEncoding: "text", headers: {} } };
    };

    const mappings = new MappingStore({ load: async () => undefined, save: async () => ({ code: 0 }) }, 5);
    const local = new MemoryLocalStore();
    const engine = new SyncEngine({
        mappings,
        adapters: () => [adapter],
        local: () => local,
        conflictPolicy: () => "duplicate",
        deleteLocalWhenRemoteDeleted: () => false,
        pushLocalChanges: () => true,
        window: () => ({ start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 11, 1) }),
        zone: () => "Asia/Shanghai",
    });
    return { engine, local, mappings, remote, adapter };
}

/** 一条普通的思源本地日程（来自属性视图/SQL，不是远端任务） */
function localAppointment(uid: string, title: string): CalendarEvent {
    return {
        uid,
        calendar: "av:local-calendar",
        sourceKind: "av",
        title,
        start: Date.UTC(2026, 9, 5, 1),
        end: Date.UTC(2026, 9, 5, 2),
        allDay: false,
    };
}

beforeEach(() => {
    resetKernelMock();
});

describe("误推送判定：本地日程 → VTODO-only 日历", () => {
    it("本地新建的日程不会以 VEVENT 形式写进只支持任务的日历", async () => {
        const h = harness(["VTODO"]);
        // 模拟「本地事件被映射到任务日历」：mapping 指向远端 href，本地事件来自其它数据源
        await h.mappings.set({
            uid: "local-uid-1",
            calendarUrl: TASK_URL,
            href: `${TASK_URL}f5c3752a-6e86-4fc5-8a80-68e8dff49eb7.ics`,
            etag: "etag-1",
            local: { kind: "block", blockID: "doc-1" },
            localHash: "stale",
            syncedAt: Date.now(),
        });
        h.local.foreign = localAppointment("local-uid-1", "思源本地日程");

        const report = await h.engine.run("push");
        const put = h.remote.writes.find((item) => item.method === "PUT");
        // 期望：不推送。这是「预期内的跳过」，走 skipped 计数而不是 errors
        // （否则 SyncReport.errors 里会塞满噪音，界面会弹一堆「同步失败」）。
        expect(put, "不应把 VEVENT 推送到 VTODO-only 日历").toBeUndefined();
        expect(report.skipped).toBeGreaterThan(0);
        expect(report.errors).toEqual([]);
    });

    it("VTODO-only 日历里的任务可以正常写回（仍是 VTODO）", async () => {
        const h = harness(["VTODO"]);
        h.remote.resources.push({
            href: "/dav/projects/3/task-1.ics",
            etag: '"7-1"',
            ics: taskIcs("task-1", "写报告", "20261006T180000"),
        });
        await h.engine.run("pull");
        const link = h.local.docs.get("task-1")?.link;
        expect(link).toBeDefined();

        // 用户修改标题后推送
        const doc = h.local.docs.get("task-1");
        if (doc) {
            doc.event.title = "写报告（改）";
        }
        h.remote.writes.length = 0;
        const report = await h.engine.run("push");
        const put = h.remote.writes.find((item) => item.method === "PUT");
        expect(put).toBeDefined();
        expect(put?.ics).toContain("BEGIN:VTODO");
        expect(put?.ics).not.toContain("BEGIN:VEVENT");
        expect(put?.ics).toContain("DUE");
        expect(report.errors).toEqual([]);
    });

    it("拉取后原样推送不应产生任何 PUT（幂等，避免每次都打到服务端）", async () => {
        const h = harness(["VTODO"]);
        h.remote.resources.push({
            href: "/dav/projects/3/task-2.ics",
            etag: '"8-1"',
            ics: taskIcs("task-2", "原样任务", "20261007T090000"),
        });
        await h.engine.run("pull");
        h.remote.writes.length = 0;
        await h.engine.run("push");
        expect(h.remote.writes.filter((item) => item.method === "PUT")).toEqual([]);
    });
});

/** 构造一段 VEVENT 文本（与 engine.test.ts 的夹具同形） */
function buildIcsText(uid: string, summary: string, start: string, end: string): string {
    return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//test//EN",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `SUMMARY:${summary}`,
        `DTSTART:${start}`,
        `DTEND:${end}`,
        "DTSTAMP:20250101T000000Z",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
    ].join("\r\n");
}

describe("远端变化但本地条目缺失时应重建（否则删掉数据库行后再也拉不回来）", () => {
    // 注意：harness 的同步窗口是 2026-10 ~ 2026-12，样本事件必须落在窗口内
    const inWindow = (day: number): [string, string] => [
        `2026100${day}T020000Z`,
        `2026100${day}T030000Z`,
    ];

    it("远端内容变化 + 本地缺失 → 重新创建本地条目", async () => {
        const h = harness(["VEVENT"]);
        const [s1, e1] = inWindow(5);
        const [s2, e2] = inWindow(6);
        // 第一次同步：远端已有内容并落库
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "第一次", s1, e1),
        });
        await h.engine.run("pull");
        expect(h.local.docs.size).toBe(1);

        // 模拟「用户删除了思源里的条目」（数据库行/文档被删）
        h.local.docs.clear();

        // 远端同时发生了更新 → 应当重建本地条目，而不是永久跳过
        h.remote.resources[0] = {
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e2"',
            ics: buildIcsText("uid-1", "第二次", s2, e2),
        };
        const report = await h.engine.run("pull");
        expect(h.local.docs.size).toBe(1);
        expect(report.created).toBe(1);
        expect(report.errors).toEqual([]);
    });

    it("远端内容未变 + 本地缺失 → 不重建（视为用户主动删除）", async () => {
        const h = harness(["VEVENT"]);
        const [s1, e1] = inWindow(5);
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "第一次", s1, e1),
        });
        await h.engine.run("pull");
        h.local.docs.clear();

        const report = await h.engine.run("pull");
        expect(h.local.docs.size).toBe(0);
        expect(report.created).toBe(0);
        expect(report.skipped).toBeGreaterThan(0);
    });
});

describe("远端资源已不存在（404）时把更新自愈为新建", () => {
    beforeEach(() => {
        putState.status = 201;
    });

    it("首次 PUT 404 后改为新建，成功则更新 href 且不报错", async () => {
        const h = harness(["VEVENT"]);
        // 造一条「历史遗留映射」：href 指向远端并不存在的资源
        await h.mappings.set({
            uid: "stale-uid",
            calendarUrl: TASK_URL,
            href: `${TASK_URL}stale-uid.ics`,
            etag: "old-etag",
            local: { kind: "block", blockID: "doc-1" },
            localHash: "old-hash",
            syncedAt: Date.now(),
        });
        h.local.foreign = localAppointment("stale-uid", "遗留条目");
        // 第一次 PUT（更新）报 404；自愈后的 PUT（新建）成功
        h.remote.putStatusOnce = 404;

        const report = await h.engine.run("push");
        expect(report.errors).toEqual([]);
        expect(report.created).toBe(1);
        // href 应已更新为服务端确认的新地址
        expect(h.mappings.get(TASK_URL, "stale-uid")?.href).toBeTypeOf("string");
    });

    it("PUT 返回 200 时仍按「更新」处理（不走新建分支）", async () => {
        const h = harness(["VEVENT"]);
        await h.mappings.set({
            uid: "ok-uid",
            calendarUrl: TASK_URL,
            href: `${TASK_URL}ok-uid.ics`,
            etag: "e1",
            local: { kind: "block", blockID: "doc-2" },
            localHash: "old",
            syncedAt: Date.now(),
        });
        h.local.foreign = localAppointment("ok-uid", "正常条目");
        const report = await h.engine.run("push");
        expect(report.errors).toEqual([]);
        expect(report.updated).toBe(1);
    });
});

describe("误推送判定：VEVENT 日历不受影响", () => {
    it("本地日程照常可以推送到支持 VEVENT 的日历", async () => {
        const h = harness(["VEVENT"]);
        await h.mappings.set({
            uid: "local-uid-2",
            calendarUrl: TASK_URL,
            local: { kind: "block", blockID: "doc-2" },
            localHash: "stale",
            syncedAt: Date.now(),
        });
        h.local.foreign = localAppointment("local-uid-2", "思源本地日程");
        const report = await h.engine.run("push");
        const put = h.remote.writes.find((item) => item.method === "PUT");
        expect(put).toBeDefined();
        expect(put?.ics).toContain("BEGIN:VEVENT");
        expect(report.errors).toEqual([]);
    });

    it("构建出的 VEVENT 正文符合 RFC（含 UID/DTSTART/DTSTAMP）", () => {
        const ics = buildIcs(localAppointment("u1", "会议"), { includeTimezone: true });
        expect(ics).toContain("BEGIN:VEVENT");
        expect(ics).toMatch(/UID:u1/);
        expect(ics).toMatch(/DTSTART/);
        expect(ics).toMatch(/DTSTAMP/);
        expect(parseIcs(ics, { calendarId: "c", sourceKind: "caldav" })).toHaveLength(1);
    });
});

describe("误推送判定：归属校验", () => {
    it("记录的是本日历地址 → 归属本日历", () => {
        const h = harness(["VEVENT"]);
        expect(h.adapter.belongsTo({ calendar: TASK_URL } as CalendarEvent)).toBe(true);
        expect(h.adapter.belongsTo({ calendar: TASK_URL.replace(/\/$/, "") } as CalendarEvent)).toBe(true);
    });

    it("记录的是别的日历地址 → 不归属，绝不能被推送到本日历", () => {
        const h = harness(["VEVENT"]);
        expect(h.adapter.belongsTo({ calendar: "http://scikunja.local:3456/dav/projects/1/" } as CalendarEvent)).toBe(
            false,
        );
    });

    it("未记录归属时，只有唯一可写日历才认领（避免复制到多个日历）", () => {
        const h = harness(["VEVENT"]);
        const event = { calendar: "" } as CalendarEvent;
        expect(h.adapter.belongsTo(event, { allowUnassigned: true })).toBe(true);
        expect(h.adapter.belongsTo(event, { allowUnassigned: false })).toBe(false);
        expect(h.adapter.belongsTo(event)).toBe(false);
    });

    it("多个可写日历时，未记录归属的文档不会被任何日历认领（不产生重复条目）", async () => {
        const h = harness(["VEVENT"]);
        // 造第二个可写日历（同 URL 之外的地址）
        const otherInfo: CalendarInfo = {
            id: "caldav:acct_v:other",
            name: "项目 1",
            source: { kind: "caldav", accountId: "acct_v", calendarUrl: "http://scikunja.local:3456/dav/projects/1/" },
        };
        const other = new CalDavSourceAdapter({
            accountId: "acct_v",
            calendar: {
                url: "http://scikunja.local:3456/dav/projects/1/",
                displayName: "项目 1",
                readOnly: false,
                components: ["VEVENT"],
            },
            info: otherInfo,
            client: () => undefined as never,
            zone: "Asia/Shanghai",
        });
        const adapters = [h.adapter, other];
        expect(adapters.filter((item) => item.isWritable())).toHaveLength(2);
        const unassigned = { calendar: "" } as CalendarEvent;
        for (const adapter of adapters) {
            expect(adapter.belongsTo(unassigned, { allowUnassigned: adapters.filter((i) => i.isWritable()).length <= 1 })).toBe(
                false,
            );
        }
    });
});

/** 供 LocalAttrNames 引用，避免未使用导入 */
void ({} as LocalAttrNames);
