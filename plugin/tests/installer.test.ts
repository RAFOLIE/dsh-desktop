import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  ensureInstalled,
  ensureUpdated,
  ensureWebShortcut,
  pickExeAsset,
  pickExeAssetUrl, pickExeAssetMeta, routeUrl, verifyBytes,
  resolveAssetUrl,
  type InstallerDeps,
} from '../src/installer.js'
import { resolveConfig } from '../src/config.js'

const config = resolveConfig({ installDir: 'C:\\Apps\\dsh', shortcutName: 'DSH' })

function makeDeps(overrides: Partial<InstallerDeps> = {}): InstallerDeps & {
  calls: {
    mkdir: string[]
    writeFile: Array<[string, number]>
    shortcut: Array<[string, string, string]>
    renames: Array<[string, string]>
    removed: string[]
  }
} {
  const calls = {
    mkdir: [] as string[],
    writeFile: [] as Array<[string, number]>,
    shortcut: [] as Array<[string, string, string]>,
    renames: [] as Array<[string, string]>,
    removed: [] as string[],
  }
  return {
    calls,
    exists: () => false,
    mkdir: dir => { calls.mkdir.push(dir) },
    writeFile: (path, data) => { calls.writeFile.push([path, data.length]) },
    desktopDir: async () => 'C:\\Users\\A\\Desktop',
    readExeVersion: async () => '',
    rename: (from, to) => { calls.renames.push([from, to]) },
    removeFile: path => { calls.removed.push(path) },
    fetchText: async () =>
      JSON.stringify({ assets: [
        { name: 'dsh-desktop-windowos-v1.4.2.zip', browser_download_url: 'https://example/z.zip' },
        { name: 'dsh-desktop-windowos-v1.4.2.exe', browser_download_url: 'https://example/e.exe' },
      ] }),
    fetchBytes: async () => Buffer.alloc(2048),
    createShortcut: async (exe, dir, name) => { calls.shortcut.push([exe, dir, name]) },
    ...overrides,
  }
}

describe('pickExeAssetUrl', () => {
  it('picks the sole .exe asset', () => {
    const url = pickExeAssetUrl('{"assets":[{"name":"a.zip","browser_download_url":"u1"},{"name":"a.exe","browser_download_url":"u2"}]}')
    expect(url).toBe('u2')
  })

  it('throws when no exe asset exists', () => {
    expect(() => pickExeAssetUrl('{"assets":[{"name":"a.zip","browser_download_url":"u1"}]}')).toThrow()
  })
})

describe('ensureInstalled', () => {
  it('downloads when the exe is missing and creates the shortcut', async () => {
    const deps = makeDeps()
    const result = await ensureInstalled(config, deps)
    expect(result.downloaded).toBe(true)
    expect(result.shortcut).toBe(true)
    expect(result.exePath).toBe('C:\\Apps\\dsh\\dsh-desktop-windowos.exe')
    expect(deps.calls.writeFile).toEqual([[result.exePath, 2048]])
    expect(deps.calls.shortcut).toEqual([[result.exePath, 'C:\\Apps\\dsh', 'DSH']])
  })

  it('skips the download when the exe already exists', async () => {
    const deps = makeDeps({ exists: () => true, fetchText: async () => { throw new Error('must not fetch') } })
    const result = await ensureInstalled(config, deps)
    expect(result.downloaded).toBe(false)
    expect(result.shortcut).toBe(true)
    expect(deps.calls.writeFile).toEqual([])
  })

  it('omits the shortcut when disabled', async () => {
    const noShortcut = resolveConfig({ installDir: 'C:\\Apps\\dsh', createShortcut: false })
    const deps = makeDeps()
    const result = await ensureInstalled(noShortcut, deps)
    expect(result.shortcut).toBe(false)
    expect(deps.calls.shortcut).toEqual([])
  })
})

describe('ensureWebShortcut', () => {
  it('writes a .url with the web URL and the exe icon when the exe exists', async () => {
    const writes: Array<[string, string]> = []
    const deps = makeDeps({
      exists: () => true,
      writeFile: (path, data) => { writes.push([path, data.toString('utf8')]) },
    })
    const result = await ensureWebShortcut(config, deps)
    expect(result.created).toBe(true)
    expect(result.path).toBe('C:\\Users\\A\\Desktop\\DeepSeek Harness Web.url')
    expect(writes).toEqual([[
      result.path,
      '[InternetShortcut]\r\n'
      + 'URL=http://127.0.0.1:3080\r\n'
      + 'IconFile=C:\\Apps\\dsh\\dsh-desktop-windowos.exe\r\n'
      + 'IconIndex=0\r\n',
    ]])
  })

  it('omits the icon lines when the exe is missing', async () => {
    const writes: Array<[string, string]> = []
    const deps = makeDeps({
      writeFile: (path, data) => { writes.push([path, data.toString('utf8')]) },
    })
    const result = await ensureWebShortcut(config, deps)
    expect(result.created).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0][1]).not.toContain('IconFile')
    expect(writes[0][1]).toContain('URL=http://127.0.0.1:3080\r\n')
  })

  it('does nothing when disabled', async () => {
    const disabled = resolveConfig({ installDir: 'C:\\Apps\\dsh', createWebShortcut: false })
    const deps = makeDeps({ desktopDir: async () => { throw new Error('must not resolve') } })
    const result = await ensureWebShortcut(disabled, deps)
    expect(result.created).toBe(false)
    expect(result.path).toBe('')
    expect(deps.calls.writeFile).toEqual([])
  })
})

