import type { CalendarEvent, EventMapping, SyncReport, TSyncDirection } from "../types";
import type { MappingStore } from "../state/mapping";
import type { CalDavSourceAdapter } from "../caldav/adapter";
import { buildIcs, isTodoEvent } from "../caldav/ics";
import { projectionHash } from "../siyuan/localStore";

/** 远端资源已不存在（404/410）——用于把「更新」自愈为「新建」 */
function isRemoteMissing(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /\b(404|410)\b/.test(message);
}

/** 思源侧条目引用 */
export interface LocalLink {
    uid: string;
    blockID: string;
    rootID: string;
    /** 上一轮同步时记录的标题（用于判断是否需要重写正文） */
    title?: string;
}

/** 思源侧存储（同步写入目标） */
export interface LocalSyncStore {
    /** 列出所有由本插件管理的条目，key = UID */
    refresh(): Promise<Map<string, LocalLink>>;
    create(event: CalendarEvent, meta: { etag?: string; href?: string; calendarUrl: string }): Promise<LocalLink>;
    /**
     * 更新已有条目。
     * `previousTitle` 是上一轮同步时记录的标题，实现方据此判断正文是否需要重写
     * （不能用索引里的旧值，否则远端改标题永远同步不到文档正文）。
     */
    update(
        link: LocalLink,
        event: CalendarEvent,
        meta: { etag?: string; href?: string; calendarUrl: string; previousTitle?: string },
    ): Promise<void>;
    unlink(link: LocalLink): Promise<void>;
    /** 读取条目的当前内容（用于冲突检测与推送） */
    loadEvent(blockID: string): Promise<CalendarEvent | undefined>;
    /** 可选：物理删除文档（默认仅解除关联） */
    deleteDocument?(blockID: string): Promise<void>;
}

export interface SyncEngineOptions {
    mappings: MappingStore;
    /** 本次要同步的日历（通常只包含一个账户的日历） */
    adapters: () => CalDavSourceAdapter[];
    /** 每个日历对应的思源侧存储；返回 undefined 表示该日历仅做只读拉取（不落库） */
    local: (adapter: CalDavSourceAdapter) => LocalSyncStore | undefined;
    conflictPolicy: () => "remote" | "local" | "duplicate" | "skip";
    deleteLocalWhenRemoteDeleted: () => boolean;
    pushLocalChanges: () => boolean;
    /**
     * 为 true 时不推送「没有映射的新增条目」。
     *
     * 数据库同步模式下由界面置为 true：数据库行是各来源的汇总视图，
     * 把每一行都当成新事件推回远端会产生大量无意义的 PUT。
     */
    skipUnmappedPush?: () => boolean;
    window: () => { start: number; end: number };
    zone: () => string;
    log?: (message: string, ...rest: unknown[]) => void;
    onProgress?: (report: SyncReport) => void;
}

/**
 * 双向同步引擎。
 *
 * 判定依据（唯一事实来源）：
 * - `mapping.etag` / `mapping.remoteHash`：远端上次同步时的状态；
 * - `mapping.localHash`：思源侧上次同步时的状态；
 * - 两侧都变 → 冲突，按策略处理。
 *
 * 注意：为兼容服务器差异，远端「删除」只在全量查询（calendar-query）结果中判定，
 * 增量同步（sync-collection）返回 404 状态码的资源同样按删除处理。
 */
export class SyncEngine {
    constructor(private readonly options: SyncEngineOptions) {}

