/**
 * Serializable configuration and schema.
 * @module dsh-desktop-plugin/config
 */
import z from '@deepseek-ai/schemastery';
/** Default install directory under %LOCALAPPDATA%. */
export function defaultInstallDir() {
    const base = process.env.LOCALAPPDATA ?? '';
    if (base === '')
        return '';
    const sep = '\\';
    return [base, 'Programs', 'dsh-desktop-windowos'].join(sep);
}
/** Loader-visible configuration schema and defaults. */
export const Config = z.object({
    autoInstall: z.boolean().default(true),
    createShortcut: z.boolean().default(true),
    installDir: z.string().default(defaultInstallDir()),
    shortcutName: z.string().default('DeepSeek Harness'),
    repoSlug: z.string().default('RAFOLIE/dsh-desktop-windowos'),
});
/**
 * Resolve defaults for direct callers that bypass Cordis Loader.
 * @param config - Partial serialized configuration.
 * @returns Configuration with all defaults applied.
 */
export function resolveConfig(config = {}) {
    return {
        autoInstall: config.autoInstall ?? true,
        createShortcut: config.createShortcut ?? true,
        installDir: config.installDir ?? defaultInstallDir(),
        shortcutName: config.shortcutName ?? 'DeepSeek Harness',
        repoSlug: config.repoSlug ?? 'RAFOLIE/dsh-desktop-windowos',
    };
}
