/**
 * Serializable configuration and schema.
 * @module dsh-desktop-plugin/config
 */
import z from '@deepseek-ai/schemastery';
/** Plugin configuration supplied by the profile composition. */
export interface Config {
    /** Download the exe and (re)create the shortcut when DSH activates. */
    autoInstall?: boolean;
    /** Create/refresh the desktop shortcut named `shortcutName`. */
    createShortcut?: boolean;
    /** Create/refresh a desktop .url shortcut that opens `webUrl` in a browser. */
    createWebShortcut?: boolean;
    /** Install directory; empty uses %LOCALAPPDATA%\Programs\dsh-desktop-windowos. */
    installDir?: string;
    /** Desktop shortcut display name (no version). */
    shortcutName?: string;
    /** Web UI desktop shortcut display name (no extension). */
    webShortcutName?: string;
    /** URL the web UI desktop shortcut opens. */
    webUrl?: string;
    /** `owner/repo` whose GitHub Releases provide the exe. */
    repoSlug?: string;
    /** Upgrade the exe when a newer GitHub Release exists (checks on activation). */
    autoUpdate?: boolean;
    /** Optional mirror prefix for release-asset downloads, e.g. `https://ghproxy.com/`. */
    assetProxy?: string;
}
/** Configuration after defaults have been resolved. */
export interface ResolvedConfig {
    autoInstall: boolean;
    createShortcut: boolean;
    createWebShortcut: boolean;
    installDir: string;
    shortcutName: string;
    webShortcutName: string;
    webUrl: string;
    repoSlug: string;
    autoUpdate: boolean;
    assetProxy: string;
}
/** Default install directory under %LOCALAPPDATA%. */
export declare function defaultInstallDir(): string;
/** Loader-visible configuration schema and defaults. */
export declare const Config: z<Config>;
/**
 * Resolve defaults for direct callers that bypass Cordis Loader.
 * @param config - Partial serialized configuration.
 * @returns Configuration with all defaults applied.
 */
export declare function resolveConfig(config?: Config): ResolvedConfig;
