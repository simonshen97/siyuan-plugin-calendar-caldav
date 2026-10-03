import zhCN from "../i18n/zh_CN.json";
import enUS from "../i18n/en_US.json";

const dicts: Record<string, Record<string, string>> = {
    zh_CN: zhCN as Record<string, string>,
    en_US: enUS as Record<string, string>,
};

export type TI18nKey = keyof typeof zhCN;

let current: Record<string, string> = dicts.zh_CN;

/** 由插件在 onload 时调用，language 取自思源前端设置（如 zh_CN、en_US） */
export function setLanguage(language: string | undefined): void {
    if (!language) {
        return;
    }
    const normalized = language.replace("-", "_");
    current = dicts[normalized] ?? dicts[normalized.split("_")[0]] ?? dicts.en_US;
}

/** 取翻译文本；支持 `{name}` 占位符替换 */
export function t(key: TI18nKey | string, params?: Record<string, string | number>): string {
    const raw = current[key] ?? dicts.zh_CN[key] ?? String(key);
    if (!params) {
        return raw;
    }
    return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    );
}

export function currentLanguage(): string {
    return current === dicts.en_US ? "en_US" : "zh_CN";
}
