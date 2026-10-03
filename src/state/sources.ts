import type { CalendarEvent, CalendarInfo, CalendarSourceCalDav, CalendarSourceQuery, CalendarSourceAv } from "../types";

/** 数据源适配器：把「某个日历」的事件读取/写入收敛到统一接口 */
export interface ISourceAdapter {
    /** 该日历是否可写（不可写时 UI 隐藏编辑入口） */
    isWritable(): boolean;
    /** 读取 [start, end) 区间内（含跨区间）的事件 */
    loadEvents(start: number, end: number): Promise<CalendarEvent[]>;
    /** 判断事件是否属于该适配器（拖动/编辑回写时用） */
    owns(event: CalendarEvent): boolean;
}

export interface CalDavAdapter extends ISourceAdapter {
    readonly info: CalendarInfo;
    readonly source: CalendarSourceCalDav;
}

export interface QueryAdapter extends ISourceAdapter {
    readonly info: CalendarInfo;
    readonly source: CalendarSourceQuery;
}

export interface AvAdapter extends ISourceAdapter {
    readonly info: CalendarInfo;
    readonly source: CalendarSourceAv;
}
