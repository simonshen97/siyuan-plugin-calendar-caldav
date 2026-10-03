/**
 * 日历视图 + CalDAV 同步的核心数据模型。
 *
 * 设计要点：
 * 1. `CalendarEvent` 是「统一事件模型」，既是 CalDAV 远端事件，也是思源本地条目；
 * 2. 每条事件通过 `CalendarRef` 归属某个日历（`source` 描述日历来自哪里）；
 * 3. 与远端的对应关系保存在 `EventMapping`（uid ↔ 远端 href ↔ 本地块/属性视图行），
 *    这是双向同步与冲突检测的唯一依据。
 */

export type CalendarSourceKind = "caldav" | "av" | "query" | "virtual";

/** 属性视图（数据库）日历数据源 */
export interface CalendarSourceAv {
    kind: "av";
    /** 属性视图 ID（avID） */
    avID: string;
    /** 属性视图所在块 ID（用于渲染/打开） */
    blockID: string;
    /** 日历绑定的日期字段 keyID（对应 IAVCalendarSettings.dateKeyID） */
    dateKeyID?: string;
    /** 可选的「标题」字段 keyID，缺省时用属性视图主键 */
    titleKeyID?: string;
    /** 可选的颜色字段 keyID（单选字段） */
    colorKeyID?: string;
    /**
     * 可选的「插件标识」字段 keyID。
     *
     * 由本插件写入（值为 `caldav:<远端 UID>`），用于识别哪些行由插件管理；
     * 用户手写的行该列为空，因此永远不会被插件改写或删除。
     */
    markerKeyID?: string;
    /** 已选视图 ID，缺省用第一个日历视图 */
    viewID?: string;
    /** 面包屑/标题缓存，仅用于 UI 展示 */
    label?: string;
}

/** SQL 查询式数据源（文档 + 自定义属性） */
export interface CalendarSourceQuery {
    kind: "query";
    /** 例如：`SELECT * FROM blocks WHERE type = 'd' AND ial LIKE '%custom-due%'` */
    stmt: string;
    /** 日期取值方式：ial 属性名（不含 custom- 前缀）或子块 */
    dateAttr: string;
    /** 结束日期属性名，可选 */
    endDateAttr?: string;
    /** 标题取值：'content' | 'name' | 'fcontent' | 'tag' | 'ial' 属性名 */
    titleField?: string;
    /** 是否读取块内容作为标题 */
    withContent?: boolean;
    /** 本地虚拟日历的标识颜色 */
    color?: string;
    label?: string;
}

/** CalDAV 数据源：真正参与双向同步 */
export interface CalendarSourceCalDav {
    kind: "caldav";
    /** 账户 ID -> CalDavAccount.id */
    accountId: string;
    /** 日历集合的绝对 URL（以 / 结尾） */
    calendarUrl: string;
    /** 日历显示名（来自 DAV:displayname） */
    displayName?: string;
    /** 日历颜色（来自 calendar-color 或本地覆盖） */
    color?: string;
    /** 是否只读（被服务端标记 readonly 或用户禁用写入） */
    readOnly?: boolean;
    /** 支持的事件类型（VEVENT / VTODO） */
    components?: string[];
}

/** 本地虚拟日历（仅由思源条目生成，不参与同步） */
export interface CalendarSourceVirtual {
    kind: "virtual";
    /** 子类型：今日/未来 N 天/未完成闪卡/反链等 */
    variant: "today" | "upcoming" | "flashcards" | "tags";
    days?: number;
    color?: string;
    label?: string;
}

export type CalendarSource =
    | CalendarSourceCalDav
    | CalendarSourceAv
    | CalendarSourceQuery
    | CalendarSourceVirtual;

export type TEventStatus = "CONFIRMED" | "TENTATIVE" | "CANCELLED";
export type TEventTransparency = "OPAQUE" | "TRANSPARENT";
export type TEventClass = "PUBLIC" | "PRIVATE" | "CONFIDENTIAL";

export interface IAttendee {
    cn?: string;
    mailto?: string;
    partstat?: "NEEDS-ACTION" | "ACCEPTED" | "DECLINED" | "TENTATIVE" | "DELEGATED";
    role?: string;
}