    async run(direction: TSyncDirection): Promise<SyncReport> {
        const report: SyncReport = {
            startedAt: Date.now(),
            finishedAt: 0,
            pulled: 0,
            pushed: 0,
            created: 0,
            updated: 0,
            deleted: 0,
            skipped: 0,
            conflicts: 0,
            errors: [],
        };
        if (direction === "off") {
            report.finishedAt = Date.now();
            return report;
        }
        for (const adapter of this.options.adapters()) {
            try {
                if (direction === "pull" || direction === "both") {
                    await this.pull(adapter, report);
                }
                if (direction === "push" || direction === "both") {
                    await this.push(adapter, report);
                }
            } catch (error) {
                report.errors.push({ calendarId: adapter.info.id, message: errorMessage(error) });
            }
            this.options.onProgress?.({ ...report });
        }
        await this.options.mappings.flush();
        report.finishedAt = Date.now();
        this.options.mappings.setLastReport(report);
        await this.options.mappings.flush();
        return report;
    }

    /* —— 拉取：远端 → 思源 —— */

    private async pull(adapter: CalDavSourceAdapter, report: SyncReport): Promise<void> {
        const local = this.options.local(adapter);
        const calendarUrl = adapter.remote.url;
        const { start, end } = this.options.window();
        // 同步必须走全量查询：只有全量结果才能可靠判断「远端已删除」。
        // 增量结果只包含变化项，会把未变化的事件误判成删除。
        const { events, objects } = await adapter.loadResource(start, end, { forceFull: true });

        if (!local) {
            // 只读模式：仅统计，不落库
            report.pulled += events.length;
            return;
        }

        const localIndex = await local.refresh();
        const knownUids = new Set(
            this.options.mappings
                .all()
                .filter((item) => item.calendarUrl === calendarUrl)
                .map((item) => item.uid),
        );
        const seenUids = new Set<string>();

        for (const resource of objects.resources) {
            if (!resource.ics) {
                continue;
            }
            const instances = events.filter(
                (event) =>
                    (resource.uid ? event.uid === resource.uid : true) &&
                    event.start < end &&
                    event.end > start &&
                    (!event.isRecurringInstance || event.start >= start),
            );
            if (!instances.length) {
                continue;
            }
            const remoteHash = resource.hash;
            for (const event of instances) {
                seenUids.add(event.uid);
                const mapping = this.options.mappings.get(calendarUrl, event.uid);
                const existing = localIndex.get(event.uid);

                if (!mapping) {
                    const created = await this.createLocal(local, event, resource, calendarUrl, report);
                    if (created) {
                        this.options.mappings.set({
                            uid: event.uid,
                            calendarUrl,
                            href: resource.href,
                            etag: resource.etag,
                            remoteHash,
                            start: event.start,
                            localHash: projectionHash(event),
                            local: { kind: "block", blockID: created.blockID, writtenAt: Date.now() },
                            syncedAt: Date.now(),
                            lastDirection: "create-local",
                        });
                    }
                    continue;
                }

                if (!existing) {
                    // 本地条目确实不存在（索引里没有该 UID）。
                    // 分两种情况：
                    //   a) 远端内容相对上次同步**变了** → 这是「远端新增/更新了内容」，
                    //      本地条目缺失只是因为还没建过（例如用户删掉了数据库行/文档，
                    //      或映射是上一轮刚建立的）→ 必须重建，否则会永远拉不下来；
                    //   b) 远端内容**没变** → 视为用户删除了本地条目，只解除本地引用，
                    //      交由 push 阶段按需删除远端；不要在这里直接删远端，也不要重建。
                    const remoteChanged = !mapping.remoteHash || !remoteHash || mapping.remoteHash !== remoteHash;
                    if (remoteChanged) {
                        const recreated = await this.createLocal(local, event, resource, calendarUrl, report);
                        if (recreated) {
                            this.options.mappings.set({
                                uid: event.uid,
                                calendarUrl,
                                href: resource.href,
                                etag: resource.etag,
                                remoteHash,
                                start: event.start,
                                localHash: projectionHash(event),
                                local: { kind: "block", blockID: recreated.blockID, writtenAt: Date.now() },
                                syncedAt: Date.now(),
                                lastDirection: "create-local",
                            });
                        }
                        continue;
                    }
                    mapping.local = undefined;
                    mapping.href = resource.href;
                    mapping.etag = resource.etag;
                    mapping.remoteHash = remoteHash;
                    mapping.start = event.start;
                    this.options.mappings.set(mapping);
                    report.skipped++;
                    continue;
                }

                // 属性读取失败（API 抖动）必须与「属性被清除」区分开：失败时跳过本轮，绝不删远端
                const loaded = await this.loadLocalEvent(local, existing.blockID, report, adapter.info.id);
                if (loaded.failed) {
                    report.skipped++;
                    continue;
                }
                const localEvent = loaded.event;
                const localChanged = localEvent ? mapping.localHash !== projectionHash(localEvent) : false;
                // 远端内容哈希由实际拉取结果计算；服务端未提供时保守认为「可能变化」
                const remoteChanged = !mapping.remoteHash || !remoteHash || mapping.remoteHash !== remoteHash;

                if (!remoteChanged && !localChanged) {
                    mapping.href = resource.href;
                    mapping.etag = resource.etag;
                    mapping.start = event.start;
                    mapping.syncedAt = Date.now();
                    this.options.mappings.set(mapping);
                    continue;
                }
                if (remoteChanged && !localChanged) {
                    await this.acceptRemote(local, existing, event, resource, mapping, remoteHash, calendarUrl);
                    report.pulled++;
                    report.updated++;
                    continue;
                }
                if (!remoteChanged && localChanged) {
                    // 本地改动交由 push 阶段处理
                    report.skipped++;
                    continue;
                }
                report.conflicts++;
                await this.resolveConflict(adapter, local, existing, event, resource, mapping, remoteHash, report);
            }
        }

        // 远端删除：仅在全量查询时可信，且只对「落在本次同步窗口内」的映射生效，
        // 否则窗口之外的历史事件会被误判为已删除（进而解除关联甚至删除思源文档）。
        if (objects.fullSync) {
            for (const uid of knownUids) {
                if (seenUids.has(uid)) {
                    continue;
                }
                const mapping = this.options.mappings.get(calendarUrl, uid);
                if (!mapping) {
                    continue;
                }
                if (typeof mapping.start === "number" && (mapping.start < start || mapping.start >= end)) {
                    continue;
                }
                report.deleted++;
                await this.handleRemoteDelete(local, mapping);
            }
        }

        // 增量响应中直接给出 404 的资源（无 calendar-data）按删除处理，按 href 匹配
        const deletedHrefs = objects.resources.filter((item) => !item.ics && item.href).map((item) => item.href);
        if (deletedHrefs.length) {
            for (const mapping of this.options.mappings.all()) {
                if (mapping.calendarUrl !== calendarUrl || !mapping.href) {
                    continue;
                }
                if (!deletedHrefs.some((href) => sameResource(mapping.href ?? "", href))) {
                    continue;
                }
                report.deleted++;
                await this.handleRemoteDelete(local, mapping);
            }
        }
    }

