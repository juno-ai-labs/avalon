import { describe, expect, it, vi } from 'vitest';
import { AccountSessionFailure } from './account-session-failure';

describe('account session failure', () => {
  it('signs out before showing one notice shared by concurrent windows', async () => {
    let finishSignOut!: (current: boolean) => void;
    const signedOut = new Promise<boolean>((resolve) => { finishSignOut = resolve; });
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false });
    const onError = vi.fn();
    const failure = new AccountSessionFailure({ showMessageBox, onError });
    const secondSignOut = vi.fn().mockResolvedValue(false);
    const first = failure.end(() => signedOut);
    const second = failure.end(secondSignOut);
    expect(showMessageBox).not.toHaveBeenCalled();
    finishSignOut(true);
    await Promise.all([first, second]);
    expect(secondSignOut).toHaveBeenCalledOnce();
    expect(showMessageBox).toHaveBeenCalledExactlyOnceWith({
      type: 'warning',
      title: 'Sign in to Rally again',
      message: 'Your Rally session has ended.',
      detail: 'Rally could not restore your account session. You have been signed out. Sign in again to continue.',
      buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('checks the current failure even while a stale failure is pending', async () => {
    let finishStaleCheck!: (current: boolean) => void;
    const staleCheck = new Promise<boolean>((resolve) => { finishStaleCheck = resolve; });
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false });
    const failure = new AccountSessionFailure({ showMessageBox, onError: vi.fn() });
    const stale = failure.end(() => staleCheck);
    await failure.end(async () => true);
    expect(showMessageBox).toHaveBeenCalledOnce();
    finishStaleCheck(false);
    await stale;
    expect(showMessageBox).toHaveBeenCalledOnce();
  });

  it('shares an open notice without dropping either cleanup', async () => {
    let dismiss!: (value: { response: number; checkboxChecked: boolean }) => void;
    const notice = new Promise<{ response: number; checkboxChecked: boolean }>((resolve) => { dismiss = resolve; });
    const showMessageBox = vi.fn(() => notice);
    const failure = new AccountSessionFailure({ showMessageBox, onError: vi.fn() });
    const clear = vi.fn().mockResolvedValue(true);
    const first = failure.end(clear);
    const second = failure.end(clear);
    await Promise.resolve();
    expect(clear).toHaveBeenCalledTimes(2);
    expect(showMessageBox).toHaveBeenCalledOnce();
    dismiss({ response: 0, checkboxChecked: false });
    await Promise.all([first, second]);
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
