import { Plugin } from "siyuan";
import type { Custom, MobileCustom } from "siyuan";
import { CalendarDock, buildDockTabConfig } from "./ui/dock";
import { SettingsStore } from "./settings";
import { MappingStore } from "./state/mapping";
import { setLanguage, t } from "./util/i18n";
import { pushMsg, request } from "./kernel/api";
import { logger, mirrorToSystemLog } from "./util/logger";

/**
 * 样式占位符。
 *
 * 注意：不能写成 `const CSS = "@CALENDAR_CSS@"` —— 打包器会把常量折叠进字符串字面量，
 * 构建脚本再做文本替换就会破坏产物（换行被转义/未转义不一致）。
 * 因此这里由构建脚本替换整个 `loadCss()` 函数体，保持唯一且可校验的标记。
 */
function loadCss(): string {
    return "__CALENDAR_CSS_PLACEHOLDER__";
}

const SVG_ICONS = `<symbol id="iconCalendarCaldav" viewBox="0 0 32 32">
<path d="M9 2a1.5 1.5 0 0 1 1.5 1.5V6h11V3.5a1.5 1.5 0 0 1 3 0V6h1.5A4.5 4.5 0 0 1 30.5 10.5v14A4.5 4.5 0 0 1 26 29H6a4.5 4.5 0 0 1-4.5-4.5v-14A4.5 4.5 0 0 1 6 6h1.5V3.5A1.5 1.5 0 0 1 9 2Zm17.5 10H5.5v12.5a1 1 0 0 0 1 1h19a1 1 0 0 0 1-1V12Z" fill="currentColor"/>
<path d="M9 15h4v4H9zM14.5 15h4v4h-4zM20 15h3.5v4H20zM9 20.5h4v4H9z" fill="currentColor" opacity=".75"/>
<path d="M20.2 20.4a4.6 4.6 0 0 1 4.3 5.5l-1.9-.4a2.7 2.7 0 0 0-2.5-3.2v1.9l-3.3-2.6 3.4-2.7v1.5Z" fill="#18a878"/>
</symbol>`;

let styleElement: HTMLStyleElement | undefined;

function injectStyle(): void {
    if (styleElement) {
        return;
    }
    styleElement = document.createElement("style");
    styleElement.id = "siyuan-plugin-calendar-caldav-style";
    styleElement.textContent = loadCss();
    document.head.append(styleElement);
}

function removeStyle(): void {
    styleElement?.remove();
    styleElement = undefined;
}

export default class CalendarCalDavPlugin extends Plugin {
    private settingsStore!: SettingsStore;
    private mappings!: MappingStore;
    private dock?: CalendarDock;
    private statusBarElement?: HTMLElement;

    async onload(): Promise<void> {
        setLanguage(window.siyuan?.config?.lang);
        injectStyle();
        this.addIcons(SVG_ICONS);

        this.settingsStore = new SettingsStore({
            load: (name) => this.loadData(name),
            save: (name, data) => this.saveData(name, data),
        });
        this.mappings = new MappingStore({
            load: (name) => this.loadData(name),
            save: (name, data) => this.saveData(name, data),
        });
        await Promise.all([this.settingsStore.load(), this.mappings.load()]);

        // 日志：内存缓存始终可用；调试开启时同时写入思源系统日志（便于手机端查看）
        logger.setEnabled(this.settingsStore.value.advanced.debug || this.settingsStore.value.advanced.debugMode);
        mirrorToSystemLog((msg) => request("/api/log/pushMsg", { msg }, { silent: true }));

        this.registerCommands();
        this.registerDock();
        this.registerStatusBar();
        this.registerTopBar();
        this.registerEvents();

        logger.log(`loaded, ${this.mappings.size} mapping(s)`);
    }

    async onunload(): Promise<void> {
        this.dock?.destroy();
        this.dock = undefined;
        this.statusBarElement?.remove();
        this.statusBarElement = undefined;
        removeStyle();
        await this.mappings?.flush().catch(() => undefined);
        logger.log("unloaded");
    }

