/**
 * Idempotent install of the dsh-desktop-windowos exe plus desktop shortcut.
 * @module dsh-desktop-plugin/installer
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
/** Public GitHub asset mirrors (prefix + asset URL), last-resort tier for
 *  proxy-less networks; every transfer through them is verified against the
 *  API's own size/digest metadata by the caller. */
const ASSET_MIRRORS = ['https://ghproxy.com/', 'https://gh-proxy.com/', 'https://ghfast.top/'];
/** Local proxy ports worth probing (Clash/v2rayN coverage; 7897 included —
 *  a real-world case where 7890/7891 both missed). */
const LOCAL_PROXY_PORTS = ['7890', '7891', '7897', '7898', '10808', '10809'];
/** Environment proxies for the route chain, in standard precedence order. */
export function envProxies() {
    const list = [];
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
        const value = process.env[key];
        if (value !== undefined && value !== '' && !list.includes(value))
            list.push(value);
    }
    return list;
}
/** The ordered chain: direct (overseas) → env proxies → probed local ports
 *  (proxied users) → public mirrors (proxy-less blocked networks). */
export async function downloadRoutes() {
    const routes = [{ kind: 'direct' }];
    for (const url of envProxies())
        routes.push({ kind: 'proxy', url });
    const alive = await Promise.all(LOCAL_PROXY_PORTS.map(async (port) => {
        const url = `http://127.0.0.1:${port}`;
        return await proxyAlive(url) ? url : null;
    }));
    for (const url of alive) {
        if (url !== null && !envProxies().includes(url))
            routes.push({ kind: 'proxy', url });
    }
    for (const prefix of ASSET_MIRRORS)
        routes.push({ kind: 'mirror', prefix });
    return routes;
}
/** Build the URL one route actually fetches. */
export function routeUrl(route, url) {
    return route.kind === 'mirror' ? `${route.prefix}${url}` : url;
}
/** Size (+optional sha256 digest) verification for downloaded assets —
 *  what makes mirror transfers trustworthy. */
export function verifyBytes(bytes, size, digest) {
    if (Number.isFinite(size) && bytes.length !== size)
        return false;
    if (digest === undefined)
        return true;
    const hex = digest.replace(/^sha256:/, '');
    if (hex === digest)
        return true; // unknown algorithm: size-only contract
    const got = createHash('sha256').update(bytes).digest('hex');
    return got.toLowerCase() === hex.toLowerCase();
}
/** Absolute path of the desktop exe under the configured install dir. */
export function exePathOf(config) {
    return `${config.installDir}\\dsh-desktop-windowos.exe`;
}
/** Prefix a release-asset URL with the configured mirror when present. */
export function resolveAssetUrl(config, url) {
    return config.assetProxy === '' ? url : `${config.assetProxy}${url}`;
}
/**
 * Pick the desktop exe asset (download URL + version) from a GitHub release
 * JSON body. The version comes from the `dsh-desktop-windowos-v<semver>.exe`
 * asset name; entries without a parseable version report ''.
 */
export function pickExeAsset(body) {
    const meta = pickExeAssetMeta(body);
    return { url: meta.url, version: meta.version };
}
/** Same as pickExeAsset but also carries the API's size/digest metadata,
 *  which powers integrity verification for proxied and mirrored downloads. */
export function pickExeAssetMeta(body) {
    const release = JSON.parse(body);
    const asset = release.assets?.find(candidate => candidate.name.endsWith('.exe'));
    if (asset === undefined)
        throw new Error('latest release has no .exe asset');
    const version = /^dsh-desktop-windowos-v(\d+(?:\.\d+)*)\.exe$/.exec(asset.name)?.[1] ?? '';
    return {
        url: asset.browser_download_url,
        version,
        size: asset.size ?? Number.NaN,
        digest: asset.digest,
    };
}
/** Dot-numeric compare: negative when a<b, 0 when equal, positive when a>b. */
export function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0)
            return d;
    }
    return 0;
}
/** 1s TCP probe so dead proxy ports don't burn curl timeouts. */
function proxyAlive(proxy) {
    return new Promise(resolve => {
        const authority = proxy.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const idx = authority.lastIndexOf(':');
        if (idx === -1) {
            resolve(false);
            return;
        }
        const port = Number(authority.slice(idx + 1));
        if (!Number.isInteger(port) || port <= 0) {
            resolve(false);
            return;
        }
        const socket = net.connect({ host: authority.slice(0, idx), port });
        const settle = (ok) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(1000, () => settle(false));
        socket.once('connect', () => settle(true));
        socket.once('error', () => settle(false));
    });
}
/** One curl run for a route (proxy adds -x, mirror fetches prefix+url).
 *  Aborting `signal` kills the curl child so job cancellation stays prompt. */
