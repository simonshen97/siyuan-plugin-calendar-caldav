import { describe, expect, it } from "vitest";
import {
    addDays,
    addMonths,
    dateKey,
    dateKeyRange,
    dateKeyToTs,
    formatTime,
    humanDuration,
    isoWeekNumber,
    isSameDay,
    layoutOverlaps,
    minutesSinceMidnight,
    parseDateKey,
    partsOf,
    rangesIntersect,
    startOfDay,
    startOfMonth,
    startOfWeek,
    zonedTimeToTs,
    zoneOffset,
} from "./date";

const UTC = "UTC";
const SHANGHAI = "Asia/Shanghai";
const NEW_YORK = "America/New_York";

describe("时区换算", () => {
    it("zonedTimeToTs 与 partsOf 往返一致（UTC）", () => {
        const ts = zonedTimeToTs(2025, 1, 3, 12, 34, 56, UTC);
        expect(ts).toBe(Date.UTC(2025, 0, 3, 12, 34, 56));
        expect(partsOf(ts, UTC)).toMatchObject({ year: 2025, month: 1, day: 3, hour: 12, minute: 34, second: 56 });
    });

    it("带偏移时区换算正确（Asia/Shanghai 为 UTC+8）", () => {
        const ts = zonedTimeToTs(2025, 6, 18, 9, 0, 0, SHANGHAI);
        expect(ts).toBe(Date.UTC(2025, 5, 18, 1, 0, 0));
        expect(partsOf(ts, SHANGHAI).hour).toBe(9);
        expect(zoneOffset(ts, SHANGHAI)).toBe(8 * 3_600_000);
    });

    it("夏令时切换日仍返回正确的墙上时间（America/New_York）", () => {
        // 2025-03-09 是美东夏令时开始日：02:00 跳到 03:00
        const before = zonedTimeToTs(2025, 3, 8, 9, 0, 0, NEW_YORK);
        const after = zonedTimeToTs(2025, 3, 10, 9, 0, 0, NEW_YORK);
        expect(partsOf(before, NEW_YORK).hour).toBe(9);
        expect(partsOf(after, NEW_YORK).hour).toBe(9);
        // 相隔仍为 2 天，但实际毫秒数少 1 小时
        expect(after - before).toBe(47 * 3_600_000);
    });
});

describe("日历日与日期键", () => {
    it("dateKey / parseDateKey / dateKeyToTs 往返一致", () => {
        const ts = dateKeyToTs("2025-01-03", UTC);
        expect(dateKey(ts, UTC)).toBe("2025-01-03");
        expect(parseDateKey("2025-01-03")).toEqual({ year: 2025, month: 1, day: 3 });
    });

    it("非法日期键回落到今天而不是抛错", () => {
        const parsed = parseDateKey("not-a-date");
        const today = partsOf(Date.now(), UTC);
        expect(parsed.year).toBe(today.year);
        expect(parsed.month).toBe(today.month);
    });

    it("dateKey 跨时区正确归日", () => {
        const ts = Date.UTC(2025, 0, 3, 20, 0, 0);
        expect(dateKey(ts, UTC)).toBe("2025-01-03");
        expect(dateKey(ts, SHANGHAI)).toBe("2025-01-04");
        expect(isSameDay(ts, Date.UTC(2025, 0, 3, 23, 0), UTC)).toBe(true);
        // 上海时间下 20:00Z 与 23:00Z 都已是 1 月 4 日
        expect(isSameDay(ts, Date.UTC(2025, 0, 3, 23, 0), SHANGHAI)).toBe(true);
        // 上海时间下 15:00Z（=23:00 本地 1/3）与 20:00Z（=次日 04:00）不同日
        expect(isSameDay(ts, Date.UTC(2025, 0, 3, 15, 0), SHANGHAI)).toBe(false);
    });

    it("dateKeyRange 生成闭区间日期序列", () => {
        const keys = dateKeyRange(Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 4), UTC);
        expect(keys).toEqual(["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-04"]);
    });
});

