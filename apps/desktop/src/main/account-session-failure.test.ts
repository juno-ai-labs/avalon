import { describe, expect, it, vi } from 'vitest';
import { AccountSessionFailure } from './account-session-failure';

describe('account session failure', () => {
  it('signs out before showing one notice shared by concurrent windows', async () => {
    let finishSignOut!: (current: boolean) => void;
    const signedOut = new Promise<boolean>((resolve) => { finishSignOut = resolve; });
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false });
    const onError = vi.fn();
    const failure = new AccountSessionFailure({ showMessageBox, onError });
    const secondSignOut = vi.fn();
    const first = failure.end(() => signedOut);
    const second = failure.end(secondSignOut);
    expect(showMessageBox).not.toHaveBeenCalled();
    finishSignOut(true);
    await Promise.all([first, second]);
    expect(secondSignOut).not.toHaveBeenCalled();
    expect(showMessageBox).toHaveBeenCalledExactlyOnceWith({
      type: 'warning',
      title: 'Sign in to Rally again',
      message: 'Your Rally session has ended.',
      detail: 'Rally could not restore your account session. You have been signed out. Sign in again to continue.',
      buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not show a notice when the rejected credential has already been replaced', async () => {
    const showMessageBox = vi.fn();
    const failure = new AccountSessionFailure({ showMessageBox, onError: vi.fn() });
    await failure.end(async () => false);
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('reports a failed cleanup and can handle a later failure', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false });
    const onError = vi.fn();
    const failure = new AccountSessionFailure({ showMessageBox, onError });
    const error = new Error('credential storage unavailable');
    await failure.end(async () => { throw error; });
    expect(onError).toHaveBeenCalledWith(error);
    expect(showMessageBox).not.toHaveBeenCalled();
    await failure.end(async () => true);
    expect(showMessageBox).toHaveBeenCalledOnce();
  });
});