    /**
     * 读取本地条目。返回 `failed` 表示「读取本身失败」（API 抖动），
     * 调用方应跳过本轮而不是当作删除。
     */
    private async loadLocalEvent(
        local: LocalSyncStore,
        blockID: string,
        report: SyncReport,
        calendarId: string,
    ): Promise<{ event?: CalendarEvent; failed: boolean }> {
        try {
            return { event: await local.loadEvent(blockID), failed: false };
        } catch (error) {
            report.errors.push({
                calendarId,
                message: `读取思源条目属性失败（本轮跳过）：${errorMessage(error)}`,
            });
            return { failed: true };
        }
    }

    private async createLocal(
        local: LocalSyncStore,
        event: CalendarEvent,
        resource: { href: string; etag?: string },
        calendarUrl: string,
        report: SyncReport,
    ): Promise<LocalLink | undefined> {
        try {
            const link = await local.create(event, { etag: resource.etag, href: resource.href, calendarUrl });
            report.pulled++;
            report.created++;
            return link;
        } catch (error) {
            report.errors.push({
                calendarId: event.calendar,
                message: `创建思源条目失败：${errorMessage(error)}`,
            });
            return undefined;
        }
    }

    private async acceptRemote(
        local: LocalSyncStore,
        link: LocalLink,
        remoteEvent: CalendarEvent,
        resource: { href: string; etag?: string },
        mapping: EventMapping,
        remoteHash: string | undefined,
        calendarUrl: string,
    ): Promise<void> {
        await local.update(link, remoteEvent, {
            etag: resource.etag,
            href: resource.href,
            calendarUrl,
            previousTitle: link.title,
        });
        mapping.etag = resource.etag;
        mapping.href = resource.href;
        mapping.remoteHash = remoteHash;
        // localHash 记录「本地可持久化投影」的哈希，而不是完整事件哈希，
        // 否则未持久化的字段（attendees/alarms/status…）会让每轮同步都误判为本地已修改。
        mapping.localHash = projectionHash(remoteEvent);
        mapping.start = remoteEvent.start;
        mapping.local = { kind: "block", blockID: link.blockID, writtenAt: Date.now() };
        mapping.syncedAt = Date.now();
        mapping.lastDirection = "pull";
        this.options.mappings.set(mapping);
    }