describe("日期运算", () => {
    it("addDays 在夏令时切换日保持墙上时间", () => {
        const start = zonedTimeToTs(2025, 3, 8, 9, 0, 0, NEW_YORK);
        const next = addDays(start, 1, NEW_YORK);
        expect(partsOf(next, NEW_YORK).hour).toBe(9);
        expect(dateKey(next, NEW_YORK)).toBe("2025-03-09");
    });

    it("addMonths 处理月末溢出（1/31 + 1 月 → 2/28）", () => {
        const jan31 = zonedTimeToTs(2025, 1, 31, 10, 0, 0, UTC);
        const feb = addMonths(jan31, 1, UTC);
        expect(dateKey(feb, UTC)).toBe("2025-02-28");
        expect(partsOf(feb, UTC).hour).toBe(10);
    });

    it("startOfDay / startOfMonth / startOfWeek", () => {
        const ts = zonedTimeToTs(2025, 6, 18, 15, 30, 0, UTC); // 2025-06-18 是周三
        expect(dateKey(startOfDay(ts, UTC), UTC)).toBe("2025-06-18");
        expect(dateKey(startOfMonth(ts, UTC), UTC)).toBe("2025-06-01");
        expect(dateKey(startOfWeek(ts, 1, UTC), UTC)).toBe("2025-06-16"); // 周一
        expect(dateKey(startOfWeek(ts, 0, UTC), UTC)).toBe("2025-06-15"); // 周日
    });

    it("isoWeekNumber 与 partsOf.weekday 正确", () => {
        const ts = zonedTimeToTs(2025, 1, 1, 0, 0, 0, UTC); // 2025-01-01 周三
        expect(partsOf(ts, UTC).weekday).toBe(3);
        expect(isoWeekNumber(ts, UTC)).toBe(1);
        expect(isoWeekNumber(zonedTimeToTs(2025, 12, 29, 0, 0, 0, UTC), UTC)).toBe(1); // 2026 年第 1 周
    });

    it("minutesSinceMidnight 与 formatTime", () => {
        const ts = zonedTimeToTs(2025, 6, 18, 9, 30, 0, UTC);
        expect(minutesSinceMidnight(ts, UTC)).toBe(570);
        expect(formatTime(ts, { timeZone: UTC, hourCycle: 24 })).toMatch(/09:30/);
    });

    it("humanDuration 输出可读文本", () => {
        expect(humanDuration(30 * 60_000)).toBe("30 分钟");
        expect(humanDuration(90 * 60_000)).toBe("1 小时 30 分钟");
        expect(humanDuration(25 * 3_600_000)).toBe("1 天 1 小时");
    });
});

describe("区间与重叠布局", () => {
    it("rangesIntersect 使用半开区间", () => {
        expect(rangesIntersect({ start: 0, end: 10 }, { start: 5, end: 15 })).toBe(true);
        expect(rangesIntersect({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
        expect(rangesIntersect({ start: 0, end: 10 }, { start: -5, end: 0 })).toBe(false);
    });

    it("layoutOverlaps 为重叠事件分列并保持输入顺序", () => {
        const a = { start: 0, end: 60 };
        const b = { start: 30, end: 90 };
        const c = { start: 120, end: 180 };
        const layout = layoutOverlaps([a, b, c]);
        expect(layout[0].item).toBe(a);
        expect(layout[0].column).toBe(0);
        expect(layout[1].item).toBe(b);
        expect(layout[1].column).toBe(1);
        expect(layout[0].columns).toBe(2);
        // 不重叠的事件各自成簇
        expect(layout[2].columns).toBe(1);
        expect(layout[2].column).toBe(0);
    });

    it("layoutOverlaps 处理首尾相接（不算重叠）", () => {
        const a = { start: 0, end: 60 };
        const b = { start: 60, end: 120 };
        const layout = layoutOverlaps([a, b]);
        expect(layout[1].column).toBe(0);
        expect(layout[0].columns).toBe(1);
    });

    it("layoutOverlaps 处理三个事件共用同一时段", () => {
        const items = [
            { start: 0, end: 60 },
            { start: 10, end: 70 },
            { start: 20, end: 80 },
        ];
        const layout = layoutOverlaps(items);
        expect(layout.map((entry) => entry.column)).toEqual([0, 1, 2]);
        expect(layout.every((entry) => entry.columns === 3)).toBe(true);
    });
});

describe("边界情况", () => {
    it("闰年 2 月 29 日", () => {
        expect(dateKeyToTs("2024-02-29", UTC)).toBe(Date.UTC(2024, 1, 29));
        expect(partsOf(dateKeyToTs("2024-02-29", UTC), UTC).day).toBe(29);
    });

    it("跨年加减天数", () => {
        const ts = zonedTimeToTs(2024, 12, 31, 23, 0, 0, UTC);
        expect(dateKey(addDays(ts, 1, UTC), UTC)).toBe("2025-01-01");
        expect(dateKey(addDays(ts, -1, UTC), UTC)).toBe("2024-12-30");
    });

    it("addMonths 跨年", () => {
        const ts = zonedTimeToTs(2024, 12, 15, 8, 0, 0, UTC);
        expect(dateKey(addMonths(ts, 1, UTC), UTC)).toBe("2025-01-15");
        expect(dateKey(addMonths(ts, -12, UTC), UTC)).toBe("2023-12-15");
    });
});