/** 统一日历事件模型 */
export interface CalendarEvent {
    /** iCalendar UID；本地新建条目也会生成 UID，便于后续推送 */
    uid: string;
    /** 日历归属 */
    calendar: string;
    /** 日历显示名（运行时由视图层补充，便于提示与议程视图展示） */
    calendarName?: string;
    /** 日历颜色（运行时由视图层补充，优先级高于日历色） */
    color?: string;
    /** 数据来源（决定该事件能否写回以及写回方式） */
    sourceKind: CalendarSourceKind;
    title: string;
    /** 纯文本描述（去掉 HTML） */
    description?: string;
    location?: string;
    /** 分类/标签 */
    categories?: string[];
    status?: TEventStatus;
    transparency?: TEventTransparency;
    cls?: TEventClass;
    /** 重复规则的原始 RRULE 字符串（不含 "RRULE:"） */
    rrule?: string;
    /** 结束时间是否包含在重复范围内（RECURRENCE-ID 概览） */
    exdates?: number[];
    /** 覆盖实例的 RECURRENCE-ID（原始值） */
    recurrenceId?: string;
    /** 本次实例的开始/结束时间（毫秒时间戳，已完成重复展开与覆盖应用） */
    start: number;
    end: number;
    /** 是否全天事件 */
    allDay: boolean;
    /** 全天事件是否使用了结束日期（DTEND 为开区间次日） */
    hasEndDate?: boolean;
    /** 事件时区（IANA 名称，例如 Asia/Shanghai），全天事件为浮动的本地日期 */
    tzid?: string;
    /** 上次修改时间（DTSTAMP/LAST-MODIFIED），毫秒时间戳 */
    lastModified?: number;
    /** 创建时间 */
    created?: number;
    /** 事件链接（URL 属性） */
    url?: string;
    organizer?: IAttendee;
    attendees?: IAttendee[];
    /** 提醒（分钟偏移，负数表示提前） */
    alarms?: { trigger: number; action?: string; description?: string }[];
    /** 当前实例是否来自重复展开（只读实例） */
    isRecurringInstance?: boolean;
    /** 该思源条目是否为「重复实例」的镜像文档（不允许反向推送为独立事件） */
    isInstanceMirror?: boolean;
    /** 重复规则的主事件 UID（实例的 uid 与主事件一致） */
    rruleSummary?: string;
    /** 是否只读（来自只读日历或不可写数据源） */
    readOnly?: boolean;
    /** 来源为思源时，指向对应块/行，用于「跳转到思源」 */
    siyuan?: {
        /** 文档或块 ID */
        blockID?: string;
        /** 属性视图行 ID */
        itemID?: string;
        /** 属性视图 ID */
        avID?: string;
        /** 属性视图日期字段 keyID */
        dateKeyID?: string;
        /**
         * 「插件标识」列的值（由本插件写入，用于区分哪些行是插件管理的）。
         * 形如 `caldav:<远端 UID>`；用户手写的行为空。
         */
        marker?: string;
        /** 数据库所在文档 ID */
        rootID?: string;
        /** 笔记本 ID */
        box?: string;
        /** 文档路径 */
        path?: string;
        hPath?: string;
    };
    /** 失败/提示信息（例如推送冲突时的说明） */
    error?: string;
}

/** 一个「日历」= 一组可展示/可同步事件 */
export interface CalendarInfo {
    /** 唯一 ID：`caldav:<accountId>:<encoded url>` / `av:<avID>` / `query:<hash>` / `virtual:<variant>` */
    id: string;
    name: string;
    color?: string;
    readOnly?: boolean;
    source: CalendarSource;
    /** 最近一次拉取时间 */
    fetchedAt?: number;
    /** 拉取失败原因 */
    error?: string;
    /** 该日历事件数量（最近一次拉取） */
    count?: number;
}

/** —— 同步映射持久化 —— */

