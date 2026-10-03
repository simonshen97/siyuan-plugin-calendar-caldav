import { beforeEach, describe, expect, it } from "vitest";
import { SyncEngine, type LocalLink, type LocalSyncStore } from "./engine";
import { MappingStore } from "../state/mapping";
import { CalDavClient } from "../caldav/client";
import { CalDavSourceAdapter } from "../caldav/adapter";
import { parseIcs } from "../caldav/ics";
import { projectionHash } from "../siyuan/localStore";
import type { CalendarEvent, CalDavAccount, CalendarInfo } from "../types";
import { calls, resetKernelMock, responder } from "../__mocks__/siyuan";

const CAL_URL = "https://dav.example.com/dav/calendars/alice/work/";
const account: CalDavAccount = {
    id: "acct_1",
    name: "Work",
    serverUrl: "https://dav.example.com",
    username: "alice",
    password: "secret",
    enabled: true,
};

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
        `DTSTAMP:20250101T000000Z`,
        "END:VEVENT",
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
        ${resource.ics ? `<c:calendar-data>${resource.ics}</c:calendar-data>` : ""}
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

/**
 * 内存版思源侧存储。
 * 语义对齐 LocalDocumentAdapter：只持久化 CalendarEvent 的字段子集
 * （uid/title/description/location/start/end/allDay/tzid + extra JSON 中的
 * rrule/categories/status/transparency/class/url/alarms/attendees/organizer 等），
 * 其余运行时字段（calendarName/color/readOnly）在落库时丢弃。
 */
function persist(event: CalendarEvent): CalendarEvent {
    return {
        uid: event.uid,
        calendar: event.calendar,
        sourceKind: event.sourceKind,
        title: event.title,
        description: event.description,
        location: event.location,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        tzid: event.tzid,
        rrule: event.rrule,
        categories: event.categories ? [...event.categories] : undefined,
        status: event.status,
        transparency: event.transparency,
        cls: event.cls,
        url: event.url,
        lastModified: event.lastModified,
        created: event.created,
        hasEndDate: event.hasEndDate,
        recurrenceId: event.recurrenceId,
        alarms: event.alarms ? event.alarms.map((item) => ({ ...item })) : undefined,
        attendees: event.attendees ? event.attendees.map((item) => ({ ...item })) : undefined,
        organizer: event.organizer ? { ...event.organizer } : undefined,
        isRecurringInstance: event.isRecurringInstance,
        isInstanceMirror: event.isInstanceMirror,
    };
}

class MemoryLocalStore implements LocalSyncStore {
    readonly docs = new Map<string, { link: LocalLink; event: CalendarEvent }>();
    deleted: string[] = [];
    /** 模拟属性读取失败（测试「API 抖动不得删远端」） */
    failLoad = false;
    private seq = 0;

    async refresh(): Promise<Map<string, LocalLink>> {
        const map = new Map<string, LocalLink>();
        for (const [uid, doc] of this.docs) {
            map.set(uid, { ...doc.link, title: doc.event.title });
        }
        return map;
    }

    async create(event: CalendarEvent): Promise<LocalLink> {
        const link: LocalLink = {
            uid: event.uid,
            blockID: `doc-${++this.seq}`,
            rootID: `doc-${this.seq}`,
            title: event.title,
        };
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
        if (this.failLoad) {
            throw new Error("kernel busy");
        }
        for (const doc of this.docs.values()) {
            if (doc.link.blockID === blockID) {
                return { ...doc.event };
            }
        }
        return undefined;
    }

    async deleteDocument(blockID: string): Promise<void> {
        this.deleted.push(blockID);
        for (const [uid, doc] of [...this.docs]) {
            if (doc.link.blockID === blockID) {
                this.docs.delete(uid);
            }
        }
    }
}

