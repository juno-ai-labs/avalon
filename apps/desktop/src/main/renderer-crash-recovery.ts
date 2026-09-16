import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';

export type RendererExitReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'memory-eviction'
  | 'launch-failed'
  | 'integrity-failure';

interface RendererCrashRecoveryDependencies {
  readonly showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  readonly relaunch: () => void;
  readonly quit: () => void;
  readonly onDialogError?: (error: unknown) => void;
}

const unexpectedExitReasons = new Set<RendererExitReason>([
  'abnormal-exit',
  'crashed',
  'oom',
  'memory-eviction',
  'launch-failed',
  'integrity-failure',
]);

/**
 * Owns the one recovery choice that remains available after the primary
 * renderer is gone. The dialog is native and main-process-owned, so it does
 * not depend on React, the preload bridge, or a functioning renderer process.
 */
export class RendererCrashRecovery {
  private pending: Promise<void> | null = null;

  constructor(private readonly dependencies: RendererCrashRecoveryDependencies) {}

  offer(reason: RendererExitReason): Promise<void> {
    if (!unexpectedExitReasons.has(reason)) return Promise.resolve();
    if (this.pending) return this.pending;

    this.pending = this.showDialog().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async showDialog(): Promise<void> {
    let result: MessageBoxReturnValue;
    try {
      result = await this.dependencies.showMessageBox({
        type: 'error',
        title: 'Rally needs to restart',
        message: 'Rally’s window stopped unexpectedly.',
        detail: 'Restart Rally to open a fresh window and continue.',
        buttons: ['Restart Rally', 'Quit Rally'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
    } catch (error) {
      this.dependencies.onDialogError?.(error);
      return;
    }

    if (result.response === 0) this.dependencies.relaunch();
    this.dependencies.quit();
  }
}
