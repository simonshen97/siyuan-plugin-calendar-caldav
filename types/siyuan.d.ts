/**
 * 思源前端运行时为插件注入的 `siyuan` 模块的最小类型声明。
 *
 * 说明：思源自 v3 起，插件 `import { Plugin, ... } from "siyuan"` 由前端加载器解析，
 * 构建时必须 external。这里依据官方源码 app/src/plugin/index.ts 与 app/src/types/index.d.ts
 * 声明本插件实际用到的部分，保证类型检查可用且不依赖已过时的 npm `siyuan` 包。
 */
declare module "siyuan" {    export type TPluginDockPosition =
        | "LeftTop"
        | "LeftBottom"
        | "RightTop"
        | "RightBottom"
        | "BottomLeft"
        | "BottomRight";

    export interface IObject {
        [key: string]: string | number | boolean;
    }

    export interface IWebSocketData {
        cmd?: string;
        callback?: string;
        data?: any;
        msg: string;
        code: number;
        sid?: string;
        context?: any;
    }

    export interface IMenu {
        checked?: boolean;
        iconClass?: string;
        label?: string;
        click?: (element: HTMLElement, event: MouseEvent) => boolean | void | Promise<boolean | void>;
        type?: "separator" | "submenu" | "readonly" | "empty";
        accelerator?: string;
        action?: string;
        id?: string;
        submenu?: IMenu[];
        loadSubmenu?: () => Promise<IMenu[]>;
        disabled?: boolean;
        icon?: string;
        iconHTML?: string;
        current?: boolean;
        index?: number;
        element?: HTMLElement;
        ignore?: boolean;
        warning?: boolean;
    }

    export interface ICommand {
        langKey: string;
        langText?: string;
        hotkey?: string;
        customHotkey?: string;
        hotkeys?: string[];
        when?: (context: any) => boolean;
        enabled?: (context: any) => boolean;
        execute?: (context: any) => void | Promise<void>;
        callback?: (context?: any) => void;
        globalCallback?: (context?: any) => void;
        fileTreeCallback?: (file: any, context?: any) => void;
        editorCallback?: (protyle: any, context?: any) => void;
        dockCallback?: (element: HTMLElement, context?: any) => void;
    }

    export interface IPluginDockTab {
        position: TPluginDockPosition;
        size: { width: number; height: number };
        icon: string;
        hotkey?: string;
        title: string;
        index?: number;
        show?: boolean;
    }

    export interface IProtyleOptions {
        [key: string]: any;
    }

    export class Model {
        element: HTMLElement;
        constructor(options?: any);
        onGetFocus?(): void;
    }

    export class Tab {
        headElement: HTMLElement;
        panelElement: HTMLElement;
        model: Model;
        constructor(options?: any);
    }

    export class Custom extends Model {
        element: HTMLElement;
        tab: Tab;
        data: any;
        type: string;
        init: (custom: Custom) => void;
        destroy: () => void;
        beforeDestroy: () => void;
        resize: () => void;
        update: () => void;
        editors: any[];
        constructor(options: any);
    }

    export class MobileCustom {
        element: Element;
        data: any;
        type: string;
        init: (custom: MobileCustom) => void;
        destroy: () => void;
        update: () => void;
        constructor(options: any);
    }

    export class Setting {
        constructor(options: { width?: string; height?: string; confirmCallback?: () => void });
        addItem(options: {
            title: string;
            description?: string;
            actionElement?: HTMLElement;
            createActionElement?: () => HTMLElement;
            direction?: "column" | "row";
        }): void;
        open(title: string): void;
    }

    export class EventBus {
        on(type: string, listener: (event: CustomEvent) => void): void;
        off(type: string, listener: (event: CustomEvent) => void): void;
        emit(type: string, detail?: any): void;
    }

    export interface IApp {
        plugins: Plugin[];
        appId: string;
    }

    export class Plugin {
        public i18n: Record<string, any>;
        public eventBus: EventBus;
        public data: any;
        public displayName: string;
        public readonly name: string;
        public setting: Setting;
        public commands: ICommand[];
        public statusBarIcons: Element[];
        public topBarIcons: Element[];
        public protyleSlash: any[];
        public customBlockRenders: Record<string, any>;
        public docks: Record<string, any>;
        public models: Record<string, any>;