    private async handleRemoteDelete(local: LocalSyncStore, mapping: EventMapping): Promise<void> {
        const blockID = mapping.local?.blockID;
        if (blockID) {
            const link: LocalLink = { uid: mapping.uid, blockID, rootID: blockID };
            if (this.options.deleteLocalWhenRemoteDeleted() && local.deleteDocument) {
                await local.deleteDocument(blockID).catch(() => undefined);
            } else {
                await local.unlink(link).catch(() => undefined);
            }
        }
        this.options.mappings.delete(mapping.calendarUrl, mapping.uid);
    }

    private async resolveConflict(
        adapter: CalDavSourceAdapter,
        local: LocalSyncStore,
        link: LocalLink,
        remoteEvent: CalendarEvent,
        resource: { href: string; etag?: string },
        mapping: EventMapping,
        remoteHash: string | undefined,
        report: SyncReport,
    ): Promise<void> {
        const calendarUrl = adapter.remote.url;
        const policy = this.options.conflictPolicy();
        if (policy === "skip") {
            report.skipped++;
            return;
        }
        if (policy === "remote") {
            await this.acceptRemote(local, link, remoteEvent, resource, mapping, remoteHash, calendarUrl);
            report.pulled++;
            report.updated++;
            return;
        }
        const localEvent = await local.loadEvent(link.blockID).catch(() => undefined);
        if (policy === "local") {
            if (!localEvent) {
                await this.acceptRemote(local, link, remoteEvent, resource, mapping, remoteHash, calendarUrl);
                report.pulled++;
                report.updated++;
                return;
            }
            const ics = buildIcs({ ...localEvent, uid: mapping.uid }, { includeTimezone: true });
            const updated = await adapter.pushIcs(resource.href, ics, mapping.etag);
            mapping.etag = updated.etag ?? mapping.etag;
            mapping.localHash = projectionHash(localEvent);
            // 远端内容已被本地版本覆盖，必须作废旧的远端哈希：
            // 下一次拉取会重新计算，避免用不同来源的哈希互相比较。
            mapping.remoteHash = undefined;
            mapping.start = localEvent.start;
            mapping.syncedAt = Date.now();
            mapping.lastDirection = "push";
            this.options.mappings.set(mapping);
            report.pushed++;
            report.updated++;
            return;
        }
        // duplicate：本地另存副本，随后接受远端版本
        if (localEvent) {
            try {
                await local.create(
                    {
                        ...localEvent,
                        uid: `${localEvent.uid}.copy-${Date.now().toString(36)}`,
                        title: `${localEvent.title} (本地副本)`,
                        isInstanceMirror: true,
                    },
                    { calendarUrl },
                );
                report.created++;
            } catch (error) {
                report.errors.push({ calendarId: adapter.info.id, message: `保存本地副本失败：${errorMessage(error)}` });
            }
        }
        await this.acceptRemote(local, link, remoteEvent, resource, mapping, remoteHash, calendarUrl);
        report.pulled++;
        report.updated++;
    }