describe('pickExeAsset + compareVersions + resolveAssetUrl', () => {
  it('parses the version from the asset name', () => {
    const asset = pickExeAsset('{"assets":[{"name":"dsh-desktop-windowos-v1.5.0.exe","browser_download_url":"u"}]}')
    expect(asset).toEqual({ url: 'u', version: '1.5.0' })
  })

  it('reports an empty version for non-versioned asset names', () => {
    const asset = pickExeAsset('{"assets":[{"name":"app.exe","browser_download_url":"u"}]}')
    expect(asset.version).toBe('')
  })

  it('compares dotted versions numerically', () => {
    expect(compareVersions('1.4.2', '1.4.10')).toBeLessThan(0)
    expect(compareVersions('2.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.4', '1.4.0')).toBe(0)
  })

  it('applies the asset proxy prefix when configured', () => {
    const proxied = resolveConfig({ installDir: 'C:\\Apps\\dsh', assetProxy: 'https://ghproxy.com/' })
    expect(resolveAssetUrl(proxied, 'https://github.com/a/b')).toBe('https://ghproxy.com/https://github.com/a/b')
    expect(resolveAssetUrl(config, 'https://github.com/a/b')).toBe('https://github.com/a/b')
  })
})

describe('ensureUpdated', () => {
  it('replaces the exe when the release is newer, renaming the old aside', async () => {
    const deps = makeDeps({
      exists: () => true,
      readExeVersion: async () => '1.4.1',
      fetchText: async () =>
        JSON.stringify({ assets: [{ name: 'dsh-desktop-windowos-v1.4.2.exe', browser_download_url: 'https://example/e.exe' }] }),
    })
    const result = await ensureUpdated(config, deps)
    expect(result.updated).toBe(true)
    expect(result.fromVersion).toBe('1.4.1')
    expect(result.toVersion).toBe('1.4.2')
    expect(deps.calls.renames).toEqual([['C:\\Apps\\dsh\\dsh-desktop-windowos.exe', 'C:\\Apps\\dsh\\dsh-desktop-windowos.exe.old']])
    expect(deps.calls.writeFile.at(-1)).toEqual(['C:\\Apps\\dsh\\dsh-desktop-windowos.exe', 2048])
  })

  it('does nothing when already up to date', async () => {
    const deps = makeDeps({
      exists: () => true,
      readExeVersion: async () => '1.4.2',
    })
    const result = await ensureUpdated(config, deps)
    expect(result.updated).toBe(false)
    expect(deps.calls.renames).toEqual([])
    expect(deps.calls.writeFile).toEqual([])
  })

  it('does nothing when the exe is missing', async () => {
    const deps = makeDeps({ fetchText: async () => { throw new Error('must not fetch') } })
    const result = await ensureUpdated(config, deps)
    expect(result.updated).toBe(false)
  })

  it('does nothing when the installed version cannot be read', async () => {
    const deps = makeDeps({ exists: () => true, readExeVersion: async () => '' })
    const result = await ensureUpdated(config, deps)
    expect(result.updated).toBe(false)
  })
})

describe('download route chain and integrity', () => {
  it('routeUrl prefixes mirrors only', () => {
    expect(routeUrl({ kind: 'direct' }, 'https://github.com/a')).toBe('https://github.com/a')
    expect(routeUrl({ kind: 'proxy', url: 'http://127.0.0.1:7890' }, 'https://github.com/a')).toBe('https://github.com/a')
    expect(routeUrl({ kind: 'mirror', prefix: 'https://ghproxy.com/' }, 'https://github.com/a')).toBe('https://ghproxy.com/https://github.com/a')
  })

  it('verifyBytes enforces size and sha256 digest', () => {
    const payload = Buffer.alloc(8, 7)
    const good = 'sha256:' + createHash('sha256').update(payload).digest('hex')
    expect(verifyBytes(payload, 8, good)).toBe(true)
    expect(verifyBytes(Buffer.alloc(4), 8, good)).toBe(false)
    expect(verifyBytes(payload, 8, 'sha256:' + '0'.repeat(64))).toBe(false)
    expect(verifyBytes(payload, Number.NaN, undefined)).toBe(true)
    expect(verifyBytes(payload, 8, 'blake2b:xyz')).toBe(true)
  })

  it('pickExeAssetMeta carries size and digest from the API body', () => {
    const body = JSON.stringify({
      assets: [{
        name: 'dsh-desktop-windowos-v1.5.10.exe',
        browser_download_url: 'https://example.invalid/exe',
        size: 64,
        digest: 'sha256:' + 'a'.repeat(64),
      }],
    })
    const meta = pickExeAssetMeta(body)
    expect(meta.version).toBe('1.5.10')
    expect(meta.size).toBe(64)
    expect(meta.digest).toBe('sha256:' + 'a'.repeat(64))
  })
})