function curlRoute(route, url, tmp, signal) {
    return new Promise((resolve, reject) => {
        const args = [
            '--silent', '--show-error', '--location', '--fail', '--retry', '1',
            '--connect-timeout', '8', '--speed-time', '30', '--speed-limit', '1024', '--max-time', '120',
            '--user-agent', 'dsh-desktop-plugin', '--output', tmp, routeUrl(route, url),
        ];
        if (route.kind === 'proxy')
            args.push('-x', route.url);
        const child = spawn('curl', args, { stdio: 'ignore', windowsHide: true });
        const onAbort = () => { child.kill(); };
        if (signal !== undefined && !signal.aborted)
            signal.addEventListener('abort', onAbort, { once: true });
        child.on('error', error => { fs.rmSync(tmp, { force: true }); reject(error); });
        child.on('exit', code => {
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) {
                fs.rmSync(tmp, { force: true });
                reject(new Error(`download aborted: ${url}`));
                return;
            }
            if (code !== 0) {
                fs.rmSync(tmp, { force: true });
                reject(new Error(`curl exit ${code} for ${url}`));
                return;
            }
            try {
                resolve(fs.readFileSync(tmp));
            }
            catch (error) {
                reject(error);
            }
            finally {
                fs.rmSync(tmp, { force: true });
            }
        });
    });
}
/** Single-quote escape for PowerShell string literals. */
function psQuote(value) {
    return value.replaceAll('\'', '\'\'');
}
/** Production deps over node:fs, global fetch, curl, and PowerShell. */
export function nodeDeps() {
    return {
        exists: path => fs.existsSync(path),
        mkdir: dir => fs.mkdirSync(dir, { recursive: true }),
        writeFile: (path, data) => fs.writeFileSync(path, data),
        // [Environment]::GetFolderPath follows the known-desktop redirection
        // (OneDrive etc.) that a naive %USERPROFILE%\Desktop join would miss.
        desktopDir: () => new Promise((resolve, reject) => {
            const child = spawn('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], {
                windowsHide: true,
            });
            let out = '';
            child.stdout.on('data', chunk => { out += chunk; });
            child.on('error', reject);
            child.on('exit', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`desktopDir exit ${code}`))));
        }),
        // The API JSON is small and works over plain fetch.
        fetchText: async (url) => {
            const response = await fetch(url, {
                headers: { 'User-Agent': 'dsh-desktop-plugin', Accept: 'application/vnd.github+json' },
                signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok)
                throw new Error(`GitHub API ${response.status} for ${url}`);
            return response.text();
        },
        // Release assets are multi-MB; Node's fetch stalls on some networks where
        // system curl succeeds. One download walks the whole route chain —
        // direct → env proxies → probed local ports → public mirrors — and the
        // optional `verify` callback (size/digest from the API) discards any
        // transfer that fails integrity so the next route is tried instead.
        fetchBytes: async (url, signal, verify) => {
            const tmp = `${process.env.TEMP ?? process.cwd()}\\dsh-desktop-download-${process.pid}-${Date.now()}.exe`;
            try {
                let firstError;
                for (const route of await downloadRoutes()) {
                    try {
                        const bytes = await curlRoute(route, url, tmp, signal);
                        if (verify === undefined || verify(bytes))
                            return bytes;
                    }
                    catch (error) {
                        if (signal?.aborted)
                            throw error;
                        firstError ??= error;
                    }
                }
                throw firstError instanceof Error ? firstError : new Error(`all download routes failed for ${url}`);
            }
            finally {
                fs.rmSync(tmp, { force: true });
            }
        },
        createShortcut: (exePath, workDir, name) => new Promise((resolve, reject) => {
            const script = [
                '$ws = New-Object -ComObject WScript.Shell',
                `$lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '${psQuote(name)}.lnk'))`,
                `$lnk.TargetPath = '${psQuote(exePath)}'`,
                `$lnk.WorkingDirectory = '${psQuote(workDir)}'`,
                `$lnk.IconLocation = '${psQuote(exePath)},0'`,
                '$lnk.Save()',
            ].join('\n');
            const child = spawn('powershell', ['-NoProfile', '-Command', script], {
                stdio: 'ignore',
                windowsHide: true,
            });
            child.on('error', reject);
            child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`shortcut exit ${code}`))));
        }),
        readExeVersion: path => new Promise(resolve => {
            const child = spawn('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${psQuote(path)}').VersionInfo.ProductVersion`], {
                windowsHide: true,
            });
            let out = '';
            child.stdout.on('data', chunk => { out += chunk; });
            child.on('error', () => resolve(''));
            child.on('exit', code => (code === 0 ? resolve(out.trim()) : resolve('')));
        }),
        rename: (from, to) => fs.renameSync(from, to),
        removeFile: path => fs.rmSync(path, { force: true }),
    };
}
/**
 * Pick the release asset URL for the desktop exe from a GitHub release JSON body.
 * @param body - releases/latest JSON text.
 * @returns the browser_download_url of the sole `.exe` asset.
 * @throws when the release has no exe asset.
 */
export function pickExeAssetUrl(body) {
    const release = JSON.parse(body);
    const asset = release.assets?.find(candidate => candidate.name.endsWith('.exe'));
    if (asset === undefined)
        throw new Error('latest release has no .exe asset');
    return asset.browser_download_url;
}
/**
 * Ensure the exe exists (downloading from the repo's latest GitHub Release
 * when missing) and the desktop shortcut points at it. Safe to re-run.
 * @param config - resolved plugin configuration.
 * @param deps - host boundary to fake in tests.
 * @param signal - cooperative cancellation for the download, when the caller owns one.
 * @returns what happened during this run.
 */
export async function ensureInstalled(config, deps, signal) {
    const exePath = exePathOf(config);
    let downloaded = false;
    if (!deps.exists(exePath)) {
        const body = await deps.fetchText(`https://api.github.com/repos/${config.repoSlug}/releases/latest`);
        const asset = pickExeAssetMeta(body);
        const assetUrl = resolveAssetUrl(config, asset.url);
        const bytes = await deps.fetchBytes(assetUrl, signal, got => verifyBytes(got, asset.size, asset.digest));
        deps.mkdir(config.installDir);
        deps.writeFile(exePath, bytes);
        downloaded = true;
    }
    let shortcut = false;
    if (config.createShortcut) {
        await deps.createShortcut(exePath, config.installDir, config.shortcutName);
        shortcut = true;
    }
    return { exePath, downloaded, shortcut };
}
/**
 * Ensure a desktop `.url` shortcut opens the DSH web UI in the default
 * browser, borrowing the desktop exe's icon when that exe is installed.
 * Independent of the exe download; safe to re-run.
 * @param config - resolved plugin configuration.
 * @param deps - host boundary to fake in tests.
 * @returns what happened during this run.
 */
