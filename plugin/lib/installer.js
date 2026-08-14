/**
 * Idempotent install of the dsh-desktop-windowos exe plus desktop shortcut.
 * @module dsh-desktop-plugin/installer
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
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
        // system curl succeeds, so route the binary download through curl.exe.
        fetchBytes: url => new Promise((resolve, reject) => {
            const tmp = `${process.env.TEMP ?? process.cwd()}\\dsh-desktop-download-${process.pid}-${Date.now()}.exe`;
            const child = spawn('curl', [
                '--silent', '--show-error', '--location', '--fail', '--retry', '2',
                '--max-time', '150', '--user-agent', 'dsh-desktop-plugin', '--output', tmp, url,
            ], { stdio: 'ignore', windowsHide: true });
            child.on('error', error => { fs.rmSync(tmp, { force: true }); reject(error); });
            child.on('exit', code => {
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
        }),
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
 * @returns what happened during this run.
 */
export async function ensureInstalled(config, deps) {
    const exePath = `${config.installDir}\\dsh-desktop-windowos.exe`;
    let downloaded = false;
    if (!deps.exists(exePath)) {
        const body = await deps.fetchText(`https://api.github.com/repos/${config.repoSlug}/releases/latest`);
        const assetUrl = pickExeAssetUrl(body);
        const bytes = await deps.fetchBytes(assetUrl);
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
    const exePath = `${config.installDir}\\dsh-desktop-windowos.exe`;
    if (deps.exists(exePath)) {
        lines.push(`IconFile=${exePath}`, 'IconIndex=0');
    }
    deps.writeFile(path, Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8'));
    return { path, created: true };
}
