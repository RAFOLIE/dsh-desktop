/**
 * Idempotent install of the dsh-desktop-windowos exe plus desktop shortcut.
 * @module dsh-desktop-plugin/installer
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import type { ResolvedConfig } from './config.js'

/** Fakeable host boundary; every effect the installer can take. */
export interface InstallerDeps {
  exists(path: string): boolean
  mkdir(dir: string): void
  writeFile(path: string, data: Buffer): void
  /** Resolve the user's real desktop directory (OneDrive-redirection safe). */
  desktopDir(): Promise<string>
  /** Fetch a URL's body as JSON text (GitHub API). */
  fetchText(url: string): Promise<string>
  /** Fetch a URL's body as bytes (release asset); aborting the signal kills the download. */
  fetchBytes(url: string, signal?: AbortSignal): Promise<Buffer>
  /** Create/refresh a desktop .lnk pointing at the exe. */
  createShortcut(exePath: string, workDir: string, name: string): Promise<void>
  /** Read an exe's embedded product version, '' when unreadable. */
  readExeVersion(path: string): Promise<string>
  /** Rename/move a file (works on a running exe on Windows). */
  rename(from: string, to: string): void
  /** Best-effort delete; missing files are fine. */
  removeFile(path: string): void
}

/** Outcome of one ensureInstalled run. */
export interface InstallResult {
  exePath: string
  /** The exe was missing and has just been downloaded. */
  downloaded: boolean
  /** The desktop shortcut was created/refreshed. */
  shortcut: boolean
}

/** Outcome of one ensureUpdated run. */
export interface UpdateResult {
  exePath: string
  /** The exe was replaced with a newer release. */
  updated: boolean
  fromVersion: string
  toVersion: string
}

/** Outcome of one ensureWebShortcut run. */
export interface WebShortcutResult {
  /** Absolute path of the .url file; empty when creation is disabled. */
  path: string
  /** The web shortcut was created/refreshed. */
  created: boolean
}

/** Absolute path of the desktop exe under the configured install dir. */
export function exePathOf(config: ResolvedConfig): string {
  return `${config.installDir}\\dsh-desktop-windowos.exe`
}

/** Prefix a release-asset URL with the configured mirror when present. */
export function resolveAssetUrl(config: ResolvedConfig, url: string): string {
  return config.assetProxy === '' ? url : `${config.assetProxy}${url}`
}

/**
 * Pick the desktop exe asset (download URL + version) from a GitHub release
 * JSON body. The version comes from the `dsh-desktop-windowos-v<semver>.exe`
 * asset name; entries without a parseable version report ''.
 */
export function pickExeAsset(body: string): { url: string, version: string } {
  const release = JSON.parse(body) as { assets?: Array<{ name: string, browser_download_url: string }> }
  const asset = release.assets?.find(candidate => candidate.name.endsWith('.exe'))
  if (asset === undefined) throw new Error('latest release has no .exe asset')
  const version = /^dsh-desktop-windowos-v(\d+(?:\.\d+)*)\.exe$/.exec(asset.name)?.[1] ?? ''
  return { url: asset.browser_download_url, version }
}

/** Dot-numeric compare: negative when a<b, 0 when equal, positive when a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Single-quote escape for PowerShell string literals. */
function psQuote(value: string): string {
  return value.replaceAll('\'', '\'\'')
}

/** Production deps over node:fs, global fetch, curl, and PowerShell. */
export function nodeDeps(): InstallerDeps {
  return {
    exists: path => fs.existsSync(path),
    mkdir: dir => fs.mkdirSync(dir, { recursive: true }),
    writeFile: (path, data) => fs.writeFileSync(path, data),
    // [Environment]::GetFolderPath follows the known-desktop redirection
    // (OneDrive etc.) that a naive %USERPROFILE%\Desktop join would miss.
    desktopDir: () => new Promise((resolve, reject) => {
      const child = spawn('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], {
        windowsHide: true,
      })
      let out = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.on('error', reject)
      child.on('exit', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`desktopDir exit ${code}`))))
    }),
    // The API JSON is small and works over plain fetch.
    fetchText: async url => {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'dsh-desktop-plugin', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`)
      return response.text()
    },
    // Release assets are multi-MB; Node's fetch stalls on some networks where
    // system curl succeeds, so route the binary download through curl.exe.
    // An aborted signal kills the curl child so job cancellation is prompt.
    fetchBytes: (url, signal) => new Promise((resolve, reject) => {
      const tmp = `${process.env.TEMP ?? process.cwd()}\\dsh-desktop-download-${process.pid}-${Date.now()}.exe`
      const child = spawn('curl', [
        '--silent', '--show-error', '--location', '--fail', '--retry', '2',
        '--max-time', '150', '--user-agent', 'dsh-desktop-plugin', '--output', tmp, url,
      ], { stdio: 'ignore', windowsHide: true })
      const onAbort = () => { child.kill() }
      if (signal !== undefined && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', error => { fs.rmSync(tmp, { force: true }); reject(error) })
      child.on('exit', code => {
        signal?.removeEventListener('abort', onAbort)
        if (signal?.aborted) {
          fs.rmSync(tmp, { force: true })
          reject(new Error(`download aborted: ${url}`))
          return
        }
        if (code !== 0) {
          fs.rmSync(tmp, { force: true })
          reject(new Error(`curl exit ${code} for ${url}`))
          return
        }
        try { resolve(fs.readFileSync(tmp)) } catch (error) { reject(error) } finally { fs.rmSync(tmp, { force: true }) }
      })
    }),
    createShortcut: (exePath, workDir, name) => new Promise((resolve, reject) => {
      const script = [
        '$ws = New-Object -ComObject WScript.Shell',
        `$lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '${psQuote(name)}.lnk'))`,
        `$lnk.TargetPath = '${psQuote(exePath)}'`,
        `$lnk.WorkingDirectory = '${psQuote(workDir)}'`,
        `$lnk.IconLocation = '${psQuote(exePath)},0'`,
        '$lnk.Save()',
      ].join('\n')
      const child = spawn('powershell', ['-NoProfile', '-Command', script], {
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', reject)
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`shortcut exit ${code}`))))
    }),
    readExeVersion: path => new Promise(resolve => {
      const child = spawn('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${psQuote(path)}').VersionInfo.ProductVersion`], {
        windowsHide: true,
      })
      let out = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.on('error', () => resolve(''))
      child.on('exit', code => (code === 0 ? resolve(out.trim()) : resolve('')))
    }),
    rename: (from, to) => fs.renameSync(from, to),
    removeFile: path => fs.rmSync(path, { force: true }),
  }
}

