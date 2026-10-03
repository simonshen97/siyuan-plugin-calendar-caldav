import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const srcDir = path.join(root, "src");

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return walk(full);
        }
        return entry.name.endsWith(".ts") ? [full] : [];
    });
}

const files = walk(srcDir);
const all = new Map(files.map((file) => [file, fs.readFileSync(file, "utf8")]));
const problems = [];

// 1) 生产代码不得引用测试/桩文件
for (const [file, text] of all) {
    if (file.includes(".test.ts") || file.includes("__mocks__")) {
        continue;
    }
    if (/from\s+["'][^"']*\.test["']/.test(text) || /__mocks__/.test(text)) {
        problems.push(`${path.relative(root, file)}: 生产代码引用了测试文件`);
    }
}

// 2) 每个相对导入都必须存在
for (const [file, text] of all) {
    for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        const candidates = [target, `${target}.ts`, path.join(target, "index.ts")];
        if (!candidates.some((candidate) => fs.existsSync(candidate))) {
            problems.push(`${path.relative(root, file)}: 找不到模块 ${match[1]}`);
        }
    }
}

// 3) 不允许遗留待办标记或占位符
for (const [file, text] of all) {
    if (/__CALENDAR_CSS_PLACEHOLDER__/.test(text) && !file.endsWith("index.ts")) {
        problems.push(`${path.relative(root, file)}: 出现意外的 CSS 占位符`);
    }
}

// 4) 检查 i18n key 是否都在语言文件中（t("...") 的调用）
const usedKeys = new Set();
for (const [file, text] of all) {
    if (file.includes(".test.ts")) {
        continue;
    }
    for (const match of text.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) {
        usedKeys.add(match[1]);
    }
}
const zh = JSON.parse(fs.readFileSync(path.join(srcDir, "i18n/zh_CN.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(srcDir, "i18n/en_US.json"), "utf8"));
for (const key of usedKeys) {
    if (!(key in zh)) {
        problems.push(`i18n: zh_CN.json 缺少键 ${key}`);
    }
    if (!(key in en)) {
        problems.push(`i18n: en_US.json 缺少键 ${key}`);
    }
}
for (const key of Object.keys(zh)) {
    if (!(key in en)) {
        problems.push(`i18n: en_US.json 缺少键 ${key}（zh_CN 中存在）`);
    }
}

// 5) 每个 TS 文件都必须被别处引用（除入口外），避免死代码
const referenced = new Set();
for (const [file, text] of all) {
    for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        referenced.add(target.endsWith(".ts") ? target : `${target}.ts`);
    }
}
for (const file of files) {
    const rel = path.relative(root, file);
    if (rel.endsWith("index.ts") || rel.includes(".test.ts") || rel.includes("__mocks__")) {
        continue;
    }
    if (!referenced.has(file)) {
        problems.push(`${rel}: 未被任何模块引用（死代码？）`);
    }
}

// 6) 打包目录结构：思源要求清单位于压缩包根或「唯一顶层目录」内
//
// 内核 `kernel/bazaar/local.go` 的 `localPackageRoot` 会检查解压结果：
//   若根目录没有清单，则要求**恰好只有一个顶层目录**，且清单就在其中。
// 扁平结构（plugin.json 与 i18n/ 并列在根）会让 Docker / 本地安装报
// 「集市包清单文件缺失」，因此这里对打包目录做前置校验。
const stageDir = path.join(root, ".package", "siyuan-plugin-calendar-caldav");
if (fs.existsSync(stageDir)) {
    const MANIFESTS = ["plugin.json", "theme.json", "icon.json", "template.json", "widget.json"];
    const dirName = path.basename(stageDir);
    if (!fs.existsSync(path.join(stageDir, "plugin.json"))) {
        problems.push("打包目录缺少 plugin.json");
    }
    for (const manifest of MANIFESTS) {
        const nested = [];
        const scan = (dir, depth) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    scan(full, depth + 1);
                } else if (manifest === entry.name && depth > 0) {
                    nested.push(path.relative(stageDir, full));
                }
            }
        };
        scan(stageDir, 0);
        if (nested.length) {
            problems.push(`打包目录中清单层级过深：${nested.join(", ")}`);
        }
    }
    const pkgJson = JSON.parse(fs.readFileSync(path.join(stageDir, "plugin.json"), "utf8"));
    if (pkgJson.name !== dirName) {
        problems.push(`打包目录名 ${dirName} 与 plugin.json 的 name ${pkgJson.name} 不一致（内核会拒绝安装）`);
    }
    if (!Array.isArray(pkgJson.backends) || !pkgJson.backends.length) {
        problems.push("plugin.json 缺少 backends（Docker 等终端将无法启用）");
    }
    if (!Array.isArray(pkgJson.frontends) || !pkgJson.frontends.length) {
        problems.push("plugin.json 缺少 frontends（浏览器 / Docker 终端将无法启用）");
    } else {
        // 思源没有 "browser" 这个前端取值（合法值：desktop / desktop-window / mobile / all）。
        // 写 "browser" 会永远匹配不上，Docker 浏览器访问时报「该插件不支持在当前终端上使用」。
        const unknown = pkgJson.frontends.filter(
            (value) => !["desktop", "desktop-window", "mobile", "all"].includes(value),
        );
        if (unknown.length) {
            problems.push(
                `plugin.json 的 frontends 含思源不认识的取值：${unknown.join(", ")}（合法值：desktop / desktop-window / mobile / all）`,
            );
        }
        if (!pkgJson.frontends.includes("all") && !pkgJson.frontends.includes("mobile")) {
            problems.push("plugin.json 的 frontends 未覆盖移动端 / 浏览器（建议使用 all）");
        }
    }
    if (Array.isArray(pkgJson.backends)) {
        const unknownBackends = pkgJson.backends.filter(
            (value) => !["windows", "linux", "darwin", "docker", "android", "ios", "all"].includes(value),
        );
        if (unknownBackends.length) {
            problems.push(`plugin.json 的 backends 含思源不认识的取值：${unknownBackends.join(", ")}`);
        }
    }
    if (!pkgJson.version) {
        problems.push("plugin.json 缺少 version");
    }
    if (!pkgJson.minAppVersion) {
        problems.push("plugin.json 缺少 minAppVersion");
    }
}

