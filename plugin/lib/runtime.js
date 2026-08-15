/**
 * Cordis activation: auto-install on load plus the desktop_launch tool.
 * @module dsh-desktop-plugin/runtime
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveConfig } from './config.js';
import { ensureInstalled, ensureUpdated, ensureWebShortcut, exePathOf, nodeDeps } from './installer.js';
import { launchDesktop } from './launcher.js';
/** Production deps: node effects plus the detached launcher. */
export function runtimeDeps() {
    return {
        ...nodeDeps(),
        launch: exePath => {
            launchDesktop(exePath);
        },
    };
}
// Output schema is inlined in defineTool so its literals keep their narrow
// types for InferValue; requiredness is per-property in the ValueSchemaSpec DSL.
/**
 * Producer for the background install job: download the exe, refresh the
 * shortcuts, then auto-launch. Cancellation is cooperative — aborting kills
 * the in-flight curl download and skips the launch.
 */
function startInstallJob(config, deps, logger) {
    const abort = new AbortController();
    let milestone = 'starting install';
    const done = (async () => {
        try {
            milestone = 'downloading exe from GitHub Releases';
            const result = await ensureInstalled(config, deps, abort.signal);
            milestone = 'creating desktop shortcuts';
            await ensureWebShortcut(config, deps)
                .catch(error => { logger.warn(`dsh-desktop-plugin: web shortcut failed: ${String(error)}`); });
            if (abort.signal.aborted)
                return { status: 'killed', detail: 'cancelled before launch' };
            milestone = `launching ${result.exePath}`;
            deps.launch(result.exePath);
            return {
                status: 'completed',
                detail: result.downloaded ? 'installed and launched' : 'exe already present; launched',
                output: `DSH desktop app installed and launched: ${result.exePath}`,
            };
        }
        catch (error) {
            if (abort.signal.aborted)
                return { status: 'killed', detail: 'cancelled during install' };
            logger.warn(`dsh-desktop-plugin: background install failed: ${String(error)}`);
            return { status: 'failed', detail: String(error) };
        }
    })();
    return {
        cancel: () => { abort.abort('cancelled'); },
        done,
        readOutput: () => milestone,
    };
}
/**
 * Build the desktop_launch tool definition. Split from apply so tests can
 * drive the presentation projections without a running registry.
 * @param ctx - Plugin context; used for the logger and the optional jobs service.
 * @param config - Resolved plugin configuration.
 * @param deps - Host boundary to fake in tests.
 */
