/**
 * Detached launch of the desktop exe.
 * @module dsh-desktop-plugin/launcher
 */
/**
 * Start the desktop app detached so it outlives this DSH host process.
 * @param exePath - absolute path to dsh-desktop-windowos.exe.
 * @returns the spawned child (already unref'd).
 */
export declare function launchDesktop(exePath: string): import("child_process").ChildProcess;