// 8) 发布包不得携带测试配置 / 凭据 / 个人数据
//
// 背景：开发时会在本地工作空间里配真实的 CalDAV 账号、授权码、数据库块 ID。
// 这些**不应**出现在发布产物里（无论是内嵌进 index.js，还是作为配置文件被打包）。
//
// 关键：只匹配「值」不匹配「词」——「授权码」「密码」这些词会正常出现在错误提示与文档里，
// 真正要抓的是「关键词后面跟着的那串值」。
const SECRET_PATTERNS = [
    {
        name: "疑似真实凭据（关键词后跟具体值）",
        re: /(授权码|authorization\s*code|app[-_]?password|密码)\s*["'`：:=]\s*["'`]([A-Za-z0-9+/=_-]{8,})["'`]/i,
    },
    {
        name: "疑似真实 CalDAV 集合地址",
        re: /(?:dav\.qq\.com|caldav\.wecom\.work)\/calendar\/[0-9A-Za-z~%]{6,}/,
    },
    { name: "疑似内网 / 真实测试主机", re: /\bscri\.top\b|:\d{4,5}\/dav\/projects\/\d/ },
    {
        name: "疑似写死的 token / 密钥名",
        re: /(?:token|apiKey|api_key|secretName|passwordSecret)\s*[:=]\s*["'`][A-Za-z0-9._-]{8,}["'`]/,
    },
];

/** 允许出现的示例 ID：界面占位提示与测试夹具里的值（并非真实配置） */
const ALLOWED_SAMPLE_IDS = new Set([
    "20240118120204-kwyzf77",
    "20240118120201-kldj15t",
    "20240118120204-w6cggab",
    "20240118120204-title01",
    "20240118120204-color01",
    "20260101120000-avavava",
]);

/**
 * 真实个人数据特征：这些是开发期从真实服务抓取到的标识。
 *
 * 教训：曾把用户的**真实 QQ 授权码**写进 `logger.test.ts` 的脱敏用例里，
 * 该文件会随仓库公开 —— 凭据一旦推送就无法收回。因此这里做全仓库扫描
 * （不只是打包目录），命中即失败。
 */
const REPO_PII_PATTERNS = [
    // 注意：敏感串必须**拼接**构造，否则本文件会被自己的规则命中
    { name: "疑似真实授权码/密码", re: new RegExp("tdfja" + "pjcdgaiciag|GwZGhRs" + "HVjjPAsg8") },
    { name: "疑似真实 QQ 邮箱号", re: new RegExp("3340" + "967238") },
    { name: "疑似真实手机号段", re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
    { name: "疑似真实企业微信 corpId", re: new RegExp("168885" + "4278435863") },
    { name: "疑似真实企业邮箱域名", re: /@(?:sky[e]\.ac\.cn|skyexmz\.wecom\.work)/ },
    { name: "疑似真实 QQ 日历集合 ID", re: /F23(?:_riOeWQ5xuWzhkEfAAC5|EFZgbnMuy|RgBlHQCFIwCNxwBeAgDG)/ },
    { name: "疑似真实服务器主机", re: new RegExp("scr" + "i\\.top") },
    { name: "疑似真实账户 ID", re: new RegExp("acct_" + "musq") },
];

// 扫描源码与文档（排除依赖与产物），这些内容都会随公开仓库发布
{
    const repoFiles = [];
    const walkRepo = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (["node_modules", "dist", ".package", ".git", ".github"].includes(entry.name)) {
                continue;
            }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walkRepo(full);
            } else if (/\.(ts|mjs|js|json|md|yml|yaml|txt)$/i.test(entry.name)) {
                repoFiles.push(full);
            }
        }
    };
    walkRepo(root);
    for (const file of repoFiles) {
        const rel = path.relative(root, file);
        const text = fs.readFileSync(file, "utf8");
        for (const { name, re } of REPO_PII_PATTERNS) {
            const hit = re.exec(text);
            if (hit) {
                problems.push(`仓库含真实个人数据/凭据：${rel} 命中「${name}」→ ${hit[0]}`);
            }
        }
    }
}

