import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';

interface AccountSessionFailureDependencies {
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  onError: (error: unknown) => void;
}

/** Main owns one notice across every window discovering the same dead account. */
export class AccountSessionFailure {
  private pending: Promise<void> | null = null;

  constructor(private readonly dependencies: AccountSessionFailureDependencies) {}

  end(signOutIfCurrent: () => Promise<boolean>): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.endOnce(signOutIfCurrent).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async endOnce(signOutIfCurrent: () => Promise<boolean>): Promise<void> {
    try {
      if (!await signOutIfCurrent()) return;
      await this.dependencies.showMessageBox({
        type: 'warning',
        title: 'Sign in to Rally again',
        message: 'Your Rally session has ended.',
        detail: 'Rally could not restore your account session. You have been signed out. Sign in again to continue.',
        buttons: ['OK'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
    } catch (error) {
      this.dependencies.onError(error);
    }
  }
}
