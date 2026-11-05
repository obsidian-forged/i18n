import { PluginTranslationV1, ITheme, ValidationOptions } from "src/types";


export function validateTranslation(json: PluginTranslationV1, options: ValidationOptions = { checkFormat: true, checkVersion: true, checkTranslations: true }): boolean {
    // 自定义检查：检查整体格式
    if (options.checkFormat && (!('schemaVersion' in json) || !('metadata' in json) || !('dict' in json))) {
        console.error('译文检查: 译文字段缺失');
        return false
    }
    return true;
}


/**
 * 验证插件翻译文件是否具有有效的格式（V1版本）。
 * V1 格式使用 ast 和 regex 数组替代 dict 和 description
 * @param pluginJson - 待验证的 V1 翻译对象。
 * @returns 如果插件翻译对象存在且所有必要的属性都存在，则返回 true，否则返回 false。
 */
export const isValidPluginTranslationV1Format = (pluginJson: PluginTranslationV1 | undefined): boolean => {
    // 检查基本存在性
    if (!pluginJson) return false;
    // 检查必要的顶层属性
    const hasMetadata = 'metadata' in pluginJson;
    const hasDict = 'dict' in pluginJson && typeof pluginJson.dict === 'object' && pluginJson.dict !== null;
    const hasSchemaVersion = 'schemaVersion' in pluginJson;

    // 检查 metadata 中的属性
    let validMetadata = false;
    if (hasMetadata) {
        const m = pluginJson.metadata;
        // 简单检查几个关键字段
        validMetadata = 'plugin' in m && 'version' in m && 'language' in m;
    }
    return hasMetadata && validMetadata && hasDict && hasSchemaVersion;
};

/** 与翻译器保持一致，只将原文和译文均非空且不同的条目视为可应用内容。 */
export const hasPluginTranslationContent = (pluginJson: PluginTranslationV1 | null | undefined): boolean => {
    if (!pluginJson?.dict) return false;
    const hasTranslatedEntries = (entries: unknown): boolean => Array.isArray(entries) && entries.some(item => (
        typeof item?.source === 'string' && item.source.length > 0 &&
        typeof item.target === 'string' && item.target.length > 0 && item.target !== item.source
    ));
    return Object.values(pluginJson.dict).some(fileData => (
        hasTranslatedEntries(fileData?.ast) || hasTranslatedEntries(fileData?.regex)
    ));
};



/**
 * 验证主题翻译文件是否具有有效的格式。
 * @param themeJson - 待验证的主题翻译对象。
 * @returns 如果主题翻译对象存在且所有必要的属性都存在，则返回 true，否则返回 false。
 */
export const isValidThemeTranslationFormat = (themeJson: ITheme | undefined) => {
    // 检查主题对象是否存在
    if (!themeJson) return false;
    // 检查必要的属性是否存在
    const hasThemeManifest = 'manifest' in themeJson;
    const hasThemeTranslationVersion = hasThemeManifest && 'translationVersion' in themeJson.manifest;
    const hasThemeVersion = hasThemeManifest && 'pluginVersion' in themeJson.manifest;
    const hasThemeDict = 'dict' in themeJson;
    // 如果所有必要的属性都存在，则返回 true
    return hasThemeManifest && hasThemeTranslationVersion && hasThemeVersion && hasThemeDict;
}