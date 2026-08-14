/**
 * Idempotent install of the dsh-desktop-windowos exe plus desktop shortcut.
 * @module dsh-desktop-plugin/installer
 */
import type { ResolvedConfig } from './config.js';
/** Fakeable host boundary; every effect the installer can take. */
export interface InstallerDeps {
    exists(path: string): boolean;
    mkdir(dir: string): void;
    writeFile(path: string, data: Buffer): void;
    /** Resolve the user's real desktop directory (OneDrive-redirection safe). */
    desktopDir(): Promise<string>;
    /** Fetch a URL's body as JSON text (GitHub API). */
    fetchText(url: string): Promise<string>;
    /** Fetch a URL's body as bytes (release asset). */
    fetchBytes(url: string): Promise<Buffer>;
    /** Create/refresh a desktop .lnk pointing at the exe. */
    createShortcut(exePath: string, workDir: string, name: string): Promise<void>;
}
/** Outcome of one ensureInstalled run. */
export interface InstallResult {
    exePath: string;
    /** The exe was missing and has just been downloaded. */
    downloaded: boolean;
    /** The desktop shortcut was created/refreshed. */
    shortcut: boolean;
}
/** Outcome of one ensureWebShortcut run. */
export interface WebShortcutResult {
    /** Absolute path of the .url file; empty when creation is disabled. */
    path: string;
    /** The web shortcut was created/refreshed. */
    created: boolean;
}
/** Production deps over node:fs, global fetch, curl, and PowerShell. */
export declare function nodeDeps(): InstallerDeps;
/**
 * Pick the release asset URL for the desktop exe from a GitHub release JSON body.
 * @param body - releases/latest JSON text.
 * @returns the browser_download_url of the sole `.exe` asset.
 * @throws when the release has no exe asset.
 */
export declare function pickExeAssetUrl(body: string): string;
/**
 * Ensure the exe exists (downloading from the repo's latest GitHub Release
 * when missing) and the desktop shortcut points at it. Safe to re-run.
 * @param config - resolved plugin configuration.
 * @param deps - host boundary to fake in tests.
 * @returns what happened during this run.
 */
export declare function ensureInstalled(config: ResolvedConfig, deps: InstallerDeps): Promise<InstallResult>;
/**
 * Ensure a desktop `.url` shortcut opens the DSH web UI in the default
 * browser, borrowing the desktop exe's icon when that exe is installed.
 * Independent of the exe download; safe to re-run.
 * @param config - resolved plugin configuration.
 * @param deps - host boundary to fake in tests.
 * @returns what happened during this run.
 */
export declare function ensureWebShortcut(config: ResolvedConfig, deps: InstallerDeps): Promise<WebShortcutResult>;
