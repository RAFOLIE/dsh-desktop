/**
 * Integration tests driving desktop_launch through the real tools pipeline
 * (ToolRuntime + system prompt), plus the pure presentation projections.
 * No model, no network: the host boundary is faked via RuntimeDeps.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import { resolveConfig } from '../src/config.js'
import { apply, buildDesktopTool, type RuntimeDeps } from '../src/runtime.js'

const releaseBody = JSON.stringify({
  assets: [
    { name: 'dsh-desktop-windowos-v1.4.5.zip', browser_download_url: 'https://example.invalid/zip' },
    { name: 'dsh-desktop-windowos-v1.4.5.exe', browser_download_url: 'https://example.invalid/exe' },
  ],
})

const config = resolveConfig({ installDir: 'C:\\Apps\\dsh', autoInstall: false })
const exePath = 'C:\\Apps\\dsh\\dsh-desktop-windowos.exe'

/** Fake host boundary recording launches and downloads. */
function makeDeps(overrides: Partial<RuntimeDeps> = {}) {
  const calls = { launches: [] as string[], downloads: [] as string[] }
  const deps: RuntimeDeps = {
    exists: () => false,
    mkdir: () => {},
    writeFile: () => {},
    desktopDir: async () => 'C:\\Users\\demo\\Desktop',
    fetchText: async () => releaseBody,
    fetchBytes: async url => {
      calls.downloads.push(url)
      return Buffer.alloc(64)
    },
    createShortcut: async () => {},
    readExeVersion: async () => '1.4.5',
    rename: () => {},
    removeFile: () => {},
    launch: path => {
      calls.launches.push(path)
    },
    ...overrides,
  }
  return { deps, calls }
}

const contexts: Context[] = []

/** Boot a real composition: system prompt -> tools runtime -> optional jobs + controller. */
async function boot(withJobs: boolean): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (withJobs) {
    await ctx.plugin(LocalJobRegistry)
    // tool-jobs attaches the job controller the registry preflights against;
    // without it background starts are refused ("no job controller").
    await ctx.plugin(toolJobs)
  }
  return ctx
}

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop()
    if (ctx !== undefined) await ctx.fiber.dispose()
  }
})

describe('desktop_launch through the real tools pipeline', () => {
  it('launches in the foreground when the exe already exists', async () => {
    const ctx = await boot(false)
    const { deps, calls } = makeDeps({ exists: () => true })
    apply(ctx, config, deps)

    const observed: string[] = []
    ctx.on('tools/result', exec => { observed.push(exec.name) })

    const result = await ctx.tools.execute({
      callId: CallId('t-foreground'),
      name: 'desktop_launch',
      arguments: {},
      signal: new AbortController().signal,
    })

    expect(calls.launches).toEqual([exePath])
    expect(calls.downloads).toEqual([])
    const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    expect(text).toContain(`launched: ${exePath}`)
    // The tools/result event fires before the execute promise settles.
    expect(observed).toContain('desktop_launch')
  })

  it('installs as a background job when the exe is missing and jobs are available', async () => {
    const ctx = await boot(true)
    const { deps, calls } = makeDeps()
    apply(ctx, config, deps)

    const result = await ctx.tools.execute({
      callId: CallId('t-background'),
      name: 'desktop_launch',
      arguments: {},
      signal: new AbortController().signal,
    })

    const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    expect(text).toContain('background')
    const jobId = /job ([^)\s.]+)/.exec(text)?.[1]
    expect(jobId).toMatch(/^desktop-\d+$/)

    const snapshot = await ctx.jobs.wait(JobId(jobId ?? ''), 10_000)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.detail).toContain('launched')
    expect(calls.downloads).toEqual(['https://example.invalid/exe'])
    expect(calls.launches).toEqual([exePath])
    const read = ctx.jobs.read(JobId(jobId ?? ''))
    expect(read.text).toContain(exePath)
  })

  it('falls back to an inline install when no jobs service is loaded', async () => {
    const ctx = await boot(false)
    const { deps, calls } = makeDeps()
    apply(ctx, config, deps)

    const result = await ctx.tools.execute({
      callId: CallId('t-fallback'),
      name: 'desktop_launch',
      arguments: {},
      signal: new AbortController().signal,
    })

    const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    expect(text).toContain(`launched: ${exePath}`)
    expect(calls.downloads).toEqual(['https://example.invalid/exe'])
    expect(calls.launches).toEqual([exePath])
  })
})

describe('desktop_launch presentation projections', () => {
  const fakeCtx = { logger: console } as unknown as Context

  it('renders the pending call as a generic execute card', () => {
    const tool = buildDesktopTool(fakeCtx, config, makeDeps().deps)
    expect(tool.presentCall?.({})).toEqual({ card: 'generic', title: '启动 DSH 桌面端', kind: 'execute' })
  })

  it('renders completed cards from replayable presentation metadata', () => {
    const tool = buildDesktopTool(fakeCtx, config, makeDeps().deps)
    const launched = tool.presentResult?.({}, {
      content: [],
      isError: false,
      meta: tool.output.presentationMeta?.({}, { status: 'launched', exePath }),
    })
    expect(launched).toMatchObject({ card: 'generic', title: '桌面端已启动' })

    const installing = tool.presentResult?.({}, {
      content: [],
      isError: false,
      meta: tool.output.presentationMeta?.({}, { status: 'installing', jobId: 'desktop-7' }),
    })
    expect(installing).toMatchObject({ card: 'generic', title: '后台安装已开始' })
  })

  it('renders model-facing text per status', () => {
    const tool = buildDesktopTool(fakeCtx, config, makeDeps().deps)
    const text = (value: unknown) =>
      tool.output.render({}, value).map(block => (block.type === 'text' ? block.text : '')).join('')
    expect(text({ status: 'launched', exePath })).toContain(exePath)
    expect(text({ status: 'installing', jobId: 'desktop-7' })).toContain('desktop-7')
    expect(text({ status: 'windows-only' })).toContain('Windows-only')
  })
})
