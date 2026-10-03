import { build } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dev = process.argv.includes("--dev");
const dist = resolve(root, "dist");
const pluginJson = JSON.parse(readFileSync(resolve(root, "plugin.json"), "utf8"));
const staticTargets = [
    "plugin.json",
    "icon.png",
    "preview.png",
    "README.md",
    "README_zh_CN.md",
]
    .filter((file) => existsSync(resolve(root, file)))
    .map((file) => ({ src: file, dest: "." }))
    .concat([{ src: "src/i18n/*", dest: "i18n" }]);

process.env.NODE_ENV = dev ? "development" : "production";

await build({
    root,
    mode: dev ? "development" : "production",
    configFile: false,
    resolve: {
        alias: { "@": resolve(root, "src") },
    },
    define: {
        "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
    },
    build: {
        sourcemap: dev ? "inline" : false,
        minify: !dev,
        target: "chrome100",
        outDir: "dist",
        emptyOutDir: true,
        lib: {
            entry: resolve(root, "src/index.ts"),
            formats: ["cjs"],
            fileName: () => "index.js",
        },
        rollupOptions: {
            // 思源前端已内置这些运行时依赖，不能打进插件产物
            external: ["siyuan", "process", "path", "fs", "crypto", "os", "electron", "child_process"],
            output: {
                // 打包为单个文件，避免插件加载器解析多 chunk
                inlineDynamicImports: true,
                exports: "named",
            },
        },
    },
    plugins: [
        viteStaticCopy({
            targets: staticTargets,
        }),
    ],
    logLevel: "warn",
});

/* 1) 把 CSS 内联进 index.js（思源插件只加载 index.js / index.css 两个文件） */
const cssPath = resolve(root, "src/styles/calendar.css");
const jsPath = resolve(dist, "index.js");
if (!existsSync(cssPath) || !existsSync(jsPath)) {
    throw new Error("构建产物缺失：请确认 src/styles/calendar.css 与 dist/index.js 存在");
}
const css = readFileSync(cssPath, "utf8");
let js = readFileSync(jsPath, "utf8");
const quotedCss = JSON.stringify(css);
// 替换点：src/index.ts 中 loadCss() 的函数体字符串字面量
const placeholderLiteral = '"__CALENDAR_CSS_PLACEHOLDER__"';
const placeholderAt = js.indexOf(placeholderLiteral);
if (placeholderAt < 0) {
    throw new Error("未在 dist/index.js 中找到 CSS 占位符 __CALENDAR_CSS_PLACEHOLDER__");
}
js = js.slice(0, placeholderAt) + quotedCss + js.slice(placeholderAt + placeholderLiteral.length);
if (js.includes("__CALENDAR_CSS_PLACEHOLDER__")) {
    throw new Error("CSS 占位符替换后仍残留标记");
}

// 自校验：用 JS 解析器把注入的字面量解码回来，必须与源文件逐字节一致。
// 这一步能拦住「换行被转义/未转义不一致」导致的产物语法错误（曾经真实发生过）。
const decoded = runInNewContext(quotedCss);
if (decoded !== css) {
    throw new Error(
        `CSS 内联校验失败：源 ${css.length} 字节，产物 ${decoded.length} 字节（第 ${firstDifference(css, decoded)} 字符起不同）`,
    );
}

writeFileSync(jsPath, js, "utf8");
writeFileSync(resolve(dist, "index.css"), css, "utf8");

function firstDifference(a, b) {
    const limit = Math.min(a.length, b.length);
    for (let i = 0; i < limit; i++) {
        if (a[i] !== b[i]) {
            return i;
        }
    }
    return limit;
}

/* 2) 生成可直接安装的目录 .package/<插件名>/ */
const packageName = pluginJson.name;
const stage = resolve(root, ".package", packageName);
rmSync(resolve(root, ".package"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const entry of [
    "index.js",
    "index.css",
    "plugin.json",
    "icon.png",
    "preview.png",
    "README.md",
    "README_zh_CN.md",
    "i18n",
]) {
    const from = resolve(dist, entry);
    if (!existsSync(from)) {
        continue;
    }
    cpSync(from, resolve(stage, entry), { recursive: true });
}
console.log(
    `[build] dist/index.js 已内联 CSS（${css.length} 字节）；打包目录：.package/${packageName}`,
);
