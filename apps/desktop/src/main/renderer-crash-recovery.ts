import type { MessageBoxOptions, MessageBoxReturnValue, RenderProcessGoneDetails } from 'electron';

export type RendererExitReason = RenderProcessGoneDetails['reason'];

interface RendererCrashRecoveryDependencies {
  readonly showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  readonly isQuitting: () => boolean;
  readonly relaunch: () => void;
  readonly quit: () => void;
  readonly onError: (error: unknown) => void;
}

const unexpectedExitReasons = new Set<RendererExitReason>([
  'abnormal-exit',
  'killed',
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
    if (!unexpectedExitReasons.has(reason) || this.dependencies.isQuitting()) return Promise.resolve();
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
        cancelId: 0,
        noLink: true,
      });
    } catch (error) {
      this.dependencies.onError(error);
      return;
    }

    if (this.dependencies.isQuitting()) return;
    if (result.response === 0) {
      try {
        this.dependencies.relaunch();
      } catch (error) {
        this.dependencies.onError(error);
      }
    }
    this.dependencies.quit();
  }
}
