import type { CalendarEvent, CalendarInfo, PluginSettings, TCalendarViewMode } from "../types";
import type { CalendarStore } from "../state/store";
import { t } from "../util/i18n";
import {
    MS_DAY,
    MS_MINUTE,
    addDays,
    addMonths,
    dateKey,
    dateKeyRange,
    dateKeyToTs,
    formatLunar,
    formatMonthTitle,
    formatTime,
    formatWeekTitle,
    getLocalTimeZone,
    isoWeekNumber,
    layoutOverlaps,
    minutesSinceMidnight,
    partsOf,
    startOfDay,
    startOfMonth,
    startOfWeek,
} from "../util/date";
import { isTodoEvent } from "../caldav/ics";
import { eventTimeSummary } from "./dialog";

export interface CalendarViewOptions {
    store: CalendarStore;
    settings: () => PluginSettings;
    zone: string;
    onOpenEvent: (event: CalendarEvent) => void;
    onCreateEvent: (start: number, end: number, allDay: boolean) => void;
    onMoveEvent: (event: CalendarEvent, newStart: number) => void;
    onNavigate: (anchor: number, mode: TCalendarViewMode) => void;
    onToggleCalendar: (id: string) => void;
}

interface DayBucket {
    key: string;
    start: number;
    allDay: CalendarEvent[];
    timed: CalendarEvent[];
    events: CalendarEvent[];
    inMonth: boolean;
    isToday: boolean;
}

const MONTH_ROWS = 6;
const HOURS = 24;

/**
 * 日历视图：月/周/日/议程四种模式，纯 DOM 渲染（无额外 UI 框架依赖）。
 * 组件不持有数据，只消费 `CalendarStore` 的快照。
 */
export class CalendarView {
    readonly element: HTMLElement;
    private toolbarElement: HTMLElement;
    private titleElement: HTMLElement;
    private bodyElement: HTMLElement;
    private mode: TCalendarViewMode;
    private anchor: number;
    private events: CalendarEvent[] = [];
    private calendars: CalendarInfo[] = [];
    private destroyed = false;

    constructor(private readonly options: CalendarViewOptions) {
        this.mode = options.settings().view.defaultMode;
        this.anchor = startOfDay(Date.now(), options.zone);
        this.element = document.createElement("div");
        this.element.className = "cc-calendar";
        this.toolbarElement = document.createElement("div");
        this.toolbarElement.className = "cc-toolbar";
        const header = document.createElement("div");
        header.className = "cc-header";
        this.titleElement = document.createElement("div");
        this.titleElement.className = "cc-header__title";
        header.append(this.titleElement);
        this.bodyElement = document.createElement("div");
        this.bodyElement.className = "cc-body";
        this.element.append(this.toolbarElement, header, this.bodyElement);
        this.buildToolbar();
    }

    get currentMode(): TCalendarViewMode {
        return this.mode;
    }

    get currentAnchor(): number {
        return this.anchor;
    }

    setCalendars(calendars: CalendarInfo[]): void {
        this.calendars = calendars;
    }

    setEvents(events: CalendarEvent[], calendars: CalendarInfo[]): void {
        this.events = events;
        this.calendars = calendars;
        this.render();
    }

    setMode(mode: TCalendarViewMode): void {
        this.mode = mode;
        this.render();
        this.options.onNavigate(this.anchor, this.mode);
    }

    setAnchor(anchor: number, notify = true): void {
        this.anchor = startOfDay(anchor, this.options.zone);
        this.render();
        if (notify) {
            this.options.onNavigate(this.anchor, this.mode);
        }
    }

    goToday(): void {
        this.setAnchor(Date.now());
    }

    step(direction: -1 | 1): void {
        if (this.mode === "month") {
            this.setAnchor(addMonths(this.anchor, direction));
        } else if (this.mode === "week") {
            this.setAnchor(addDays(this.anchor, direction * 7));
        } else {
            this.setAnchor(addDays(this.anchor, direction));
        }
    }

    destroy(): void {
        this.destroyed = true;
        this.element.remove();
    }

