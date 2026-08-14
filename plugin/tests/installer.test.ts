import { describe, expect, it } from 'vitest'
import { ensureInstalled, pickExeAssetUrl, type InstallerDeps } from '../src/installer.js'
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