    async uninstall(): Promise<void> {
        await this.removeData("settings.json").catch(() => undefined);
        await this.removeData("mappings.json").catch(() => undefined);
    }

    /** 插件数据被同步/其他窗口修改时重载设置 */
    async onDataChanged(): Promise<void> {
        await this.settingsStore?.load();
        logger.setEnabled(this.settingsStore.value.advanced.debug || this.settingsStore.value.advanced.debugMode);
        await this.dock?.rebuildSources();
    }

    /* —— 注册 —— */

    private registerCommands(): void {
        this.addCommand({
            langKey: "openCalendar",
            langText: t("commandOpenCalendar"),
            hotkey: "",
            callback: () => this.openCalendar(),
        });
        this.addCommand({
            langKey: "syncCalendars",
            langText: t("commandSyncNow"),
            hotkey: "",
            callback: () => void this.dock?.syncNow(),
        });
        this.addCommand({
            langKey: "newCalendarEvent",
            langText: t("commandNewEvent"),
            hotkey: "",
            callback: () => {
                this.openCalendar();
                const start = Date.now() + 3_600_000;
                void this.dock?.createEvent(start, start + 3_600_000, false);
            },
        });
    }

    private registerDock(): void {
        const plugin = this;
        this.addDock({
            config: buildDockTabConfig(),
            data: {},
            type: "calendarDock",
            init(custom: Custom | MobileCustom) {
                const dock = new CalendarDock({
                    plugin,
                    settingsStore: () => plugin.settingsStore,
                    settings: () => plugin.settingsStore.value,
                    mappings: plugin.mappings,
                    onSyncStateChange: (state) => plugin.updateStatusBar(state),
                });
                plugin.dock = dock;
                return dock.init(custom as Custom);
            },
            destroy() {
                plugin.dock?.destroy();
                plugin.dock = undefined;
            },
        });
    }

    /**
     * 右下角状态栏标识已**取消**（用户反馈与系统状态栏字号/颜色不一致，且长期占用空间）。
     *
     * 保留同名方法是为了让 `onSyncStateChange` 等既有回调无需改动；
     * 同步入口现在只在日历面板底部（以及顶部栏图标）。
     */
    private registerStatusBar(): void {
        this.statusBarElement = undefined;
    }

    private registerTopBar(): void {
        this.addTopBar({
            icon: "iconCalendarCaldav",
            title: t("dockTitle"),
            position: "right",
            callback: () => this.openCalendar(),
        });
    }

    private registerEvents(): void {
        // 数据库/文档属性变化后刷新日历。
        // 注意：同步过程本身会写大量属性并触发 transactions，因此这里
        // 只做「失效缓存 + 去抖刷新」，且不强制重新请求远端（避免同步风暴）。
        this.eventBus.on("ws-main", (event: CustomEvent) => {
            const cmd = (event.detail as { cmd?: string } | undefined)?.cmd;
            if (!cmd) {
                return;
            }
            if (
                cmd === "setAttrViewBlockAttrs" ||
                cmd === "updateAttrViewCell" ||
                cmd === "setBlockAttrs" ||
                cmd === "transactions" ||
                cmd === "reloadAttrView"
            ) {
                this.dock?.handleExternalChange();
            }
        });
    }

    /* —— 行为 —— */

    private openCalendar(): void {
        const dock = window.siyuan?.layout?.rightDock;
        if (!dock || typeof dock.toggleModel !== "function") {
            void pushMsg(t("noCalendarsHint"), 3000);
            return;
        }
        // 停靠栏类型由 Plugin.addDock 拼接为 `${plugin.name}${type}`
        const type = `${this.name}calendarDock`;
        try {
            dock.toggleModel(type, true);
        } catch (error) {
            console.warn("[calendar-caldav] 无法打开日历面板", error);
            void pushMsg(t("noCalendarsHint"), 3000);
        }
    }

    /**
     * 状态栏标识已取消：这里仅保留同步状态的日志记录（面板底部自己会显示状态）。
     */
    private updateStatusBar(state: { syncing: boolean; lastSyncAt?: number; lastReport?: { pulled: number; pushed: number } }): void {
        void state;
    }
}
