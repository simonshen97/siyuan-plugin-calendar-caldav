import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            "@": resolve(root, "src"),
            // 单元测试用桩替换思源注入的运行时模块
            siyuan: resolve(root, "src/__mocks__/siyuan.ts"),
        },
    },
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
        globals: false,
    },
});
