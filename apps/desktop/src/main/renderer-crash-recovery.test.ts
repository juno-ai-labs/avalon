import { describe, expect, it, vi } from 'vitest';
import { RendererCrashRecovery } from './renderer-crash-recovery';

function setup() {
  const calls: string[] = [];
  const showMessageBox = vi.fn(async () => ({ response: 0, checkboxChecked: false }));
  const relaunch = vi.fn(() => calls.push('relaunch'));
  const quit = vi.fn(() => calls.push('quit'));
  const onDialogError = vi.fn();
  const recovery = new RendererCrashRecovery({ showMessageBox, relaunch, quit, onDialogError });
  return { calls, onDialogError, quit, recovery, relaunch, showMessageBox };
}

describe('RendererCrashRecovery', () => {
  it.each(['clean-exit', 'killed'] as const)('ignores an intentional %s', async (reason) => {
    const { quit, recovery, relaunch, showMessageBox } = setup();

    await recovery.offer(reason);

    expect(showMessageBox).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it.each(['abnormal-exit', 'crashed', 'oom', 'memory-eviction', 'launch-failed', 'integrity-failure'] as const)(
    'offers recovery after %s',
    async (reason) => {
      const { calls, recovery, showMessageBox } = setup();

      await recovery.offer(reason);

      expect(showMessageBox).toHaveBeenCalledWith({
        type: 'error',
        title: 'Rally needs to restart',
        message: 'Rally’s window stopped unexpectedly.',
        detail: 'Restart Rally to open a fresh window and continue.',
        buttons: ['Restart Rally', 'Quit Rally'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      expect(calls).toEqual(['relaunch', 'quit']);
    },
  );

  it('quits without scheduling a relaunch when Quit Rally is chosen', async () => {
    const { calls, recovery, showMessageBox } = setup();
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });

    await recovery.offer('crashed');

    expect(calls).toEqual(['quit']);
  });

  it('coalesces repeated renderer exits while the recovery dialog is open', async () => {
    const { recovery, showMessageBox } = setup();
    let resolveDialog!: (result: { response: number; checkboxChecked: boolean }) => void;
    showMessageBox.mockImplementationOnce(() => new Promise((resolve) => { resolveDialog = resolve; }));

    const first = recovery.offer('crashed');
    const second = recovery.offer('oom');

    expect(showMessageBox).toHaveBeenCalledTimes(1);
    resolveDialog({ response: 1, checkboxChecked: false });
    await Promise.all([first, second]);
  });

  it('reports a dialog failure without quitting and permits a later retry', async () => {
    const { onDialogError, quit, recovery, showMessageBox } = setup();
    const failure = new Error('dialog unavailable');
    showMessageBox.mockRejectedValueOnce(failure);

    await recovery.offer('crashed');

    expect(onDialogError).toHaveBeenCalledWith(failure);
    expect(quit).not.toHaveBeenCalled();
    await recovery.offer('crashed');
    expect(showMessageBox).toHaveBeenCalledTimes(2);
  });
});
