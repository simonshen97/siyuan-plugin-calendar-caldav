import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginJson = JSON.parse(readFileSync(resolve(root, "plugin.json"), "utf8"));
const packageName = pluginJson.name;
const stage = resolve(root, ".package", packageName);
const outFile = resolve(root, ".package", `${packageName}.zip`);

if (!existsSync(stage)) {
    console.error("[zip] 未找到打包目录，请先运行 pnpm build");
    process.exit(1);
}

/* —— CRC32 —— */
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c;
    }
    return table;
})();

function crc32(buffer) {
    let crc = -1;
    for (let i = 0; i < buffer.length; i++) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
    const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
    const day =
        (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
    return { time, day };
}

/**
 * 打包成思源集市/本地安装都认可的 zip 结构。
 *
 * 规范（内核 `kernel/bazaar/local.go` 的 `localPackageRoot` 与仓库发布要求一致）：
 *   **清单必须位于压缩包根目录，或位于「唯一的顶层目录」内。**
 * 因此这里把所有条目都放进一个 `<插件名>/` 顶层目录：
 *
 *   siyuan-plugin-calendar-caldav/plugin.json
 *   siyuan-plugin-calendar-caldav/index.js
 *   siyuan-plugin-calendar-caldav/i18n/zh_CN.json
 *   ...
 *
 * 扁平结构（plugin.json 与 i18n/ 等并列在根）会导致内核报
 * 「marketplace package manifest must be at the archive root or its only top-level directory」，
 * 本地安装（Docker 等）尤其容易触发。
 */
function collect(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const stat = statSync(full);
        // 注意：zip 内路径分隔符必须是正斜杠，且要带上顶层目录名前缀
        const entryPath = [packageName, ...relative(stage, full).split(sep)].join("/");
        if (stat.isDirectory()) {
            out.push({ path: `${entryPath}/`, dir: true });
            collect(full, out);
        } else {
            out.push({ path: entryPath, file: full });
        }
    }
    return out;
}

const entries = collect(stage);

/* —— 打包前校验清单布局 —— */
{
    const MANIFESTS = ["plugin.json", "theme.json", "icon.json", "template.json", "widget.json"];
    const tops = new Set(entries.map((entry) => entry.path.split("/")[0]).filter(Boolean));
    const problems = [];
    if (tops.size !== 1) {
        problems.push(`压缩包根目录下必须只有一个顶层目录，当前为 ${tops.size} 个：${[...tops].join(", ")}`);
    }
    if (!entries.some((entry) => entry.path === `${packageName}/plugin.json`)) {
        problems.push(`缺少 ${packageName}/plugin.json（清单必须位于唯一顶层目录内）`);
    }
    const nested = entries.filter(
        (entry) => !entry.dir && MANIFESTS.includes(entry.path.split("/").pop() ?? "") && entry.path.split("/").length !== 2,
    );
    if (nested.length) {
        problems.push(`清单文件层级过深：${nested.map((entry) => entry.path).join(", ")}`);
    }
    // 顶层目录名必须与清单里的 name 一致（内核会校验，不一致会拒绝安装）
    const topName = [...tops][0];
    if (topName && topName !== packageName) {
        problems.push(`顶层目录名 ${topName} 与 plugin.json 的 name ${packageName} 不一致`);
    }
    if (problems.length) {
        console.error("[zip] 打包结构校验失败：");
        for (const problem of problems) {
            console.error("  - " + problem);
        }
        process.exit(1);
    }
}

const now = dosDateTime(new Date());
const locals = [];
const centrals = [];
let offset = 0;

for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.path, "utf8");
    const raw = entry.dir ? Buffer.alloc(0) : readFileSync(entry.file);
    const compressed = entry.dir ? Buffer.alloc(0) : deflateRawSync(raw, { level: 9 });
    const useStore = entry.dir || compressed.length >= raw.length;
    const data = useStore ? raw : compressed;
    const method = useStore ? 0 : 8;
    const crc = entry.dir ? 0 : crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(entry.dir ? 0x10 : 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
}

const centralBuffer = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

const stream = createWriteStream(outFile);
stream.write(Buffer.concat(locals));
stream.write(centralBuffer);
stream.write(end);
stream.end(() => {
    console.log(`[zip] 已生成 ${relative(root, outFile)}（${entries.length} 个条目）`);
});