        constructor(options: {
            app: IApp;
            name: string;
            displayName: string;
            i18n: Record<string, any>;
        });

        public onload(): Promise<void> | void;
        public onunload(): Promise<void> | void;
        public uninstall(): Promise<void> | void;
        public onLayoutReady(): Promise<void> | void;
        public onDataChanged(reason?: "sync" | "overwrite"): Promise<void> | void;

        public loadData(storageName: string): Promise<any>;
        public saveData(storageName: string, data: any): Promise<any>;
        public removeData(storageName: string): Promise<IWebSocketData>;

        public getSecret(name: string): string;
        public getVariable(name: string): string;

        public addIcons(svg: string): void;
        public addTopBar(options: {
            id?: string;
            icon?: string;
            title: string;
            position?: "right" | "left";
            element?: HTMLElement;
            contextMenu?: (menu: any) => void;
            callback?: (evt: MouseEvent) => void;
        }): HTMLElement | undefined;
        public removeTopBar(id: string): void;
        public addStatusBar(options: { element: HTMLElement; position?: "right" | "left" }): HTMLElement;
        public addCommand(command: ICommand): void;
        public addDock(options: {
            id?: string;
            config: IPluginDockTab;
            data: any;
            type: string;
            destroy?: (this: Custom | MobileCustom) => void;
            resize?: (this: Custom) => void;
            update?: (this: Custom | MobileCustom) => void;
            init: (this: Custom | MobileCustom, custom: Custom | MobileCustom) => void;
        }): any;
        public removeDock(id: string): void;
        public openSetting(): void;
        /** 在思源「设置 → 关于 → 系统日志」中打开插件日志页签 */
        public addSystemLogItem(): void;
        public addTab(options: {
            type: string;
            destroy?: (this: Custom) => void;
            beforeDestroy?: (this: Custom) => void;
            resize?: (this: Custom) => void;
            update?: (this: Custom) => void;
            init: (this: Custom, custom: Custom) => void;
        }): any;
        public getOpenedTab(): Record<string, Custom[]>;
    }

    export function fetchPost(
        url: string,
        data?: any,
        cb?: (response: any) => void,
        headers?: Record<string, string>,
        failCallback?: (response: any) => void,
        signal?: AbortSignal,
        timeout?: number,
    ): void;

    export function fetchSyncPost(
        url: string,
        data?: any,
        headers?: Record<string, string>,
        process?: boolean,
        signal?: AbortSignal,
    ): Promise<any>;

    export function fetchGet(url: string, cb: (response: any) => void): void;

    export function showMessage(message: string, timeout?: number, type?: "info" | "error"): void;
    export function confirm(title: string, text: string, confirmCallback: () => void, cancelCallback?: () => void): void;

    export const platformUtils: {
        isMobile: () => boolean;
        isBrowser: () => boolean;
        isWindows: () => boolean;
        isLinux: () => boolean;
        isMac: () => boolean;
        isElectron: () => boolean;
        [key: string]: any;
    };

    export const Constants: {
        SIYUAN_APPID: string;
        [key: string]: any;
    };
}

/** 思源前端把运行时对象挂在 window.siyuan 上 */
interface Window {
    siyuan: {
        config?: {
            lang?: string;
            readonly?: boolean;
            [key: string]: unknown;
        };
        notebooks?: Array<{ id: string; name: string; closed: boolean }>;
        isPublish?: boolean;
        layout?: {
            rightDock?: { toggleModel: (type: string, show?: boolean, close?: boolean, hide?: boolean) => void };
            leftDock?: { toggleModel: (type: string, show?: boolean, close?: boolean, hide?: boolean) => void };
            bottomDock?: { toggleModel: (type: string, show?: boolean, close?: boolean, hide?: boolean) => void };
        };
        [key: string]: unknown;
    };
    /** 打开思源内部链接（例如 `siyuan://blocks/<id>`）；返回是否处理成功 */
    openFileByURL?: (url: string) => boolean;
}

