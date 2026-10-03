import { describe, expect, it } from "vitest";
import manifest from "../plugin.json";

/**
 * 清单（plugin.json）回归用例。
 *
 * 背景（两个真实踩坑）：
 * 1. Docker / 浏览器访问时，客户端会拿当前前端去比对 `frontends` 白名单，
 *    不匹配就提示「该插件不支持在当前终端上使用」；
 * 2. 思源**没有 `browser` 这个前端取值**（合法取值只有 desktop / desktop-window /
 *    mobile / all），所以早期写的 `"browser"` 从未匹配上，必须用 `all` 或 `mobile`。
 */
describe("plugin.json 清单", () => {
    /** 思源客户端实际使用的前端取值（`all` 表示全平台） */
    const KNOWN_FRONTENDS = ["desktop", "desktop-window", "mobile", "all"];
    const KNOWN_BACKENDS = ["windows", "linux", "darwin", "docker", "android", "ios", "all"];

    it("frontends 只用思源认识的取值，且覆盖桌面 / 桌面窗口 / 移动（`all`）", () => {
        for (const value of manifest.frontends) {
            expect(KNOWN_FRONTENDS).toContain(value);
        }
        // `all` 是文档明确的「全平台」通配值：桌面、桌面窗口、移动端与 Docker 浏览器访问都能通过
        expect(manifest.frontends).toContain("all");
    });

    it("backends 只用思源认识的取值，且覆盖内核运行的所有平台", () => {
        for (const value of manifest.backends) {
            expect(KNOWN_BACKENDS).toContain(value);
        }
        expect(manifest.backends).toContain("docker");
        expect(manifest.backends).toContain("linux");
    });

    it("name 与集市约定一致，且最小版本与声明的内核接口匹配", () => {
        // 目录名 / zip 名由 name 决定，改名会导致加载器报 name-mismatch
        expect(manifest.name).toBe("siyuan-plugin-calendar-caldav");
        expect(manifest.minAppVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("displayName/description 具备中英两套文案，readme 指向存在的文件", () => {
        for (const field of [manifest.displayName, manifest.description, manifest.readme]) {
            expect(Object.keys(field)).toEqual(expect.arrayContaining(["default", "zh_CN"]));
        }
        expect(manifest.readme.zh_CN).toBe("README_zh_CN.md");
        expect(manifest.readme.default).toBe("README.md");
    });
});
