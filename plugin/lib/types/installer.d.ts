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
    /** Fetch a URL's body as bytes (release asset); aborting the signal kills the download. */
    fetchBytes(url: string, signal?: AbortSignal): Promise<Buffer>;
    /** Create/refresh a desktop .lnk pointing at the exe. */
    createShortcut(exePath: string, workDir: string, name: string): Promise<void>;
    /** Read an exe's embedded product version, '' when unreadable. */
    readExeVersion(path: string): Promise<string>;
    /** Rename/move a file (works on a running exe on Windows). */
    rename(from: string, to: string): void;
    /** Best-effort delete; missing files are fine. */
    removeFile(path: string): void;
}
/** Outcome of one ensureInstalled run. */
export interface InstallResult {
    exePath: string;
    /** The exe was missing and has just been downloaded. */
    downloaded: boolean;
    /** The desktop shortcut was created/refreshed. */
    shortcut: boolean;
}
/** Outcome of one ensureUpdated run. */
export interface UpdateResult {
    exePath: string;
    /** The exe was replaced with a newer release. */
    updated: boolean;
    fromVersion: string;
    toVersion: string;
}
/** Outcome of one ensureWebShortcut run. */
export interface WebShortcutResult {
    /** Absolute path of the .url file; empty when creation is disabled. */
    path: string;
    /** The web shortcut was created/refreshed. */
    created: boolean;
}
/** Absolute path of the desktop exe under the configured install dir. */
export declare function exePathOf(config: ResolvedConfig): string;
/** Prefix a release-asset URL with the configured mirror when present. */
export declare function resolveAssetUrl(config: ResolvedConfig, url: string): string;
/**
 * Pick the desktop exe asset (download URL + version) from a GitHub release
 * JSON body. The version comes from the `dsh-desktop-windowos-v<semver>.exe`
 * asset name; entries without a parseable version report ''.
 */
export declare function pickExeAsset(body: string): {
    url: string;
    version: string;
};
/** Dot-numeric compare: negative when a<b, 0 when equal, positive when a>b. */
export declare function compareVersions(a: string, b: string): number;
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
 * @param signal - cooperative cancellation for the download, when the caller owns one.
 * @returns what happened during this run.
 */
export declare function ensureInstalled(config: ResolvedConfig, deps: InstallerDeps, signal?: AbortSignal): Promise<InstallResult>;
/**
 * Ensure a desktop `.url` shortcut opens the DSH web UI in the default
 * browser, borrowing the desktop exe's icon when that exe is installed.
 * Independent of the exe download; safe to re-run.
 * @param config - resolved plugin configuration.
 * @param deps - host boundary to fake in tests.
 * @returns what happened during this run.
 */
export declare function ensureWebShortcut(config: ResolvedConfig, deps: InstallerDeps): Promise<WebShortcutResult>;
/**
 * Upgrade the installed exe when a newer GitHub Release exists. Windows
 * allows renaming a running exe, so the swap renames the old one aside and
 * writes the new in place — safe even while the app is running. Safe to
 * re-run; a missing exe is left to ensureInstalled.
 * @param config - resolved plugin configuration.
 * @param deps - host boundary to fake in tests.
 * @returns what happened during this run.
 */
export declare function ensureUpdated(config: ResolvedConfig, deps: InstallerDeps): Promise<UpdateResult>;