export function buildDesktopTool(ctx, config, deps) {
    const logger = ctx.logger;
    return defineTool({
        name: 'desktop_launch',
        description: 'Launch the DSH desktop app (dsh-desktop-windowos, a Windows tray shell around the webchat). '
            + 'When the exe is missing it is installed first — normally as a background job (poll job_output with the returned jobId; '
            + 'the app launches automatically when the install finishes), or inline when background jobs are unavailable. '
            + 'Installs into %LOCALAPPDATA%\\Programs\\dsh-desktop-windowos and creates/refreshes the desktop shortcut '
            + 'plus a "DeepSeek Harness Web" .url shortcut that opens the web UI. '
            + 'Use when the user wants to open or install the desktop app.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                properties: {
                    status: {
                        type: 'string',
                        enum: ['launched', 'installing', 'windows-only'],
                        required: true,
                        description: 'Outcome of this call.',
                    },
                    exePath: { type: 'string', description: 'Absolute path of the launched exe (status=launched).' },
                    jobId: { type: 'string', description: 'Background job id to poll with job_list/job_output (status=installing).' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                if (v.status === 'launched')
                    return [{ type: 'text', text: `DSH desktop app launched: ${v.exePath}` }];
                if (v.status === 'installing') {
                    return [{
                            type: 'text',
                            text: `Install started in background (job ${v.jobId}). Poll job_output/job_list for progress; `
                                + 'the app launches automatically when the install finishes.',
                        }];
                }
                return [{ type: 'text', text: 'DSH desktop app is Windows-only; not launched.' }];
            },
            presentationMeta: (_args, value) => value,
        },
        timeoutMs: 300_000,
        presentCall: () => ({ card: 'generic', title: '启动 DSH 桌面端', kind: 'execute' }),
        presentResult: (_args, result) => {
            const meta = result.meta;
            if (meta === undefined)
                return undefined;
            if (meta.status === 'launched') {
                return { card: 'generic', title: '桌面端已启动', content: [{ type: 'text', text: meta.exePath }] };
            }
            if (meta.status === 'installing') {
                return { card: 'generic', title: '后台安装已开始', content: [{ type: 'text', text: `job ${meta.jobId} · 完成后自动启动` }] };
            }
            return { card: 'generic', title: '仅支持 Windows', content: [{ type: 'text', text: 'DSH 桌面端仅支持 Windows。' }] };
        },
        async execute(_args, exec) {
            if (process.platform !== 'win32') {
                return { status: 'windows-only' };
            }
            const exePath = exePathOf(config);
            if (deps.exists(exePath)) {
                // Self-heal the web shortcut too, but never block the launch on it.
                await ensureWebShortcut(config, deps)
                    .catch(error => { logger.warn(`dsh-desktop-plugin: web shortcut failed: ${String(error)}`); });
                deps.launch(exePath);
                return { status: 'launched', exePath };
            }
            // The jobs service is optional in minimal compositions; ctx.jobs is
            // undefined there and the install falls back to the inline path below.
            if (config.backgroundInstall && ctx.jobs !== undefined) {
                try {
                    const jobId = ctx.jobs.start({
                        kind: 'desktop',
                        label: 'install + launch dsh-desktop-windowos',
                        ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
                        run: () => startInstallJob(config, deps, logger),
                    });
                    return { status: 'installing', jobId };
                }
                catch (error) {
                    // E.g. no job controller serves this composition (dsh-tool-jobs not
                    // loaded) — the registry refuses the start, so install inline.
                    logger.warn(`dsh-desktop-plugin: background install unavailable (${String(error)}); installing inline`);
                }
            }
            // Foreground fallback: couple the cooperative install to the caller's
            // cancellation signal so an aborted call stops the download.
            const abort = new AbortController();
            const onAbort = () => { abort.abort(exec.signal.reason); };
            exec.signal.addEventListener('abort', onAbort, { once: true });
            try {
                const result = await ensureInstalled(config, deps, abort.signal);
                await ensureWebShortcut(config, deps)
                    .catch(error => { logger.warn(`dsh-desktop-plugin: web shortcut failed: ${String(error)}`); });
                deps.launch(result.exePath);
                return { status: 'launched', exePath: result.exePath };
            }
            finally {
                exec.signal.removeEventListener('abort', onAbort);
            }
        },
    });
}
/**
 * Apply the plugin to its Cordis context.
 * @param ctx - Scoped plugin context; the tool registration is owned by it.
 * @param config - Configuration resolved by Cordis from the exported schema.
 * @param deps - Host boundary; production effects by default, fakes in tests.
 */
export function apply(ctx, config, deps = runtimeDeps()) {
    const resolved = resolveConfig(config);
    const logger = ctx.logger;
    if (process.platform !== 'win32') {
        logger.info('dsh-desktop-plugin: non-Windows host, staying idle');
    }
    else if (resolved.autoInstall) {
        // Install runs detached from activation so a slow or failing download
        // never blocks DSH startup; the tool re-runs it on demand.
        void ensureInstalled(resolved, deps)
            .then(result => {
            logger.info(`dsh-desktop-plugin: exe ready at ${result.exePath}`
                + `${result.downloaded ? ' (downloaded)' : ''}${result.shortcut ? ', shortcut refreshed' : ''}`);
        })
            .catch(error => { logger.warn(`dsh-desktop-plugin: install failed: ${String(error)}`); })
            // Upgrade check after install settles; the rename-aside swap is safe
            // even while the app is running.
            .then(() => (resolved.autoUpdate
            ? ensureUpdated(resolved, deps)
                .then(update => {
                if (update.updated)
                    logger.info(`dsh-desktop-plugin: exe upgraded ${update.fromVersion} -> ${update.toVersion}`);
            })
                .catch(error => { logger.warn(`dsh-desktop-plugin: update check failed: ${String(error)}`); })
            : undefined))
            // The web .url shortcut is independent of the exe download; run it
            // after install settles so the exe icon is available whenever possible.
            .finally(() => ensureWebShortcut(resolved, deps)
            .then(web => {
            if (web.created)
                logger.info(`dsh-desktop-plugin: web shortcut ready at ${web.path}`);
        })
            .catch(error => { logger.warn(`dsh-desktop-plugin: web shortcut failed: ${String(error)}`); }));
    }
    ctx.tools.register(buildDesktopTool(ctx, resolved, deps));
}