export interface EventMapping {
    uid: string;
    /** 远端日历 URL */
    calendarUrl: string;
    /** 远端资源路径（相对 calendarUrl 或绝对 path） */
    etag?: string;
    /** 远端资源完整 URL */
    href?: string;
    /** 远端序列号（用于快速判断变更） */
    scheduleTag?: string;
    /** 本地对应物 */
    local?: {
        kind: "block" | "avItem";
        blockID?: string;
        itemID?: string;
        avID?: string;
        dateKeyID?: string;
        /** 该条目最后一次被本插件写入的时间（毫秒） */
        writtenAt?: number;
    };
    /** 上次成功同步时间 */
    syncedAt: number;
    /**
     * 该事件（主事件）的开始时间。
     * 用于区分「远端确实删除了」与「事件落在同步窗口之外」——后者不能被当作删除处理。
     */
    start?: number;
    /** 最近一次同步方向 */
    lastDirection?: "pull" | "push" | "both" | "create-remote" | "create-local";
    /** 最后一次已知的远端摘要（仅由实际拉取到的远端内容计算） */
    remoteHash?: string;
    /**
     * 最后一次写入本地条目时，「可持久化投影」的内容哈希。
     * 本地条目只保存事件字段的子集（见 LocalDocumentAdapter），
     * 因此不能用完整事件哈希做比较，否则远端事件里未被持久化的字段
     * （attendees/alarms/status 等）会导致每轮同步都误判为「本地已修改」。
     */
    localHash?: string;
}

export interface CalDavAccount {
    id: string;
    name: string;
    /** 服务器根地址，例如 https://cloud.example.com/remote.php/dav */
    serverUrl: string;
    username: string;
    /**
     * 密码/应用专用密码。
     * 出于安全考虑，推荐使用思源「设置 - 密钥」中的密钥名，仅保存 `passwordSecret`。
     */
    passwordSecret?: string;
    /** 直接保存的密码（仅在未使用密钥库时使用） */
    password?: string;
    /**
     * 认证方式。
     * 注意：思源内核的 forwardProxy **不实现 Digest 挑战/应答**，
     * 因此这里只支持 Basic 与 Bearer；Digest 服务器需要自建反代或改用应用专用密码。
     */
    authType?: "basic" | "bearer";
    /** bearer token（authType = bearer） */
    tokenSecret?: string;
    /** 已发现的日历列表 */
    calendars?: CalendarInfo[];
    /**
     * 手动指定的日历集合 URL（每行一个）。
     *
     * 少数服务端（例如 QQ 邮箱 dav.qq.com）对任何 PROPFIND/REPORT 都返回**空 multistatus**，
     * 无法通过发现（discovery）枚举日历；此时把服务端实际使用的集合地址填在这里。
     * 留空时插件仍会自动发现。
     */
    manualCalendarUrls?: string[];
    /** 主目录（principal / calendar-home-set）缓存 */
    homeSet?: string;
    principalUrl?: string;
    /** 账户级开关 */
    enabled: boolean;
    /** 账户级同步方向覆盖 */
    syncDirection?: TSyncDirection;
    color?: string;
    /** 最近一次同步时间 */
    lastSyncAt?: number;
    /** 最近一次错误 */
    lastError?: string;
}

export type TSyncDirection = "both" | "pull" | "push" | "off";
export type TConflictPolicy = "remote" | "local" | "duplicate" | "skip";

/**
 * 数据库块（属性视图）同步配置：把各来源的事件写成数据库的「行」。
 *
 * 这是「在一个数据库里统一管理 QQ 邮箱 / 企业微信 / Vikunja 任务」的核心配置，
 * 全部字段都是数据库列的 keyID；未绑定的列不会被写入。
 */
