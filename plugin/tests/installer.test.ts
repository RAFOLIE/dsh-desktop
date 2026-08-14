import { describe, expect, it } from 'vitest'
import { ensureInstalled, ensureWebShortcut, pickExeAssetUrl, type InstallerDeps } from '../src/installer.js'
import { resolveConfig } from '../src/config.js'

const config = resolveConfig({ installDir: 'C:\\Apps\\dsh', shortcutName: 'DSH' })

function makeDeps(overrides: Partial<InstallerDeps> = {}): InstallerDeps & {
  calls: { mkdir: string[], writeFile: Array<[string, number]>, shortcut: Array<[string, string, string]> }
} {
  const calls = { mkdir: [] as string[], writeFile: [] as Array<[string, number]>, shortcut: [] as Array<[string, string, string]> }
  return {
    calls,
    exists: () => false,
    mkdir: dir => { calls.mkdir.push(dir) },
    writeFile: (path, data) => { calls.writeFile.push([path, data.length]) },
    desktopDir: async () => 'C:\\Users\\A\\Desktop',
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