if (fs.existsSync(stageDir)) {
    const scanTargets = [];
    const collectFiles = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                collectFiles(full);
            } else {
                scanTargets.push(full);
            }
        }
    };
    collectFiles(stageDir);
    for (const file of scanTargets) {
        // 文档与图片不参与扫描（README 会正常引用示例地址与示例 ID）
        const rel = path.relative(stageDir, file);
        if (/\.(png|jpg|jpeg|gif|webp|md)$/i.test(rel)) {
            continue;
        }
        const text = fs.readFileSync(file, "utf8");
        for (const { name, re } of SECRET_PATTERNS) {
            const hit = re.exec(text);
            if (hit) {
                problems.push(`发布包疑似含测试数据：${rel} 命中「${name}」→ ${hit[0].slice(0, 80)}`);
            }
        }
        // 属性视图 ID（形如 20240118120204-kwyzf77）：逐个核对白名单，
        // 出现白名单以外的 ID 说明可能有真实配置被写死。
        for (const match of text.matchAll(/\b(20\d{12}-[0-9a-z]{7})\b/g)) {
            if (!ALLOWED_SAMPLE_IDS.has(match[1])) {
                problems.push(`发布包疑似含真实数据库块 ID：${rel} → ${match[1]}（若确为示例请加入白名单）`);
            }
        }
    }
    // 明确禁止随包分发任何配置文件
    for (const forbidden of ["settings.json", "mappings.json", "sync.json"]) {
        if (fs.existsSync(path.join(stageDir, forbidden))) {
            problems.push(`发布包不应包含运行期配置：${forbidden}（配置应保存在工作空间的 storage 中）`);
        }
    }
}

// 9) 统计
const totalLines = [...all.values()].reduce((sum, text) => sum + text.split("\n").length, 0);
console.log(`文件 ${files.length} 个，合计 ${totalLines} 行`);
console.log(`i18n 键：zh_CN ${Object.keys(zh).length} 个，en_US ${Object.keys(en).length} 个`);
if (problems.length) {
    console.log("\n发现问题：");
    for (const problem of problems) {
        console.log(" - " + problem);
    }
    process.exit(1);
}
console.log("一致性检查通过");
