/**
 * dsh-desktop-plugin: install and launch the dsh-desktop-windowos desktop
 * shell from a DSH profile.
 * @module dsh-desktop-plugin
 */

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'dsh-desktop-plugin'

/** Services required before load: the model-facing tool registry. */
export const inject: string[] = ['tools']

export { Config } from './config.js'
export type { ResolvedConfig } from './config.js'
export { apply } from './runtime.js'