    /* —— 工具栏 —— */

    private buildToolbar(): void {
        this.toolbarElement.innerHTML = "";
        const left = document.createElement("div");
        left.className = "cc-toolbar__group";

        const today = document.createElement("button");
        today.type = "button";
        today.className = "cc-btn cc-btn--ghost";
        today.textContent = t("today");
        today.addEventListener("click", () => this.goToday());

        const prev = this.iconButton("cc-icon-prev", t("prev"), '<path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/>');
        prev.addEventListener("click", () => this.step(-1));
        const next = this.iconButton("cc-icon-next", t("next"), '<path fill="currentColor" d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4L13.2 12z"/>');
        next.addEventListener("click", () => this.step(1));

        left.append(today, prev, next);

        const right = document.createElement("div");
        right.className = "cc-toolbar__group";
        const modes: TCalendarViewMode[] = ["month", "week", "day", "agenda"];
        const labels: Record<TCalendarViewMode, string> = {
            month: t("monthView"),
            week: t("weekView"),
            day: t("dayView"),
            agenda: t("agendaTitle"),
        };
        for (const mode of modes) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = `cc-tab${mode === this.mode ? " cc-tab--active" : ""}`;
            btn.dataset.mode = mode;
            btn.textContent = labels[mode];
            btn.addEventListener("click", () => this.setMode(mode));
            right.append(btn);
        }
        this.toolbarElement.append(left, right);
    }

    private iconButton(className: string, label: string, path: string): HTMLButtonElement {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `cc-icon-btn ${className}`;
        button.title = label;
        button.setAttribute("aria-label", label);
        button.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18">${path}</svg>`;
        return button;
    }

    /* —— 渲染 —— */

    private render(): void {
        if (this.destroyed) {
            return;
        }
        this.element.dataset.mode = this.mode;
        this.element.dataset.density = this.options.settings().view.density;
        for (const tab of this.toolbarElement.querySelectorAll<HTMLElement>(".cc-tab")) {
            tab.classList.toggle("cc-tab--active", tab.dataset.mode === this.mode);
        }
        if (this.mode === "month") {
            this.titleElement.textContent = formatMonthTitle(this.anchor, { timeZone: this.options.zone });
            this.renderMonth();
        } else if (this.mode === "week") {
            const start = startOfWeek(this.anchor, this.options.settings().view.weekStart, this.options.zone);
            this.titleElement.textContent = formatWeekTitle(start, addDays(start, 6), { timeZone: this.options.zone });
            this.renderTimeGrid(start, 7);
        } else if (this.mode === "day") {
            this.titleElement.textContent = formatWeekTitle(this.anchor, this.anchor, { timeZone: this.options.zone });
            this.renderTimeGrid(this.anchor, 1);
        } else {
            this.titleElement.textContent = formatMonthTitle(this.anchor, { timeZone: this.options.zone });
            this.renderAgenda();
        }
    }

    /** 按天分组当前事件，供各视图复用 */
    private bucketize(start: number, days: number, monthOf?: number): DayBucket[] {
        const zone = this.options.zone;
        const keys = dateKeyRange(start, addDays(start, days - 1), zone);
        const buckets = new Map<string, DayBucket>();
        const today = dateKey(Date.now(), zone);
        keys.forEach((key) => {
            const dayStart = dateKeyToTs(key, zone);
            buckets.set(key, {
                key,
                start: dayStart,
                allDay: [],
                timed: [],
                events: [],
                inMonth: monthOf === undefined || partsOf(dayStart, zone).month === monthOf,
                isToday: key === today,
            });
        });
        for (const event of this.events) {
            const eventStartKey = dateKey(event.start, zone);
            // 结束时间为半开区间：结束于 00:00 的事件不应显示在次日
            const lastDay = dateKey(Math.max(event.start, event.end - 1), zone);
            let cursor = eventStartKey;
            let guard = 0;
            while (cursor <= lastDay && guard < 400) {
                const bucket = buckets.get(cursor);
                if (bucket) {
                    if (event.allDay) {
                        bucket.allDay.push(event);
                    } else {
                        bucket.timed.push(event);
                    }
                    bucket.events.push(event);
                }
                cursor = dateKey(addDays(dateKeyToTs(cursor, zone), 1, zone), zone);
                guard++;
            }
        }
        for (const bucket of buckets.values()) {
            bucket.timed.sort((a, b) => a.start - b.start);
            bucket.allDay.sort((a, b) => b.end - b.start - (a.end - a.start));
        }
        return [...buckets.values()];
    }

    private colorOf(calendarId: string): string {
        return this.calendars.find((item) => item.id === calendarId)?.color ?? "var(--cc-accent)";
    }

    private eventChip(event: CalendarEvent, options?: { showTime?: boolean; detailed?: boolean }): HTMLElement {
        const settings = this.options.settings();
        const chip = document.createElement("div");
        chip.className = "cc-chip";
        chip.style.setProperty("--cc-chip-color", event.color ?? this.colorOf(event.calendar));
        chip.dataset.uid = event.uid;
        chip.dataset.calendar = event.calendar;
        chip.dataset.start = String(event.start);
        chip.dataset.allDay = event.allDay ? "1" : "0";
        if (event.readOnly) {
            chip.dataset.readonly = "1";
        }
        chip.draggable = !event.readOnly;
        if (event.status === "CANCELLED") {
            chip.dataset.cancelled = "1";
        }
        const showTime = options?.showTime ?? settings.view.showTimeInMonth;
        const label = document.createElement("span");
        label.className = "cc-chip__title";
        // 任务型服务端（Vikunja 等）只提供 VTODO：用「☐」前缀与事件区分，避免被误认为日程
        label.textContent = `${isTodoEvent(event) ? "☐ " : ""}${event.title || "(未命名)"}`;
        if (isTodoEvent(event)) {
            chip.dataset.todo = "1";
        }
        const meta = document.createElement("span");
        meta.className = "cc-chip__meta";
        if (event.allDay) {
            meta.textContent = "";
        } else if (showTime) {
            meta.textContent = formatTime(event.start, { timeZone: this.options.zone, hourCycle: settings.view.hourCycle });
            meta.style.display = "";
        } else {
            meta.style.display = "none";
        }
        chip.append(meta, label);
        if (options?.detailed) {
            const detail = document.createElement("div");
            detail.className = "cc-chip__detail";
            detail.textContent = [
                eventTimeSummary(event, this.options.zone, settings.view.hourCycle),
                event.location ?? "",
            ]
                .filter(Boolean)
                .join(" · ");
            chip.append(detail);
        }
        const tooltip = [event.title, event.location, event.calendarName, event.description]
            .filter(Boolean)
            .join("\n");
        if (tooltip) {
            chip.title = tooltip;
        }
        chip.addEventListener("click", (clickEvent) => {
            clickEvent.stopPropagation();
            this.options.onOpenEvent(event);
        });
        chip.addEventListener("dragstart", (dragEvent) => {
            dragEvent.dataTransfer?.setData("text/cc-event", JSON.stringify({ uid: event.uid, calendar: event.calendar, start: event.start }));
            if (dragEvent.dataTransfer) {
                dragEvent.dataTransfer.effectAllowed = "move";
            }
        });
        return chip;
    }

    private renderMonth(): void {
        const zone = this.options.zone;
        const settings = this.options.settings();
        const monthStart = startOfMonth(this.anchor, zone);
        const gridStart = startOfWeek(monthStart, settings.view.weekStart, zone);
        const monthNumber = partsOf(monthStart, zone).month;
        const days = MONTH_ROWS * 7;
        const buckets = this.bucketize(gridStart, days, monthNumber);
        const weekNumbers = settings.view.showWeekNumber;

        const grid = document.createElement("div");
        grid.className = `cc-month${weekNumbers ? " cc-month--weeks" : ""}`;

        // 表头：可选周数列 + 7 个星期
        grid.append(this.monthHeaderCell(weekNumbers ? "#" : ""));
        for (let i = 0; i < 7; i++) {
            const weekday = (settings.view.weekStart + i) % 7;
            const cell = document.createElement("div");
            cell.className = "cc-month__weekday";
            const main = document.createElement("span");
            main.textContent = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][weekday].slice(1);
            cell.append(main);
            grid.append(cell);
        }

        const maxChips = settings.view.density === "compact" ? 3 : 4;
        for (let row = 0; row < MONTH_ROWS; row++) {
            if (weekNumbers) {
                const weekCell = this.monthHeaderCell(String(isoWeekNumber(buckets[row * 7].start, zone)));
                weekCell.classList.add("cc-month__weekno");
                grid.append(weekCell);
            }
            for (let col = 0; col < 7; col++) {
                const bucket = buckets[row * 7 + col];
                const cell = document.createElement("div");
                cell.className = "cc-month__cell";
                cell.dataset.date = bucket.key;
                if (!bucket.inMonth) {
                    cell.classList.add("cc-month__cell--outside");
                }
                if (bucket.isToday && settings.view.highlightToday) {
                    cell.classList.add("cc-month__cell--today");
                }
                const head = document.createElement("div");
                head.className = "cc-month__dayhead";
                const dayNumber = document.createElement("span");
                dayNumber.className = "cc-month__daynum";
                dayNumber.textContent = String(partsOf(bucket.start, zone).day);
                head.append(dayNumber);
                if (settings.view.showLunar) {
                    const lunar = document.createElement("span");
                    lunar.className = "cc-month__lunar";
                    lunar.textContent = formatLunar(bucket.start, navigator.language || "zh-CN", zone);
                    head.append(lunar);
                }
                cell.append(head);

                const list = document.createElement("div");
                list.className = "cc-month__events";
                const visible = bucket.events.slice(0, maxChips);
                for (const event of visible) {
                    list.append(this.eventChip(event));
                }
                if (bucket.events.length > visible.length) {
                    const more = document.createElement("button");
                    more.type = "button";
                    more.className = "cc-more";
                    more.textContent = `+${bucket.events.length - visible.length} ${t("more")}`;
                    more.addEventListener("click", (clickEvent) => {
                        clickEvent.stopPropagation();
                        this.setMode("day");
                        this.setAnchor(bucket.start);
                    });
                    list.append(more);
                }
                cell.append(list);
                cell.addEventListener("dblclick", () => {
                    const start = dateKeyToTs(bucket.key, zone) + 9 * 3_600_000;
                    this.options.onCreateEvent(start, start + settings.view.defaultDuration * MS_MINUTE, false);
                });
                cell.addEventListener("dragover", (dragEvent) => {
                    if (dragEvent.dataTransfer?.types.includes("text/cc-event")) {
                        dragEvent.preventDefault();
                        cell.classList.add("cc-month__cell--drop");
                    }
                });
                cell.addEventListener("dragleave", () => cell.classList.remove("cc-month__cell--drop"));
                cell.addEventListener("drop", (dragEvent) => {
                    cell.classList.remove("cc-month__cell--drop");
                    const raw = dragEvent.dataTransfer?.getData("text/cc-event");
                    if (!raw) {
                        return;
                    }
                    dragEvent.preventDefault();
                    const parsed = JSON.parse(raw) as { uid: string; calendar: string; start: number };
                    const event = this.events.find((item) => item.uid === parsed.uid && item.calendar === parsed.calendar);
                    if (!event) {
                        return;
                    }
                    const timePart = partsOf(event.start, zone);
                    const newStart = dateKeyToTs(bucket.key, zone) + timePart.hour * 3_600_000 + timePart.minute * MS_MINUTE;
                    this.options.onMoveEvent(event, newStart);
                });
                grid.append(cell);
            }
        }
        this.bodyElement.innerHTML = "";
        this.bodyElement.append(grid);
    }

    private monthHeaderCell(text: string): HTMLElement {
        const cell = document.createElement("div");
        cell.className = "cc-month__weekday cc-month__weekday--corner";
        cell.textContent = text;
        return cell;
    }

    private renderTimeGrid(gridStart: number, dayCount: number): void {
        const zone = this.options.zone;
        const settings = this.options.settings();
        const buckets = this.bucketize(gridStart, dayCount);
        const hourHeight = settings.view.density === "compact" ? 36 : 48;
        const hourCycle = settings.view.hourCycle;

        const container = document.createElement("div");
        container.className = `cc-timegrid${dayCount === 1 ? " cc-timegrid--single" : ""}`;
        container.style.setProperty("--cc-hour-height", `${hourHeight}px`);

        // 全天行
        const allDayRow = document.createElement("div");
        allDayRow.className = "cc-allday";
        const allDayLabel = document.createElement("div");
        allDayLabel.className = "cc-allday__label";
        allDayLabel.textContent = t("allDay");
        allDayRow.append(allDayLabel);
        for (const bucket of buckets) {
            const cell = document.createElement("div");
            cell.className = "cc-allday__cell";
            cell.dataset.date = bucket.key;
            for (const event of bucket.allDay) {
                cell.append(this.eventChip(event, { showTime: false }));
            }
            allDayRow.append(cell);
        }
        allDayRow.style.setProperty("--cc-days", String(dayCount));

        // 列头
        const headRow = document.createElement("div");
        headRow.className = "cc-timegrid__head";
        const corner = document.createElement("div");
        corner.className = "cc-timegrid__corner";
        headRow.append(corner);
        for (const bucket of buckets) {
            const head = document.createElement("div");
            head.className = "cc-timegrid__dayhead";
            if (bucket.isToday && settings.view.highlightToday) {
                head.classList.add("cc-timegrid__dayhead--today");
            }
            const parts = partsOf(bucket.start, zone);
            const weekday = document.createElement("span");
            weekday.className = "cc-timegrid__weekday";
            weekday.textContent = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][parts.weekday];
            const dayNumber = document.createElement("span");
            dayNumber.className = "cc-timegrid__daynum";
            dayNumber.textContent = `${parts.day}`;
            head.append(weekday, dayNumber);
            headRow.append(head);
        }

        // 时间轴
        const scroll = document.createElement("div");
        scroll.className = "cc-timegrid__scroll";
        const axis = document.createElement("div");
        axis.className = "cc-timegrid__axis";
        for (let hour = 0; hour < HOURS; hour++) {
            const label = document.createElement("div");
            label.className = "cc-timegrid__hour";
            label.style.height = `${hourHeight}px`;
            label.textContent = formatHourLabel(hour, hourCycle);
            axis.append(label);
        }
        const columns = document.createElement("div");
        columns.className = "cc-timegrid__columns";
        columns.style.setProperty("--cc-days", String(dayCount));
        for (let index = 0; index < buckets.length; index++) {
            const bucket = buckets[index];
            const column = document.createElement("div");
            column.className = "cc-timegrid__column";
            column.dataset.date = bucket.key;
            if (bucket.isToday && settings.view.highlightToday) {
                column.classList.add("cc-timegrid__column--today");
            }
            for (let hour = 0; hour < HOURS; hour++) {
                const slot = document.createElement("div");
                slot.className = "cc-timegrid__slot";
                slot.style.height = `${hourHeight}px`;
                slot.addEventListener("dblclick", () => {
                    const start = dateKeyToTs(bucket.key, zone) + hour * 3_600_000;
                    this.options.onCreateEvent(start, start + settings.view.defaultDuration * MS_MINUTE, false);
                });
                column.append(slot);
            }
            const timed = bucket.timed;
            const layout = layoutOverlaps(timed);
            for (const entry of layout) {
                const event = entry.item;
                const startMinutes = minutesSinceMidnight(event.start, zone);
                let endMinutes = minutesSinceMidnight(event.end, zone);
                if (event.end > startOfDay(event.end, zone) || endMinutes <= startMinutes) {
                    endMinutes = 24 * 60;
                }
                const clampedStart = Math.max(0, startMinutes);
                const top = (clampedStart / 60) * hourHeight;
                const height = Math.max(18, ((Math.max(endMinutes, clampedStart + 15) - clampedStart) / 60) * hourHeight);
                const chip = this.eventChip(event, { showTime: true });
                chip.classList.add("cc-chip--timed");
                chip.style.position = "absolute";
                chip.style.top = `${top}px`;
                chip.style.height = `${height}px`;
                const widthPercent = 100 / entry.columns;
                chip.style.left = `calc(${entry.column * widthPercent}% + 2px)`;
                chip.style.width = `calc(${widthPercent}% - 4px)`;
                column.append(chip);
            }
            columns.append(column);
        }

        scroll.append(axis, columns);
        container.append(allDayRow, headRow, scroll);
        this.bodyElement.innerHTML = "";
        this.bodyElement.append(container);
        // 默认滚动到 8:00 附近
        requestAnimationFrame(() => {
            scroll.scrollTop = Math.max(0, 8 * hourHeight - 12);
        });
    }

    private renderAgenda(): void {
        const zone = this.options.zone;
        const settings = this.options.settings();
        const start = startOfDay(this.anchor, zone);
        const buckets = this.bucketize(start, 60);
        const list = document.createElement("div");
        list.className = "cc-agenda";
        let rendered = 0;
        for (const bucket of buckets) {
            if (!bucket.events.length) {
                continue;
            }
            rendered++;
            const group = document.createElement("div");
            group.className = "cc-agenda__day";
            const head = document.createElement("div");
            head.className = `cc-agenda__date${bucket.isToday ? " cc-agenda__date--today" : ""}`;
            const parts = partsOf(bucket.start, zone);
            head.textContent = `${parts.month} 月 ${parts.day} 日 · ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][parts.weekday]}`;
            if (settings.view.showLunar) {
                const lunar = formatLunar(bucket.start, navigator.language || "zh-CN", zone);
                if (lunar) {
                    const lunarEl = document.createElement("span");
                    lunarEl.className = "cc-agenda__lunar";
                    lunarEl.textContent = lunar;
                    head.append(lunarEl);
                }
            }
            group.append(head);
            for (const event of [...bucket.allDay, ...bucket.timed]) {
                const row = document.createElement("div");
                row.className = "cc-agenda__item";
                row.style.setProperty("--cc-chip-color", event.color ?? this.colorOf(event.calendar));
                const time = document.createElement("div");
                time.className = "cc-agenda__time";
                time.textContent = event.allDay
                    ? t("allDay")
                    : formatTime(event.start, { timeZone: zone, hourCycle: settings.view.hourCycle });
                const main = document.createElement("div");
                main.className = "cc-agenda__main";
                const title = document.createElement("div");
                title.className = "cc-agenda__title";
                title.textContent = event.title || "(未命名)";
                main.append(title);
                const meta = [event.location, event.calendarName].filter(Boolean).join(" · ");                if (meta) {
                    const sub = document.createElement("div");
                    sub.className = "cc-agenda__meta";
                    sub.textContent = meta;
                    main.append(sub);
                }
                row.append(time, main);
                row.addEventListener("click", () => this.options.onOpenEvent(event));
                group.append(row);
            }
            list.append(group);
        }
        if (!rendered) {
            const empty = document.createElement("div");
            empty.className = "cc-empty";
            empty.textContent = t("empty");
            list.append(empty);
        }
        this.bodyElement.innerHTML = "";
        this.bodyElement.append(list);
    }
}

function formatHourLabel(hour: number, hourCycle: 24 | 12): string {
    if (hourCycle === 24) {
        return `${String(hour).padStart(2, "0")}:00`;
    }
    const suffix = hour < 12 ? "AM" : "PM";
    const display = hour % 12 === 0 ? 12 : hour % 12;
    return `${display} ${suffix}`;
}

/** 计算某天的日期（供外部工具复用） */
export function dayStartOf(ts: number, zone = getLocalTimeZone()): number {
    return startOfDay(ts, zone);
}

export const DAY_MS = MS_DAY;
