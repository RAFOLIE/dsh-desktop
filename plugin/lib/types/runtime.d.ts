/**
 * Cordis activation: auto-install on load plus the desktop_launch tool.
 * @module dsh-desktop-plugin/runtime
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Config } from './config.js';
/**
 * Apply the plugin to its Cordis context.
 * @param ctx - Scoped plugin context; the tool registration is owned by it.
 * @param config - Configuration resolved by Cordis from the exported schema.
 */
export declare function apply(ctx: Context, config?: Config): void;