/**
 * Pick the release asset URL for the desktop exe from a GitHub release JSON body.
 * @param body - releases/latest JSON text.
 * @returns the browser_download_url of the sole `.exe` asset.
 * @throws when the release has no exe asset.
 */
export function pickExeAssetUrl(body: string): string {
  const release = JSON.parse(body) as { assets?: Array<{ name: string, browser_download_url: string }> }
  const asset = release.assets?.find(candidate => candidate.name.endsWith('.exe'))
  if (asset === undefined) throw new Error('latest release has no .exe asset')
  return asset.browser_download_url
}

/**
 * Ensure the exe exists (downloading from the repo's latest GitHub Release
 * when missing) and the desktop shortcut points at it. Safe to re-run.
 * @param config - resolved plugin configuration.
 * @param deps - host boundary to fake in tests.
 * @param signal - cooperative cancellation for the download, when the caller owns one.
 * @returns what happened during this run.
 */
export async function ensureInstalled(config: ResolvedConfig, deps: InstallerDeps, signal?: AbortSignal): Promise<InstallResult> {
  const exePath = exePathOf(config)
  let downloaded = false
  if (!deps.exists(exePath)) {
    const body = await deps.fetchText(`https://api.github.com/repos/${config.repoSlug}/releases/latest`)
    const assetUrl = resolveAssetUrl(config, pickExeAssetUrl(body))
    const bytes = await deps.fetchBytes(assetUrl, signal)
    deps.mkdir(config.installDir)
    deps.writeFile(exePath, bytes)
    downloaded = true
  }
  let shortcut = false
  if (config.createShortcut) {
    await deps.createShortcut(exePath, config.installDir, config.shortcutName)
    shortcut = true
  }
  return { exePath, downloaded, shortcut }
}

/**
 * Ensure a desktop `.url` shortcut opens the DSH web UI in the default
 * browser, borrowing the desktop exe's icon when that exe is installed.
 * Independent of the exe download; safe to re-run.
 * @param config - resolved plugin configuration.
 * @param deps - host boundary to fake in tests.
 * @returns what happened during this run.
 */
export async function ensureWebShortcut(config: ResolvedConfig, deps: InstallerDeps): Promise<WebShortcutResult> {
  if (!config.createWebShortcut) return { path: '', created: false }
  const desktopDir = await deps.desktopDir()
  const path = `${desktopDir}\\${config.webShortcutName}.url`
  const lines = ['[InternetShortcut]', `URL=${config.webUrl}`]
  const exePath = exePathOf(config)
  if (deps.exists(exePath)) {
    lines.push(`IconFile=${exePath}`, 'IconIndex=0')
  }
  deps.writeFile(path, Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8'))
  return { path, created: true }
}

/**
 * Upgrade the installed exe when a newer GitHub Release exists. Windows
 * allows renaming a running exe, so the swap renames the old one aside and
 * writes the new in place — safe even while the app is running. Safe to
 * re-run; a missing exe is left to ensureInstalled.
 * @param config - resolved plugin configuration.
 * @param deps - host boundary to fake in tests.
 * @returns what happened during this run.
 */
export async function ensureUpdated(config: ResolvedConfig, deps: InstallerDeps): Promise<UpdateResult> {
  const exePath = exePathOf(config)
  const none: UpdateResult = { exePath, updated: false, fromVersion: '', toVersion: '' }
  if (!deps.exists(exePath)) return none
  const body = await deps.fetchText(`https://api.github.com/repos/${config.repoSlug}/releases/latest`)
  const asset = pickExeAsset(body)
  if (asset.version === '') return none
  const current = await deps.readExeVersion(exePath)
  if (current === '' || compareVersions(asset.version, current) <= 0) return none
  const bytes = await deps.fetchBytes(resolveAssetUrl(config, asset.url))
  const oldPath = `${exePath}.old`
  deps.removeFile(oldPath)
  deps.rename(exePath, oldPath)
  deps.writeFile(exePath, bytes)
  return { exePath, updated: true, fromVersion: current, toVersion: asset.version }
}
