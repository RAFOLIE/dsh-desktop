/**
 * Cordis activation: auto-install on load plus the desktop_launch tool.
 * @module dsh-desktop-plugin/runtime
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type Config, type ResolvedConfig } from './config.js';
import { type InstallerDeps } from './installer.js';
declare module '@deepseek-ai/dsh-jobs' {
    interface JobKindMap {
        desktop: 'desktop';
    }
}
/** Canonical desktop_launch result: launched, installing in background, or Windows-only. */
export type LaunchValue = {
    status: 'launched';
    exePath: string;
} | {
    status: 'installing';
    jobId: string;
} | {
    status: 'windows-only';
};
/** Fakeable host boundary for the tool path: installer effects plus launch. */
export interface RuntimeDeps extends InstallerDeps {
    /** Start the desktop exe detached. */
    launch(exePath: string): unknown;
}
/** Production deps: node effects plus the detached launcher. */
export declare function runtimeDeps(): RuntimeDeps;
/**
 * Build the desktop_launch tool definition. Split from apply so tests can
 * drive the presentation projections without a running registry.
 * @param ctx - Plugin context; used for the logger and the optional jobs service.
 * @param config - Resolved plugin configuration.
 * @param deps - Host boundary to fake in tests.
 */
export declare function buildDesktopTool(ctx: Context, config: ResolvedConfig, deps: RuntimeDeps): ToolDefinition;
/**
 * Apply the plugin to its Cordis context.
 * @param ctx - Scoped plugin context; the tool registration is owned by it.
 * @param config - Configuration resolved by Cordis from the exported schema.
 * @param deps - Host boundary; production effects by default, fakes in tests.
 */
export declare function apply(ctx: Context, config?: Config, deps?: RuntimeDeps): void;
