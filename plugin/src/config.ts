/**
 * Serializable configuration and schema.
 * @module dsh-desktop-plugin/config
 */

import z from '@deepseek-ai/schemastery'

/** Plugin configuration supplied by the profile composition. */
export interface Config {
  /** Download the exe and (re)create the shortcut when DSH activates. */
  autoInstall?: boolean
  /** Create/refresh the desktop shortcut named `shortcutName`. */
  createShortcut?: boolean
  /** Create/refresh a desktop .url shortcut that opens `webUrl` in a browser. */
  createWebShortcut?: boolean
  /** Install directory; empty uses %LOCALAPPDATA%\Programs\dsh-desktop-windowos. */
  installDir?: string
  /** Desktop shortcut display name (no version). */
  shortcutName?: string
  /** Web UI desktop shortcut display name (no extension). */
  webShortcutName?: string
  /** URL the web UI desktop shortcut opens. */
  webUrl?: string
  /** `owner/repo` whose GitHub Releases provide the exe. */
  repoSlug?: string
}

/** Configuration after defaults have been resolved. */
export interface ResolvedConfig {
  autoInstall: boolean
  createShortcut: boolean
  createWebShortcut: boolean
  installDir: string
  shortcutName: string
  webShortcutName: string
  webUrl: string
  repoSlug: string
}

/** Default install directory under %LOCALAPPDATA%. */
export function defaultInstallDir(): string {
  const base = process.env.LOCALAPPDATA ?? ''
  if (base === '') return ''
  const sep = '\\'
  return [base, 'Programs', 'dsh-desktop-windowos'].join(sep)
}

/** Loader-visible configuration schema and defaults. */
export const Config: z<Config> = z.object({
  autoInstall: z.boolean().default(true),
  createShortcut: z.boolean().default(true),
  createWebShortcut: z.boolean().default(true),
  installDir: z.string().default(defaultInstallDir()),
  shortcutName: z.string().default('DeepSeek Harness'),
  webShortcutName: z.string().default('DeepSeek Harness Web'),
  webUrl: z.string().default('http://127.0.0.1:3080'),
  repoSlug: z.string().default('RAFOLIE/dsh-desktop-windowos'),
})

/**
 * Resolve defaults for direct callers that bypass Cordis Loader.
 * @param config - Partial serialized configuration.
 * @returns Configuration with all defaults applied.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  return {
    autoInstall: config.autoInstall ?? true,
    createShortcut: config.createShortcut ?? true,
    createWebShortcut: config.createWebShortcut ?? true,
    installDir: config.installDir ?? defaultInstallDir(),
    shortcutName: config.shortcutName ?? 'DeepSeek Harness',
    webShortcutName: config.webShortcutName ?? 'DeepSeek Harness Web',
    webUrl: config.webUrl ?? 'http://127.0.0.1:3080',
    repoSlug: config.repoSlug ?? 'RAFOLIE/dsh-desktop-windowos',
  }
}
