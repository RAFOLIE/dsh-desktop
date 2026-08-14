/**
 * Detached launch of the desktop exe.
 * @module dsh-desktop-plugin/launcher
 */
import { spawn } from 'node:child_process';
/**
 * Start the desktop app detached so it outlives this DSH host process.
 * @param exePath - absolute path to dsh-desktop-windowos.exe.
 * @returns the spawned child (already unref'd).
 */
export function launchDesktop(exePath) {
    const child = spawn(exePath, [], {
        cwd: undefined,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
    });
    child.unref();
    return child;
}
