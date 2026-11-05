import { App, PluginManifest } from 'obsidian';
import * as path from 'path';
import * as fs from 'fs-extra';
import I18N from '../main';
import { loadTranslationFile } from '../manager/io-manager';
import type { BackupSession } from './backup-manager';
import { t } from '../locales';
import { hasPluginTranslationContent } from '../utils/data/validation';

export class InjectorManager {
    private i18n: I18N;

    constructor(i18n: I18N) {
        this.i18n = i18n;
    }

    /**
     * 自动更新翻译 (注入器)
     */
    public async run(app: App) {
        if (this.i18n.settings.automaticUpdate) {
            let plugins: PluginManifest[] = [];

            // @ts-ignore
            plugins = Object.values(app.plugins.manifests).filter(item => item.id !== 'i18n');
            let updateitem = 0;

            for (const plugin of plugins) {
                const state = this.i18n.stateManager.getPluginState(plugin.id);
                if (state && state.isApplied && plugin.version != state.pluginVersion) {
                    const success = await this.applyToPlugin(plugin.id);
                    if (success) updateitem++;
                }
            }

            // Check themes
            try {
                // @ts-ignore
                const basePath = this.i18n.app.vault.adapter.getBasePath ? path.normalize(this.i18n.app.vault.adapter.getBasePath()) : '';
                if (basePath) {
                    const themesDir = path.join(basePath, this.i18n.app.vault.configDir, 'themes');
                    if (fs.existsSync(themesDir)) {
                        const entries = fs.readdirSync(themesDir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (!entry.isDirectory()) continue;
                            const themeId = entry.name;
                            const manifestPath = path.join(themesDir, themeId, 'manifest.json');
                            let currentVersion = '0.0.0';
                            if (fs.existsSync(manifestPath)) {
                                try {
                                    const themeManifest = fs.readJsonSync(manifestPath);
                                    if (themeManifest && themeManifest.version) {
                                        currentVersion = themeManifest.version;
                                    }
                                } catch (e) { }
                            }
                            const state = this.i18n.stateManager.getThemeState(themeId);
                            if (state && state.isApplied && currentVersion !== state.pluginVersion) {
                                const success = await this.applyToTheme(themeId);
                                if (success) updateitem++;
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('[i18n] Failed to check theme updates', error);
            }

            if (updateitem > 0) {
                this.i18n.notice.successPrefix(t('Settings.Basis.SmartTitle'), `${t('Settings.Basis.SmartUpdate')}${updateitem}${t('Settings.Basis.SmartPlugins')}`);
            }
        }

        await this.i18n.stateManager.validateVersions(app);
    }

    /**
     * 对单个插件应用当前激活的翻译 (注入)
     * @param pluginId 插件ID
     * @returns 
     */
    public async applyToPlugin(pluginId: string): Promise<boolean> {
        return this.i18n.backupManager.withBackupSession(pluginId, backup => this.applyPluginWithBackup(pluginId, backup));
    }

    private async applyPluginWithBackup(pluginId: string, backup: BackupSession): Promise<boolean> {
        // @ts-ignore
        const plugin = this.i18n.app.plugins.manifests[pluginId];
        if (!plugin) return false;

        // @ts-ignore
        const pluginDir = path.join(path.normalize(this.i18n.app.vault.adapter.getBasePath()), plugin.dir ?? '');

        try {
            // 1. 获取翻译器
            const astTranslator = this.i18n.coreManager.getAstTranslator();
            const regexTranslator = this.i18n.coreManager.getRegexTranslator();

            // 2. 读取译文
            const translationPath = this.i18n.sourceManager.getActiveSourcePath(plugin.id);
            if (!translationPath) return false;
            const translationJson = loadTranslationFile(translationPath);
            if (!hasPluginTranslationContent(translationJson)) return false;

            // 3. 基础备份 (如果尚未备份)
            // 注意：这里的备份是指对目标插件源码的备份，防止搞坏
            const files = Object.keys(translationJson.dict);
            const backedUp = await backup.createBackup(pluginDir, files);
            if (!backedUp) {
                throw new Error(t('Manager.Common.Errors.BackupFailed'));
            }

            // 4. 先准备全部文件，任何备份读取或翻译失败都不写入目标文件。
            const newContents: Record<string, string> = {};
            for (const [file, dict] of Object.entries(translationJson.dict as Record<string, any>)) {
                const targetFilePath = path.join(pluginDir, file);
                if (!fs.existsSync(targetFilePath)) continue;

                // 优先从备份读取原始内容，确保翻译是基于原始代码而非已翻译代码
                let fileString = await backup.getBackupContent(file, pluginDir);
                if (fileString === null) throw new Error(t('Manager.Common.Errors.BackupFailed'));

                // 应用 AST
                if (dict.ast && dict.ast.length > 0) {
                    const ast = astTranslator.loadCode(fileString);
                    if (ast) {
                        fileString = astTranslator.translate(ast, dict.ast);
                    }
                }

                // 应用 Regex
                if (dict.regex && dict.regex.length > 0) {
                    fileString = regexTranslator.translate(fileString, dict.regex);
                }

                newContents[targetFilePath] = fileString;
            }

            // 5. 写入文件
            for (const [targetFilePath, content] of Object.entries(newContents)) {
                fs.writeFileSync(targetFilePath, content);
            }

            // 6. 更新状态文件
            this.i18n.stateManager.setPluginState(plugin.id, {
                id: plugin.id,
                isApplied: true,
                pluginVersion: plugin.version,
                translationVersion: translationJson.metadata?.version || '0.0.0'
            });

            // 7. 重启插件与健康检查
            // @ts-ignore
            const wasEnabled = this.i18n.app.plugins.enabledPlugins.has(plugin.id);
            if (wasEnabled) {
                // @ts-ignore
                await this.i18n.app.plugins.disablePlugin(plugin.id);

                try {
                    // @ts-ignore
                    await this.i18n.app.plugins.enablePlugin(plugin.id);

                    // 二次验证：检查插件是否真的起来了且被系统记录为开启
                    // @ts-ignore
                    if (!this.i18n.app.plugins.enabledPlugins.has(plugin.id)) {
                        throw new Error('Plugin failed to load after injection (not in enabledPlugins list)');
                    }
                    console.log(`[i18n] Successfully injected and reloaded: ${pluginId}`);
                } catch (loadError) {
                    console.warn(`[i18n] Health check failed for ${pluginId}, triggering automatic rollback...`);

                    // 立即还原备份
                    const restored = await backup.restoreBackup(pluginDir);
                    if (!restored) {
                        throw new Error(t('Manager.Common.Errors.RestoreFailed'));
                    }
                    this.i18n.stateManager.deletePluginState(plugin.id);

                    // 尝试重启原始版本
                    try {
                        // @ts-ignore
                        await this.i18n.app.plugins.enablePlugin(plugin.id);
                        // @ts-ignore
                        if (!this.i18n.app.plugins.enabledPlugins.has(plugin.id)) {
                            throw new Error(t('Manager.Common.Errors.RestoredReloadFailed'));
                        }
                    } catch (restoreError) {
                        console.error(`[i18n] Failed to reload restored plugin ${pluginId}:`, restoreError);
                        this.i18n.notice.error(t('Manager.Common.Errors.RestoredReloadFailed'));
                        return false;
                    }
                    this.i18n.notice.warning(t('Manager.Common.Notices.RollbackSuccess', { id: pluginId }));

                    // 向外抛出特定错误，以便 UI 或 AutoManager 能标识为已回退状态
                    throw new Error('ROLLBACK_TRIGGERED');
                }
            } else {
                console.log(`[i18n] Injected but plugin is disabled: ${pluginId}`);
            }

            return true;
        } catch (error) {
            if (error.message === 'ROLLBACK_TRIGGERED') {
                throw error; // 向上抛出，以便 AutoManager 捕获并显示回退状态
            }
            console.error(`[i18n] Failed to inject translation to ${pluginId}:`, error);
            return false;
        }
    }

    /**
     * 对单个主题应用当前激活的翻译 (注入)
     * @param themeId 主题ID
     * @returns 
     */
    public async applyToTheme(themeId: string): Promise<boolean> {
        return this.i18n.backupManager.withBackupSession(themeId, backup => this.applyThemeWithBackup(themeId, backup));
    }

    private async applyThemeWithBackup(themeId: string, backup: BackupSession): Promise<boolean> {
        // @ts-ignore
        const basePath = path.normalize(this.i18n.app.vault.adapter.getBasePath());
        const themeDir = path.join(basePath, this.i18n.app.vault.configDir, 'themes', themeId);
        const themeCssPath = path.join(themeDir, 'theme.css');

        if (!fs.existsSync(themeCssPath)) return false;

        try {
            // Read manifest 
            let themeVersion = '0.0.0';
            const manifestPath = path.join(themeDir, 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                try {
                    const manifest = fs.readJsonSync(manifestPath);
                    if (manifest && manifest.version) themeVersion = manifest.version;
                } catch (e) { }
            }

            // Read translation
            // @ts-ignore
            const translationPath = this.i18n.sourceManager.getActiveSourcePath(themeId);
            if (!translationPath) return false;
            const translationJson = loadTranslationFile(translationPath);
            if (!translationJson || !translationJson.dict) return false;

            // Backup
            const backedUp = await backup.createBackup(themeDir, ['theme.css']);
            if (!backedUp) {
                throw new Error(t('Manager.Common.Errors.BackupFailed'));
            }

            let cssStr = await backup.getBackupContent('theme.css', themeDir);
            if (cssStr === null) throw new Error(t('Manager.Common.Errors.BackupFailed'));

            cssStr = cssStr.replace(/\/\* @settings([\s\S]*?)\*\//g, (match, blockContent) => {
                let newBlockContent = blockContent;

                for (const item of translationJson.dict as any[]) {
                    const type = item.type;
                    const source = item.source;
                    const target = item.target;

                    if (source && target && source !== target) {
                        const escapedSource = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const replacerRegex = new RegExp(`^([ \\t]*)(${type}):\\s*(["']?)${escapedSource}\\3[ \\t]*(?:\\r?\\n|$)`, 'gm');

                        newBlockContent = newBlockContent.replace(replacerRegex, (fullMatch: string, indent: string, key: string, quote: string) => {
                            return `${indent}${key}: ${quote}${target}${quote}\n`;
                        });
                    }
                }
                return `/* @settings${newBlockContent}*/`;
            });

            fs.writeFileSync(themeCssPath, cssStr);

            const version = translationJson.metadata?.version || '1.0.0';
            this.i18n.stateManager.setThemeState(themeId, {
                id: themeId,
                isApplied: true,
                pluginVersion: themeVersion,
                translationVersion: String(version)
            });

            console.log(`[i18n] Successfully injected theme: ${themeId}`);

            return true;
        } catch (error) {
            console.error(`[i18n] Failed to inject translation to ${themeId}:`, error);
            return false;
        }
    }
}
