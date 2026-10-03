import { beforeEach, describe, expect, it } from "vitest";
import { logger, redact } from "./logger";

describe("redact", () => {
    it("隐藏 Basic / Bearer 凭据", () => {
        expect(redact("Authorization: Basic dXNlcjpwYXNz")).not.toContain("dXNlcjpwYXNz");
        expect(redact("Authorization: Bearer abcdef123456")).not.toContain("abcdef123456");
        expect(redact("Authorization: Basic dXNlcjpwYXNz")).toContain("***");
    });

    it("隐藏 password / token / secret / authorization 字段值", () => {
        expect(redact('{"password":"EXAMPLEAUTHCODE1234"}')).not.toContain("EXAMPLEAUTHCODE1234");
        expect(redact('"token": "abcdef123456"')).not.toContain("abcdef123456");
        expect(redact("secret=abcdef123456")).not.toContain("abcdef123456");
    });

    it("保留普通文本不变", () => {
        const text = "REPORT https://dav.qq.com/calendar/user%40example.com/ status=207";
        expect(redact(text)).toBe(text);
    });
});

describe("logger", () => {
    beforeEach(() => {
        logger.clear();
        logger.setEnabled(false);
        // 避免测试输出被日志刷屏
        logger.setConsoleOutput(false);
    });

    it("debug 日志在未开启调试时不记录", () => {
        logger.debug("should be skipped");
        expect(logger.size).toBe(0);
    });

    it("log 始终记录，并在开启调试后仍记录 debug", () => {
        logger.log("always");
        expect(logger.size).toBe(1);
        logger.setEnabled(true);
        logger.debug("now recorded");
        expect(logger.size).toBe(2);
        expect(logger.snapshot().map((entry) => entry.message)).toEqual(["always", "now recorded"]);
    });

    it("write 前会脱敏，不会把凭据写进日志", () => {
        logger.log("Authorization: Basic dXNlcjpwYXNz");
        expect(logger.toText()).not.toContain("dXNlcjpwYXNz");
    });

    it("错误对象被序列化为可读文本", () => {
        logger.error("请求失败", new Error("boom"));
        const line = logger.toText();
        expect(line).toContain("请求失败");
        expect(line).toContain("Error: boom");
    });

    it("容量上限：只保留最近 500 条", () => {
        for (let index = 0; index < 520; index++) {
            logger.log(`line-${index}`);
        }
        expect(logger.size).toBe(500);
        const entries = logger.snapshot();
        expect(entries[0].message).toBe("line-20");
        expect(entries[entries.length - 1].message).toBe("line-519");
    });

    it("snapshot 返回副本，修改不影响内部缓存", () => {
        logger.log("keep");
        const entries = logger.snapshot();
        entries.push({ time: 0, level: "info", message: "injected" });
        expect(logger.size).toBe(1);
    });

    it("toText 每行包含级别与消息", () => {
        logger.warn("warning line");
        const text = logger.toText();
        expect(text).toMatch(/WARN warning line/);
    });

    it("clear 清空缓存", () => {
        logger.log("a");
        logger.clear();
        expect(logger.size).toBe(0);
        expect(logger.toText()).toBe("");
    });
});