    /* —— 推送：思源 → 远端 —— */

    /**
     * 判断事件的组件类型是否与日历能力匹配。
     *
     * `VEVENT`(日程) 需要日历支持 `VEVENT`，`VTODO`(任务) 需要支持 `VTODO`。
     * 服务端未声明能力时（`components` 为空）保守放行。
     */
    private isComponentCompatible(adapter: CalDavSourceAdapter, event: CalendarEvent): boolean {
        return isTodoEvent(event) ? adapter.supportsTasks() : adapter.supportsEvents();
    }

    private async push(adapter: CalDavSourceAdapter, report: SyncReport): Promise<void> {
        const local = this.options.local(adapter);
        if (!local || !adapter.isWritable()) {
            return;
        }
        const calendarUrl = adapter.remote.url;
        const localIndex = await local.refresh();
        const mappings = this.options.mappings.all().filter((item) => item.calendarUrl === calendarUrl);

        for (const mapping of mappings) {
            const blockID = mapping.local?.blockID;
            if (!blockID) {
                continue;
            }
            const loaded = await this.loadLocalEvent(local, blockID, report, adapter.info.id);
            if (loaded.failed) {
                // 属性读取失败：无法判断用户意图，跳过本轮（绝不删远端）
                continue;
            }
            const localEvent = loaded.event;
            if (!localEvent) {
                if (mapping.href) {
                    try {
                        await adapter.deleteRemote(mapping.href, mapping.etag);
                        report.pushed++;
                        report.deleted++;
                    } catch (error) {
                        report.errors.push({
                            calendarId: adapter.info.id,
                            message: `删除远端事件失败：${errorMessage(error)}`,
                        });
                    }
                }
                this.options.mappings.delete(calendarUrl, mapping.uid);
                continue;
            }
            if (localEvent.isInstanceMirror) {
                continue;
            }
            // 组件类型必须与日历能力匹配：把 VEVENT 写进「只支持任务」的日历会被服务端拒绝
            // （实测 Vikunja 返回 HTTP 500），这里提前拦住。这是**预期内的跳过**，
            // 不计入 errors（否则 SyncReport.errors 里会塞满噪音，用户看到一堆「同步失败」）。
            if (!this.isComponentCompatible(adapter, localEvent)) {
                report.skipped++;
                this.options.log?.(
                    `已跳过「${localEvent.title}」：该日历只支持${adapter.supportsEvents() ? "日程" : "任务"}，` +
                        `无法写入${isTodoEvent(localEvent) ? "任务" : "日程"}。`,
                );
                continue;
            }
            const localHash = projectionHash(localEvent);
            if (mapping.localHash && mapping.localHash === localHash) {
                continue;
            }
            const ics = buildIcs({ ...localEvent, uid: mapping.uid }, { includeTimezone: true });
            try {
                if (mapping.href) {
                    let result: { etag?: string };
                    try {
                        result = await adapter.putRemote(mapping.href, ics, mapping.etag);
                    } catch (error) {
                        // 远端资源已不存在（404/410）：多半是历史遗留映射（旧版本写入失败留下的 href）。
                        // 此时**不要**一直重试更新，改为按同一 UID 新建并更新映射，实现自愈。
                        if (!isRemoteMissing(error)) {
                            throw error;
                        }
                        this.options.log?.(
                            `远端资源不存在（${mapping.href}），改为新建：${localEvent.title}`,
                        );
                        const created = await adapter.createRemote(mapping.uid, ics);
                        mapping.href = created.url;
                        mapping.etag = created.etag;
                        mapping.remoteHash = undefined;
                        mapping.localHash = localHash;
                        mapping.start = localEvent.start;
                        mapping.syncedAt = Date.now();
                        mapping.lastDirection = "create-remote";
                        this.options.mappings.set(mapping);
                        report.pushed++;
                        report.created++;
                        continue;
                    }
                    mapping.etag = result.etag ?? mapping.etag;
                    // 远端哈希只在真正拉取到远端内容时写入，这里作废以便下轮重新计算
                    mapping.remoteHash = undefined;
                    mapping.localHash = localHash;
                    mapping.start = localEvent.start;
                    mapping.syncedAt = Date.now();
                    mapping.lastDirection = "push";
                    this.options.mappings.set(mapping);
                    report.pushed++;
                    report.updated++;
                } else {
                    const created = await adapter.createRemote(mapping.uid, ics);
                    mapping.href = created.url;
                    mapping.etag = created.etag;
                    mapping.remoteHash = undefined;
                    mapping.localHash = localHash;
                    mapping.start = localEvent.start;
                    mapping.syncedAt = Date.now();
                    mapping.lastDirection = "create-remote";
                    this.options.mappings.set(mapping);
                    report.pushed++;
                    report.created++;
                }
            } catch (error) {
                report.errors.push({
                    calendarId: adapter.info.id,
                    message: `推送事件失败（${localEvent.title}）：${errorMessage(error)}`,
                });
            }
        }

        // 思源侧新增条目（无映射）：仅在开关打开时推送
        if (this.options.pushLocalChanges()) {
            const writableCount = this.options.adapters().filter((item) => item.isWritable()).length;
            // 数据库同步模式下不做「新增条目自动推送」：数据库行是各来源的汇总视图，
            // 批量把本地行当成新事件推回远端会产生大量无意义的 PUT（实测出现 404 噪音）。
            const skipUnmapped = this.options.skipUnmappedPush?.() === true;
            for (const [uid, link] of localIndex) {
                if (skipUnmapped) {
                    break;
                }
                if (this.options.mappings.get(calendarUrl, uid)) {
                    continue;
                }
                const loaded = await this.loadLocalEvent(local, link.blockID, report, adapter.info.id);
                const localEvent = loaded.event;
                if (loaded.failed || !localEvent || localEvent.isInstanceMirror) {
                    continue;
                }
                // 归属校验：只推送属于本日历的条目，避免把 A 日历的新事件同时写进 B 日历
                if (!adapter.belongsTo(localEvent, { allowUnassigned: writableCount <= 1 })) {
                    continue;
                }
                if (!this.isComponentCompatible(adapter, localEvent)) {
                    continue;
                }
                try {
                    const created = await adapter.createRemote(uid, buildIcs({ ...localEvent, uid }, { includeTimezone: true }));
                    this.options.mappings.set({
                        uid,
                        calendarUrl,
                        href: created.url,
                        etag: created.etag,
                        remoteHash: undefined,
                        localHash: projectionHash(localEvent),
                        start: localEvent.start,
                        local: { kind: "block", blockID: link.blockID, writtenAt: Date.now() },
                        syncedAt: Date.now(),
                        lastDirection: "create-remote",
                    });
                    report.pushed++;
                    report.created++;
                } catch (error) {
                    report.errors.push({
                        calendarId: adapter.info.id,
                        message: `推送新条目失败（${localEvent.title}）：${errorMessage(error)}`,
                    });
                }
            }
        }
    }
}

/** 判断两个资源 URL 是否指向同一资源（容忍绝对/相对路径差异） */
function sameResource(a: string, b: string): boolean {
    if (a === b) {
        return true;
    }
    const normalize = (value: string): string => {
        try {
            const url = new URL(value);
            return url.pathname;
        } catch {
            return value.split("?")[0];
        }
    };
    return normalize(a) === normalize(b);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
