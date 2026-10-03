import type { CalendarEvent, CalendarSourceAv } from "../types";
import type { LocalLink, LocalSyncStore } from "../sync/engine";
import { AvRowStore, uidFromMarker, type AvSyncBinding } from "./avRowStore";
import { SiYuanAttributeViewSourceAdapter, detectAttributeView, MAX_CALENDAR_RANGE_DAYS } from "./avStore";
import { MS_DAY } from "../util/date";

/**
 * 把「思源数据库块（属性视图）的一行」当作同步的本地条目。
 *
 * 与 `LocalDocumentAdapter`（落库为文档）并列，由用户在设置里二选一：
 * 数据库行适合「在一个数据库里统一管理多来源任务」的用法。
 *
 * 安全边界：**只接管带 `custom-caldav-uid` 属性的行**。
 * 用户自己在数据库里手写的行永远不会被更新或删除。
 */
export class AvLocalStore implements LocalSyncStore {
    private readonly rows: AvRowStore;
    private readonly source: CalendarSourceAv;
    private readonly reader: SiYuanAttributeViewSourceAdapter;
    /** 行块 ID → 远端 UID（refresh 时填充，供 loadEvent 复用） */
    private readonly uidByRow = new Map<string, string>();

    constructor(
        private readonly options: {
            avID: string;
            binding: AvSyncBinding;
            fieldTypes?: Record<string, string>;
            zone: string;
            attrPrefix?: string;
            label?: string;
            /** 来源列写入的名称（账户名 / 数据源名），优先于日历名 */
            sourceLabel?: string;
            viewID?: string;
            /** 读取数据库行的日期区间（属性视图单次最多 63 天，必须显式给区间） */
            window?: () => { start: number; end: number };
            /** 诊断日志（写库、认领行等关键动作） */
            log?: (message: string, ...rest: unknown[]) => void;
        },
        rows?: AvRowStore,
    ) {
        this.rows =
            rows ??
            new AvRowStore({
                avID: options.avID,
                binding: options.binding,
                fieldTypes: options.fieldTypes,
                attrPrefix: options.attrPrefix,
                sourceLabel: options.sourceLabel,
                log: options.log,
            });
        this.source = {
            kind: "av",
            avID: options.avID,
            blockID: options.avID,
            viewID: options.viewID,
            label: options.label,
            dateKeyID: options.binding.dateKeyID,
            titleKeyID: options.binding.titleKeyID,
            // 「插件标识」列：读取行时据此判断该行是否由插件写入
            markerKeyID: options.binding.markerKeyID,
        };
        this.reader = new SiYuanAttributeViewSourceAdapter({
            source: this.source,
            info: { id: `av:${options.avID}`, name: options.label ?? "数据库", source: this.source },
            zone: options.zone,
        });
    }