export interface AvSyncConfig {
    /**
     * 属性视图 ID（内核的 avID）。
     *
     * 注意：用户复制到的是**块 ID**，与 avID 不同——设置页在「读取字段」时会从块的 ial
     * 里解析出真正的 avID 并写回这里，因此这里的值始终可直接用于内核接口。
     */
    avID: string;
    /** 数据库块的块 ID（写行属性时需要；留空则退回 avID） */
    blockID?: string;
    /** 默认视图 ID */
    viewID?: string;
    /** 是否启用数据库同步（关闭时不影响「落库到文档」的路径） */
    enabled: boolean;
    /** 字段绑定 */
    dateKeyID: string;
    titleKeyID?: string;
    endKeyID?: string;
    descriptionKeyID?: string;
    locationKeyID?: string;
    calendarKeyID?: string;
    uidKeyID?: string;
    statusKeyID?: string;
    /**
     * 「插件标识」列（建议绑定）。
     *
     * 插件写入 `caldav:<远端 UID>`：既是「这行归插件管」的判据，也记录远端 UID。
     * **用户手写的行该列为空，绝不被改写或删除。**
     */
    markerKeyID?: string;
    /**
     * 同步方向：
     * - `pull`：只把远端事件拉进数据库（推荐，数据库视为汇总视图）
     * - `both`：数据库里的改动也会推回远端
     */
    direction: "pull" | "both";
}

export interface SyncOptions {
    direction: TSyncDirection;
    /** 同步时间窗口（天）：过去 N 天 ~ 未来 N 天 */
    pastDays: number;
    futureDays: number;
    /** 同步到本地时使用的笔记本 ID（空 = 第一个未关闭的笔记本） */
    targetNotebook: string;
    /** 同步到本地时的文档路径模板 */
    pathTemplate: string;
    /** 冲突策略 */
    conflictPolicy: TConflictPolicy;
    /** 删除本地思源条目（关闭时仅移除映射） */
    deleteLocalWhenRemoteDeleted: boolean;
    /** 未开启双向同步时，是否允许把 CalDAV 事件创建为思源文档 */
    pushLocalChanges: boolean;
    /** 同步间隔（分钟），0 表示仅手动 */
    intervalMinutes: number;
    /** 应用本插件自己的思源属性命名空间 */
    attrPrefix: string;
}

/** 与思源条目之间使用的自定义属性名（不带 custom- 前缀） */
export interface LocalAttrNames {
    uid: string;
    calendar: string;
    etag: string;
    href: string;
    lastSync: string;
    recurrenceId: string;
}

export interface PluginSettings {
    version: number;
    accounts: CalDavAccount[];
    /** 本地数据源：属性视图与查询日历 */
    localSources: CalendarSource[];
    sync: SyncOptions;
    /** 数据库块（属性视图）同步：把各来源事件写成数据库行 */
    avSync?: AvSyncConfig;
    /**
     * 被用户停用的日历 ID 列表（持久化，重启后保持）。
     *
     * 以前只存在内存里，重启思源后被停用的日历会全部「复活」。
     */
    hiddenCalendars?: string[];
    view: {
        defaultMode: TCalendarViewMode;
        weekStart: 0 | 1 | 2 | 3 | 4 | 5 | 6;
        /** 是否显示农历 */
        showLunar: boolean;
        /** 是否显示周数 */
        showWeekNumber: boolean;
        /** 小时制：24 / 12 */
        hourCycle: 24 | 12;
        /** 事件默认时长（分钟） */
        defaultDuration: number;
        /** 是否在月视图单元格内显示时间 */
        showTimeInMonth: boolean;
        /** 密度 */
        density: "comfortable" | "compact";
        /** 默认提醒（分钟，负数表示提前） */
        defaultAlarm?: number;
        /** 全天事件在周视图的置顶区域 */
        allDayLane: boolean;
        /** 高亮今天 */
        highlightToday: boolean;
    };
    /** 高级：请求超时、调试日志 */
    advanced: {
        requestTimeoutMs: number;
        debug: boolean;        /**
         * 调试模式：额外开放「清理」能力（删除本插件写入的数据库行与同步映射），
         * 并把同步界面拆成三个按钮便于分段调试。
         */
        debugMode: boolean;
        /** 允许不安全证书由内核代理决定，这里仅记录用户确认 */
        acceptInsecureTLS: boolean;
        /** 每次同步的最大并发 */
        concurrency: number;
    };
}

export type TCalendarViewMode = "month" | "week" | "day" | "agenda";

export interface SyncReport {
    startedAt: number;
    finishedAt: number;
    pulled: number;
    pushed: number;
    created: number;
    updated: number;
    deleted: number;
    skipped: number;
    conflicts: number;
    errors: { calendarId: string; message: string }[];
}
