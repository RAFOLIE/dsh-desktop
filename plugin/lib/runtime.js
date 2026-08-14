/**
 * Cordis activation: auto-install on load plus the desktop_launch tool.
 * @module dsh-desktop-plugin/runtime
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveConfig } from './config.js';
import { ensureInstalled, ensureWebShortcut, nodeDeps } from './installer.js';
import { launchDesktop } from './launcher.js';
/**
 * Apply the plugin to its Cordis context.
 * @param ctx - Scoped plugin context; the tool registration is owned by it.
 * @param config - Configuration resolved by Cordis from the exported schema.
 */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const logger = ctx.logger;
    if (process.platform !== 'win32') {
        logger.info('dsh-desktop-plugin: non-Windows host, staying idle');
    }
    else if (resolved.autoInstall) {
        // Install runs detached from activation so a slow or failing download
        // never blocks DSH startup; the tool re-runs it on demand.
        void ensureInstalled(resolved, nodeDeps())
            .then(result => {
            logger.info(`dsh-desktop-plugin: exe ready at ${result.exePath}`
                + `${result.downloaded ? ' (downloaded)' : ''}${result.shortcut ? ', shortcut refreshed' : ''}`);
        })
            .catch(error => { logger.warn(`dsh-desktop-plugin: install failed: ${String(error)}`); })
            // The web .url shortcut is independent of the exe download; run it
            // after install settles so the exe icon is available whenever possible.
            .finally(() => ensureWebShortcut(resolved, nodeDeps())
            .then(web => {
            if (web.created)
                logger.info(`dsh-desktop-plugin: web shortcut ready at ${web.path}`);
        })
            .catch(error => { logger.warn(`dsh-desktop-plugin: web shortcut failed: ${String(error)}`); }));
    }
    ctx.tools.register(defineTool({
        name: 'desktop_launch',
        description: 'Launch the DSH desktop app (dsh-desktop-windowos, a Windows tray shell around the webchat). '
            + 'Installs it first when missing: downloads the exe from GitHub Releases into %LOCALAPPDATA%\\Programs\\dsh-desktop-windowos '
            + 'and creates/refreshes the desktop shortcut plus a "DeepSeek Harness Web" .url shortcut that opens the web UI. '
            + 'Use when the user wants to open or install the desktop app.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                properties: {
                    launched: { type: 'boolean', description: 'Whether the desktop app was started.' },
                    exePath: { type: 'string', description: 'Absolute path of the launched exe.' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `DSH desktop app ${value.launched === true ? `launched: ${value.exePath}` : 'not launched (Windows only)'}`,
                }],
        },
        timeoutMs: 300_000,
        async execute() {
            if (process.platform !== 'win32') {
                return { launched: false, exePath: '' };
            }
            const result = await ensureInstalled(resolved, nodeDeps());
            // Self-heal the web shortcut too, but never block the launch on it.
            await ensureWebShortcut(resolved, nodeDeps())
                .catch(error => { logger.warn(`dsh-desktop-plugin: web shortcut failed: ${String(error)}`); });
            launchDesktop(result.exePath);
            return { launched: true, exePath: result.exePath };
        },
    }));
}