interface RemoteState {
    resources: Array<{ href: string; etag: string; ics: string }>;
    /** 记录收到的写请求：PUT/REPORT 等 */
    writes: Array<{ method: string; url: string; ics: string; ifMatch?: string; ifNoneMatch?: string }>;
    puts: number;
    deletes: number;
}

interface Harness {
    engine: SyncEngine;
    local: MemoryLocalStore;
    mappings: MappingStore;
    remote: RemoteState;
    adapter: CalDavSourceAdapter;
}

function harness(options: {
    conflictPolicy?: "remote" | "local" | "duplicate" | "skip";
    deleteLocalWhenRemoteDeleted?: boolean;
    pushLocalChanges?: boolean;
    direction?: "both" | "pull" | "push";
    start?: number;
    end?: number;
} = {}): Harness {
    const remote: RemoteState = { resources: [], writes: [], puts: 0, deletes: 0 };
    const client = new CalDavClient({
        account,
        credentials: { username: "alice", secret: "secret", authType: "basic" },
        timeoutMs: 5000,
    });
    const info: CalendarInfo = {
        id: `caldav:acct_1:${encodeURIComponent(CAL_URL)}`,
        name: "Work",
        source: {
            kind: "caldav",
            accountId: "acct_1",
            calendarUrl: CAL_URL,
            components: ["VEVENT"],
        },
    };
    const adapter = new CalDavSourceAdapter({
        accountId: "acct_1",
        calendar: { url: CAL_URL, displayName: "Work", readOnly: false, components: ["VEVENT"] },
        info,
        client: () => client,
        zone: "UTC",
    });

    responder.current = (endpoint, payload) => {
        if (endpoint !== "/api/network/forwardProxy") {
            return { code: 0, msg: "", data: null };
        }
        const request = payload as { method: string; url: string; payload?: string; headers: Array<Record<string, string>> };
        const headerOf = (name: string): string | undefined => {
            for (const item of request.headers) {
                if (name in item) {
                    return item[name];
                }
            }
            return undefined;
        };
        if (request.method === "REPORT") {
            return {
                code: 0,
                msg: "",
                data: {
                    status: 207,
                    body: multiStatus(remote.resources),
                    bodyEncoding: "text",
                    headers: {},
                },
            };
        }
        if (request.method === "PUT") {
            const ics = decodeURIComponent(escape(atob(request.payload ?? "")));
            remote.puts++;
            remote.writes.push({
                method: "PUT",
                url: request.url,
                ics,
                ifMatch: headerOf("If-Match"),
                ifNoneMatch: headerOf("If-None-Match"),
            });
            const existing = remote.resources.find((item) => item.href.endsWith(request.url.split("/").pop() ?? ""));
            if (existing) {
                existing.ics = ics;
                existing.etag = `"etag-${remote.puts + 10}"`;
            } else {
                remote.resources.push({
                    href: `/dav/calendars/alice/work/${request.url.split("/").pop()}`,
                    etag: `"etag-${remote.puts + 10}"`,
                    ics,
                });
            }
            return { code: 0, msg: "", data: { status: 201, body: "", bodyEncoding: "text", headers: { ETag: [`"etag-${remote.puts + 10}"`] } } };
        }
        if (request.method === "DELETE") {
            remote.deletes++;
            remote.writes.push({ method: "DELETE", url: request.url, ics: "", ifMatch: headerOf("If-Match") });
            remote.resources = remote.resources.filter((item) => !request.url.endsWith(item.href.split("/").pop() ?? ""));
            return { code: 0, msg: "", data: { status: 204, body: "", bodyEncoding: "text", headers: {} } };
        }
        return { code: 0, msg: "", data: { status: 200, body: "", bodyEncoding: "text", headers: {} } };
    };

    const mappings = new MappingStore({ load: async () => undefined, save: async () => ({ code: 0 }) }, 5);
    const local = new MemoryLocalStore();
    const start = options.start ?? Date.UTC(2025, 0, 1);
    const end = options.end ?? Date.UTC(2025, 1, 1);
    const engine = new SyncEngine({
        mappings,
        adapters: () => [adapter],
        local: () => local,
        conflictPolicy: () => options.conflictPolicy ?? "duplicate",
        deleteLocalWhenRemoteDeleted: () => options.deleteLocalWhenRemoteDeleted ?? false,
        pushLocalChanges: () => options.pushLocalChanges ?? false,
        window: () => ({ start, end }),
        zone: () => "UTC",
    });
    return { engine, local, mappings, remote, adapter };
}