export async function ensureWebShortcut(config, deps) {
    if (!config.createWebShortcut)
        return { path: '', created: false };
    const desktopDir = await deps.desktopDir();
    const path = `${desktopDir}\\${config.webShortcutName}.url`;
    const lines = ['[InternetShortcut]', `URL=${config.webUrl}`];
    const exePath = exePathOf(config);
    if (deps.exists(exePath)) {
        lines.push(`IconFile=${exePath}`, 'IconIndex=0');
    }
    deps.writeFile(path, Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8'));
    return { path, created: true };
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
export async function ensureUpdated(config, deps) {
    const exePath = exePathOf(config);
    const none = { exePath, updated: false, fromVersion: '', toVersion: '' };
    if (!deps.exists(exePath))
        return none;
    const body = await deps.fetchText(`https://api.github.com/repos/${config.repoSlug}/releases/latest`);
    const asset = pickExeAssetMeta(body);
    if (asset.version === '')
        return none;
    const current = await deps.readExeVersion(exePath);
    if (current === '' || compareVersions(asset.version, current) <= 0)
        return none;
    const bytes = await deps.fetchBytes(resolveAssetUrl(config, asset.url), undefined, got => verifyBytes(got, asset.size, asset.digest));
    const oldPath = `${exePath}.old`;
    deps.removeFile(oldPath);
    deps.rename(exePath, oldPath);
    deps.writeFile(exePath, bytes);
    return { exePath, updated: true, fromVersion: current, toVersion: asset.version };
}