    /**
     * 列出由本插件管理的行。
     *
     * 优先看「插件标识」列（值为 `caldav:<远端 UID>`）：这是纯单元格读取，
     * 不依赖块树索引，因此不会出现 `tree not found`。
     * 未绑定该列时退回行块自定义属性（兼容旧配置）。
     */
    async refresh(): Promise<Map<string, LocalLink>> {
        const map = new Map<string, LocalLink>();
        this.uidByRow.clear();
        const events = await this.readAllRows();
        const useMarker = Boolean(this.options.binding.markerKeyID);
        const candidates: Array<{ itemID: string; event: CalendarEvent }> = [];
        for (const event of events) {
            const itemID = event.siyuan?.itemID ?? event.siyuan?.blockID;
            if (itemID) {
                candidates.push({ itemID, event });
            }
        }
        if (useMarker) {
            let withMarker = 0;
            for (const current of candidates) {
                const marker = current.event.siyuan?.marker;
                const uid = uidFromMarker(marker);
                if (!uid) {
                    if (marker) {
                        // 有值但不是本插件写的（例如用户自己的标记），只记录不认领
                        this.options.log?.(`行 ${current.itemID} 的标识列不是本插件格式：${marker}`);
                    }
                    continue;
                }
                withMarker++;
                this.uidByRow.set(current.itemID, uid);
                map.set(uid, {
                    uid,
                    blockID: current.itemID,
                    rootID: this.options.avID,
                    title: current.event.title,
                });
            }
            this.options.log?.(
                `数据库行识别（按标识列 ${this.options.binding.markerKeyID}）：读到 ${candidates.length} 行，识出插件行 ${withMarker} 条`,
            );
            return map;
        }
        this.options.log?.(
            `数据库行识别（未绑定标识列，退回行块属性）：读到 ${candidates.length} 行`,
        );
        // 兼容路径：逐行读块属性（有限并发，避免一次打出上百个请求）
        const concurrency = 8;
        let cursor = 0;
        const worker = async (): Promise<void> => {
            while (cursor < candidates.length) {
                const current = candidates[cursor++];
                const identity = await this.rows.readRowIdentity(current.itemID);
                if (!identity?.uid) {
                    continue;
                }
                this.uidByRow.set(current.itemID, identity.uid);
                map.set(identity.uid, {
                    uid: identity.uid,
                    blockID: current.itemID,
                    rootID: this.options.avID,
                    title: current.event.title,
                });
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(concurrency, candidates.length || 1) }, () => worker()),
        );
        return map;
    }

    /**
     * 读取数据库里的行。
     *
     * 属性视图的日历区间**单次最多 63 天**（内核限制），所以绝不能一次读「全库」——
     * 那样会被按 1970 年分片，什么都读不到。这里按需要覆盖的区间分片读取，并做了上限保护。
     */
    private async readAllRows(): Promise<CalendarEvent[]> {
        const range = this.resolveWindow();
        const maxDays = MAX_CALENDAR_RANGE_DAYS - 1;
        const spanDays = Math.max(1, Math.ceil((range.end - range.start) / MS_DAY));
        const slices = Math.min(12, Math.max(1, Math.ceil(spanDays / maxDays)));
        const out: CalendarEvent[] = [];
        const seen = new Set<string>();
        for (let index = 0; index < slices; index++) {
            const sliceStart = range.start + Math.floor(((range.end - range.start) * index) / slices);
            const sliceEnd = range.start + Math.floor(((range.end - range.start) * (index + 1)) / slices);
            try {
                const { events } = await this.reader.load(sliceStart, sliceEnd);
                for (const event of events) {
                    const itemID = event.siyuan?.itemID ?? event.siyuan?.blockID ?? event.uid;
                    if (seen.has(itemID)) {
                        continue;
                    }
                    seen.add(itemID);
                    out.push(event);
                }
            } catch {
                /* 单个分片失败不影响其他分片 */
            }
        }
        return out;
    }

    /** 解析要覆盖的日期区间：优先使用调用方给出的同步窗口 */
    private resolveWindow(): { start: number; end: number } {
        const provided = this.options.window?.();
        const now = Date.now();
        const start = provided && Number.isFinite(provided.start) ? provided.start : now - 180 * MS_DAY;
        const end = provided && Number.isFinite(provided.end) && provided.end > start ? provided.end : now + 180 * MS_DAY;
        return { start, end };
    }

    /** 收集当前数据库里所有行的 itemID（用于「新增后识别哪一行是新的」） */
    private async collectItemIDs(): Promise<Set<string>> {
        const ids = new Set<string>();
        for (const event of await this.readAllRows()) {
            const itemID = event.siyuan?.itemID ?? event.siyuan?.blockID;
            if (itemID) {
                ids.add(itemID);
            }
        }
        return ids;
    }

    /**
     * 认领「刚刚写入的那一行」。
     *
     * 内核新增行的接口返回 null，不返回行 ID；这里用两个条件定位：
     * 1. 该行在写入前不存在（itemID 不在 before 集合里）；
     * 2. 日期与标题与事件匹配（避免并发场景下认领错行）。
     *
     * 绑定「插件标识」列时无需再写行属性——标识已经随内容一起写进单元格了。
     */
    private async adoptCreatedRow(before: Set<string>, event: CalendarEvent): Promise<string> {
        try {
            for (const candidate of await this.readAllRows()) {
                const itemID = candidate.siyuan?.itemID ?? candidate.siyuan?.blockID;
                if (!itemID || before.has(itemID)) {
                    continue;
                }
                const sameDay = Math.abs(candidate.start - event.start) < 60_000;
                const sameTitle = (candidate.title ?? "") === (event.title || "(未命名)");
                if (sameDay && sameTitle) {
                    if (!this.options.binding.markerKeyID) {
                        await this.rows.writeRowAttributes(itemID, event);
                    }
                    this.options.log?.(`已认领新行 ${itemID}`);
                    return itemID;
                }
            }
        } catch (error) {
            this.options.log?.("定位新行失败", error);
        }
        this.options.log?.(
            `未能定位新行：写入前后共 ${before.size} 行；请检查标识列（${this.options.binding.markerKeyID ?? "未绑定"}）`,
        );
        return "";
    }

    async create(event: CalendarEvent): Promise<LocalLink> {
        this.options.log?.(
            `数据库写入新行：${event.title}（${new Date(event.start).toISOString().slice(0, 10)}）`,
        );
        // 先记下当前已有的行 ID：内核新增接口不返回新行 ID，
        // 写入后按「新出现的行 + 日期/标题匹配」即可立即认领这一行。
        const before = await this.collectItemIDs();
        const blockID = await this.rows.createRow(event);
        const adopted = blockID || (await this.adoptCreatedRow(before, event));
        if (!adopted) {
            this.options.log?.("未能定位新行 ID，将在下次同步时按内容认领");
        }
        this.uidByRow.set(adopted, event.uid);
        return { uid: event.uid, blockID: adopted, rootID: this.options.avID, title: event.title };
    }

    async update(link: LocalLink, event: CalendarEvent): Promise<void> {
        this.options.log?.(`数据库更新行：${event.title}`);
        await this.rows.updateRow(link.blockID, event);
        this.uidByRow.set(link.blockID, event.uid);
    }

    /** 远端删除且用户选择「同步删除」时调用：删掉这一行 */
    async unlink(link: LocalLink): Promise<void> {
        this.options.log?.(`数据库删除行：${link.blockID}`);
        await this.rows.deleteRow(link.blockID);
        this.uidByRow.delete(link.blockID);
    }

    /** 与 unlink 同义（行就是条目本身，解除关联即删除） */
    async deleteDocument(blockID: string): Promise<void> {
        await this.rows.deleteRow(blockID);
        this.uidByRow.delete(blockID);
    }

    /**
     * 读取某一行当前的内容（用于冲突检测与推送）。
     *
     * `blockID` 参数在文档实现里是文档 ID；这里传的是行块 ID，
     * 由 `refresh()` 建立的映射还原为事件。
     */
    async loadEvent(blockID: string): Promise<CalendarEvent | undefined> {
        const uid = this.uidByRow.get(blockID);
        let events: CalendarEvent[];
        try {
            events = await this.readAllRows();
        } catch {
            // 读取失败必须抛出语义：返回 undefined 会被上层当成「用户删除了条目」
            throw new Error("读取数据库行失败");
        }
        for (const event of events) {
            const itemID = event.siyuan?.itemID ?? event.siyuan?.blockID;
            if (itemID !== blockID) {
                continue;
            }
            // 数据库行没有 href/etag，这里只回填 UID，保证推送时 UID 正确
            return { ...event, uid: uid ?? event.uid, readOnly: false };
        }
        return undefined;
    }
}

/** 从设置里的数据库同步配置构造本地存储；未配置完整时返回 undefined */
export function buildAvLocalStore(options: {
    avID: string;
    binding: AvSyncBinding;
    fieldTypes?: Record<string, string>;
    zone: string;
    attrPrefix?: string;
    label?: string;
    /** 来源列写入的名称（账户名 / 数据源名），优先于日历名 */
    sourceLabel?: string;
    viewID?: string;
    window?: () => { start: number; end: number };
    log?: (message: string, ...rest: unknown[]) => void;
}): AvLocalStore {
    return new AvLocalStore(options);
}

export { detectAttributeView };