beforeEach(() => {
    resetKernelMock();
});

describe("同步引擎端到端", () => {
    it("首次同步把远端事件落库，并记录 ETag 与哈希", async () => {
        const h = harness();
        const ics = buildIcsText("uid-1", "周会", "20250103T020000Z", "20250103T030000Z");
        h.remote.resources.push({ href: "/dav/calendars/alice/work/uid-1.ics", etag: '"e1"', ics });

        const report = await h.engine.run("pull");
        expect(report.errors).toEqual([]);
        expect(report.created).toBe(1);
        expect(h.local.docs.size).toBe(1);
        const doc = h.local.docs.get("uid-1");
        expect(doc?.event.title).toBe("周会");
        expect(doc?.event.start).toBe(Date.UTC(2025, 0, 3, 2));

        const mapping = h.mappings.get(CAL_URL, "uid-1");
        expect(mapping?.etag).toBe("e1");
        // href 必须是绝对 URL，否则后续 PUT/DELETE 无法直接使用
        expect(mapping?.href).toBe("https://dav.example.com/dav/calendars/alice/work/uid-1.ics");
        expect(mapping?.remoteHash).toBeTypeOf("string");
        // localHash 记录的是「可持久化投影」的哈希，而不是完整事件哈希
        expect(mapping?.localHash).toBe(projectionHash(doc!.event));
        expect(mapping?.start).toBe(Date.UTC(2025, 0, 3, 2));
    });

    it("远端内容变化时更新本地条目", async () => {
        const h = harness();
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "周会", "20250103T020000Z", "20250103T030000Z"),
        });
        await h.engine.run("pull");
        // 远端改名 + 改时间
        h.remote.resources[0] = {
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e2"',
            ics: buildIcsText("uid-1", "周会（改）", "20250103T040000Z", "20250103T050000Z"),
        };
        const report = await h.engine.run("pull");
        expect(report.updated).toBe(1);
        const doc = h.local.docs.get("uid-1");
        expect(doc?.event.title).toBe("周会（改）");
        expect(doc?.event.start).toBe(Date.UTC(2025, 0, 3, 4));
        expect(h.mappings.get(CAL_URL, "uid-1")?.etag).toBe("e2");
    });

    it("远端无变化时不重复写入（幂等）", async () => {
        const h = harness();
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "周会", "20250103T020000Z", "20250103T030000Z"),
        });
        await h.engine.run("pull");
        const second = await h.engine.run("pull");
        expect(second.created).toBe(0);
        expect(second.updated).toBe(0);
        expect(second.pulled).toBe(0);
        expect(h.local.docs.size).toBe(1);
    });

    it("本地修改被推送到远端（带 If-Match）", async () => {
        const h = harness();
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "周会", "20250103T020000Z", "20250103T030000Z"),
        });
        await h.engine.run("pull");
        const doc = h.local.docs.get("uid-1")!;
        doc.event.title = "周会（本地改）";
        const report = await h.engine.run("push");
        expect(report.updated).toBe(1);
        expect(h.remote.puts).toBe(1);
        const write = h.remote.writes[0];
        expect(write.ifMatch).toBe('"e1"');
        expect(write.ics).toContain("SUMMARY:周会（本地改）");
        // 推送后哈希对齐，再次同步不会重复推送
        const again = await h.engine.run("push");
        expect(again.updated).toBe(0);
        expect(h.remote.puts).toBe(1);
    });

    it("双端都修改且策略为 remote 时以远端为准", async () => {
        const h = harness({ conflictPolicy: "remote" });
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "周会", "20250103T020000Z", "20250103T030000Z"),
        });
        await h.engine.run("pull");
        h.local.docs.get("uid-1")!.event.title = "本地改";
        h.remote.resources[0] = {
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e2"',
            ics: buildIcsText("uid-1", "远端改", "20250103T020000Z", "20250103T030000Z"),
        };
        const report = await h.engine.run("both");
        expect(report.conflicts).toBe(1);
        expect(h.local.docs.get("uid-1")?.event.title).toBe("远端改");
        expect(h.remote.puts).toBe(0);
    });

    it("双端都修改且策略为 local 时覆盖远端", async () => {
        const h = harness({ conflictPolicy: "local" });
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "周会", "20250103T020000Z", "20250103T030000Z"),
        });
        await h.engine.run("pull");
        h.local.docs.get("uid-1")!.event.title = "本地改";
        h.remote.resources[0] = {
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e2"',
            ics: buildIcsText("uid-1", "远端改", "20250103T020000Z", "20250103T030000Z"),
        };
        const report = await h.engine.run("both");
        expect(report.conflicts).toBe(1);
        expect(h.remote.puts).toBe(1);
        expect(h.remote.writes[0].ics).toContain("SUMMARY:本地改");
        expect(h.local.docs.get("uid-1")?.event.title).toBe("本地改");
    });

    it("双端都修改且策略为 duplicate 时保留本地副本并接受远端", async () => {
        const h = harness({ conflictPolicy: "duplicate" });
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "周会", "20250103T020000Z", "20250103T030000Z"),
        });
        await h.engine.run("pull");
        h.local.docs.get("uid-1")!.event.title = "本地改";
        h.remote.resources[0] = {
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e2"',
            ics: buildIcsText("uid-1", "远端改", "20250103T020000Z", "20250103T030000Z"),
        };
        const report = await h.engine.run("both");
        expect(report.conflicts).toBe(1);
        expect(h.local.docs.get("uid-1")?.event.title).toBe("远端改");
        const copies = [...h.local.docs.keys()].filter((uid) => uid.includes(".copy-"));
        expect(copies).toHaveLength(1);
        expect(h.local.docs.get(copies[0])?.event.isInstanceMirror).toBe(true);
        // 副本不会被反向推送为新事件
        const pushReport = await h.engine.run("push");
        expect(pushReport.created).toBe(0);
    });

    it("远端删除事件时解除本地关联（默认不删文档）", async () => {
        const h = harness();
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "周会", "20250103T020000Z", "20250103T030000Z"),
        });
        await h.engine.run("pull");
        h.remote.resources = [];
        const report = await h.engine.run("pull");
        expect(report.deleted).toBe(1);
        expect(h.mappings.get(CAL_URL, "uid-1")).toBeUndefined();
        expect(h.local.deleted).toEqual([]);
    });

    it("本地文档被删除时删除远端事件", async () => {
        const h = harness();
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "周会", "20250103T020000Z", "20250103T030000Z"),
        });
        await h.engine.run("pull");
        const link = h.local.docs.get("uid-1")!.link;
        await h.local.deleteDocument(link.blockID);
        const report = await h.engine.run("push");
        expect(report.deleted).toBe(1);
        expect(h.remote.deletes).toBe(1);
        expect(h.mappings.get(CAL_URL, "uid-1")).toBeUndefined();
    });

    it("开启 pushLocalChanges 时把无映射的本地条目创建为远端事件", async () => {
        const h = harness({ pushLocalChanges: true });
        await h.local.create({
            uid: "local-1@siyuan",
            // 文档上记录的是日历地址（与生产环境一致）
            calendar: CAL_URL,
            sourceKind: "caldav",
            title: "本地新建",
            start: Date.UTC(2025, 0, 6, 1),
            end: Date.UTC(2025, 0, 6, 2),
            allDay: false,
        });
        const report = await h.engine.run("push");
        expect(report.created).toBe(1);
        expect(h.remote.puts).toBe(1);
        expect(h.remote.writes[0].ifNoneMatch).toBe("*");
        const mapping = h.mappings.get(CAL_URL, "local-1@siyuan");
        expect(mapping?.href).toBeTypeOf("string");
        // 再次同步不重复创建
        const again = await h.engine.run("push");
        expect(again.created).toBe(0);
        expect(h.remote.puts).toBe(1);
    });

    it("direction=off 时不产生任何请求", async () => {
        const h = harness();
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "周会", "20250103T020000Z", "20250103T030000Z"),
        });
        const report = await h.engine.run("off");
        expect(report.pulled).toBe(0);
        expect(calls).toHaveLength(0);
        expect(h.local.docs.size).toBe(0);
    });

    it("生成的 ICS 可被重新解析（往返一致）", async () => {
        const h = harness();
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "周会", "20250103T020000Z", "20250103T030000Z"),
        });
        await h.engine.run("pull");
        h.local.docs.get("uid-1")!.event.title = "导出检查";
        await h.engine.run("push");
        const written = h.remote.writes[0].ics;
        const parsed = parseIcs(written, { calendarId: "x", sourceKind: "caldav" });
        expect(parsed).toHaveLength(1);
        expect(parsed[0].uid).toBe("uid-1");
        expect(parsed[0].title).toBe("导出检查");
        expect(parsed[0].start).toBe(Date.UTC(2025, 0, 3, 2));
        expect(parsed[0].end).toBe(Date.UTC(2025, 0, 3, 3));
    });

    /* —— 回归用例：针对对抗式代码复核发现的问题 —— */

    it("窗口之外的历史映射不会被误判为「远端已删除」", async () => {
        // 第一次同步窗口覆盖 2024-06（事件时间）
        const firstWindow = { start: Date.UTC(2024, 5, 1), end: Date.UTC(2024, 6, 1) };
        const h = harness({ ...firstWindow });
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/old.ics",
            etag: '"e-old"',
            ics: buildIcsText("uid-old", "历史事件", "20240615T020000Z", "20240615T030000Z"),
        });
        const first = await h.engine.run("pull");
        expect(first.created).toBe(1);
        const mapping = h.mappings.get(CAL_URL, "uid-old");
        expect(mapping?.start).toBe(Date.UTC(2024, 5, 15, 2));

        // 第二轮用「不覆盖该事件」的窗口（模拟时间推移），远端查询也返回空
        const laterEngine = new SyncEngine({
            mappings: h.mappings,
            adapters: () => [h.adapter],
            local: () => h.local,
            conflictPolicy: () => "duplicate",
            deleteLocalWhenRemoteDeleted: () => true,
            pushLocalChanges: () => false,
            window: () => ({ start: Date.UTC(2025, 2, 1), end: Date.UTC(2025, 3, 1) }),
            zone: () => "UTC",
        });
        h.remote.resources = [];
        const report = await laterEngine.run("pull");
        expect(report.deleted).toBe(0);
        expect(h.mappings.get(CAL_URL, "uid-old")).toBeDefined();
        expect(h.local.deleted).toEqual([]);
        expect(h.local.docs.size).toBe(1);
    });

    it("属性读取失败时不会删除远端事件（API 抖动保护）", async () => {
        const h = harness();
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "周会", "20250103T020000Z", "20250103T030000Z"),
        });
        await h.engine.run("pull");
        h.local.failLoad = true;
        const report = await h.engine.run("push");
        expect(h.remote.deletes).toBe(0);
        expect(h.mappings.get(CAL_URL, "uid-1")).toBeDefined();
        expect(report.errors.some((item) => item.message.includes("读取思源条目属性失败"))).toBe(true);
    });

    it("远端事件携带 attendees/status 时不会被本地投影误判为「本地已修改」", async () => {
        const h = harness();
        const richIcs = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//test//EN",
            "BEGIN:VEVENT",
            "UID:uid-rich",
            "SUMMARY:评审",
            "STATUS:CONFIRMED",
            "CLASS:PUBLIC",
            "TRANSP:OPAQUE",
            "CATEGORIES:工作",
            "LOCATION:会议室 A",
            "ATTENDEE;CN=Alice;PARTSTAT=ACCEPTED:mailto:alice@example.com",
            "ORGANIZER;CN=Bob:mailto:bob@example.com",
            "DTSTART:20250103T020000Z",
            "DTEND:20250103T030000Z",
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            "TRIGGER:-PT15M",
            "DESCRIPTION:提醒",
            "END:VALARM",
            "DTSTAMP:20250101T000000Z",
            "END:VEVENT",
            "END:VCALENDAR",
            "",
        ].join("\r\n");
        h.remote.resources.push({ href: "/dav/calendars/alice/work/uid-rich.ics", etag: '"e1"', ics: richIcs });
        await h.engine.run("pull");
        const putsAfterPull = h.remote.puts;

        // 第二轮双向同步：本地未被用户修改，不应产生任何写入
        const second = await h.engine.run("both");
        expect(second.pushed).toBe(0);
        expect(h.remote.puts).toBe(putsAfterPull);
        // 且本地条目仍保留 attendees / status / alarms
        const doc = h.local.docs.get("uid-rich")!.event;
        expect(doc.attendees?.[0].mailto).toBe("alice@example.com");
        expect(doc.status).toBe("CONFIRMED");
        expect(doc.alarms?.[0].trigger).toBe(-15 * 60_000);
    });

    it("用户只改标题时，推送不会丢失远端侧的 attendees/alarms 等字段", async () => {
        const h = harness();
        const richIcs = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "BEGIN:VEVENT",
            "UID:uid-rich",
            "SUMMARY:评审",
            "STATUS:CONFIRMED",
            "ATTENDEE;CN=Alice:mailto:alice@example.com",
            "DTSTART:20250103T020000Z",
            "DTEND:20250103T030000Z",
            "DTSTAMP:20250101T000000Z",
            "END:VEVENT",
            "END:VCALENDAR",
            "",
        ].join("\r\n");
        h.remote.resources.push({ href: "/dav/calendars/alice/work/uid-rich.ics", etag: '"e1"', ics: richIcs });
        await h.engine.run("pull");
        // 用户编辑标题
        h.local.docs.get("uid-rich")!.event.title = "评审（改名）";
        await h.engine.run("push");
        const written = h.remote.writes[h.remote.writes.length - 1].ics;
        expect(written).toContain("SUMMARY:评审（改名）");
        // 未持久化字段没有丢
        expect(written).toContain("ATTENDEE;CN=Alice:mailto:alice@example.com");
        expect(written).toContain("STATUS:CONFIRMED");
    });

    it("删除的资源按 href 匹配（增量响应中没有 UID 也能解除映射）", async () => {
        const h = harness();
        h.remote.resources.push({
            href: "/dav/calendars/alice/work/uid-1.ics",
            etag: '"e1"',
            ics: buildIcsText("uid-1", "周会", "20250103T020000Z", "20250103T030000Z"),
        });
        await h.engine.run("pull");
        // 模拟 sync-collection 返回的 404：只有 href，没有 calendar-data
        h.remote.resources = [{ href: "/dav/calendars/alice/work/uid-1.ics", etag: '"gone"', ics: "" }];
        const report = await h.engine.run("pull");
        expect(report.deleted).toBe(1);
        expect(h.mappings.get(CAL_URL, "uid-1")).toBeUndefined();
    });
});
