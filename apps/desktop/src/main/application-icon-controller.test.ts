import { describe, expect, it, vi } from 'vitest';
import type { ApplicationIconId, DesktopApplicationIconState } from '../common/application-icons';
import {
  ApplicationIconController,
  type ApplicationIconControllerDependencies,
} from './application-icon-controller';

function setup(overrides: Partial<ApplicationIconControllerDependencies> = {}) {
  let storedIcon: ApplicationIconId | null = null;
  const states: DesktopApplicationIconState[] = [];
  const validateIcon = vi.fn((iconId: ApplicationIconId) => {
    void iconId;
  });
  const readStoredIcon = vi.fn(async () => storedIcon);
  const writeStoredIcon = vi.fn(async (iconId: ApplicationIconId) => {
    storedIcon = iconId;
  });
  const clearStoredIcon = vi.fn(async () => {
    storedIcon = null;
  });
  const applyIcon = vi.fn(async (iconId: ApplicationIconId) => {
    void iconId;
  });
  const resetNativeIcon = vi.fn(async () => undefined);
  const dependencies: ApplicationIconControllerDependencies = {
    supported: true,
    automaticIcon: () => 'light',
    validateIcon,
    readStoredIcon,
    writeStoredIcon,
    clearStoredIcon,
    applyIcon,
    resetNativeIcon,
    onStateChange: (state) => states.push(state),
    ...overrides,
  };
  const controller = new ApplicationIconController(dependencies);
  return {
    controller,
    states,
    validateIcon,
    readStoredIcon,
    writeStoredIcon,
    clearStoredIcon,
    applyIcon,
    resetNativeIcon,
    storedIcon: () => storedIcon,
    setStoredIcon: (iconId: ApplicationIconId | null) => {
      storedIcon = iconId;
    },
  };
}

describe('application icon controller', () => {
  it('cleans a retired native icon before clearing its preference and retries failures', async () => {
    const context = setup({ readStoredIcon: vi.fn(async (): Promise<'retired'> => 'retired') });
    context.resetNativeIcon.mockRejectedValueOnce(new Error('native reset failed'));
    await expect(context.controller.restore()).rejects.toThrow('native reset failed');
    expect(context.clearStoredIcon).not.toHaveBeenCalled();
    await context.controller.restore();
    expect(context.resetNativeIcon).toHaveBeenCalledTimes(2);
    expect(context.clearStoredIcon).toHaveBeenCalledOnce();
    expect(context.controller.state().isAutomatic).toBe(true);
    expect(context.applyIcon).not.toHaveBeenCalled();
  });

  it('leaves an absent preference alone on startup', async () => {
    const context = setup();
    await context.controller.restore();
    expect(context.resetNativeIcon).not.toHaveBeenCalled();
    expect(context.clearStoredIcon).not.toHaveBeenCalled();
  });

  it('reports a restored icon only after native application succeeds', async () => {
    const successful = setup();
    successful.setStoredIcon('ludicrous');
    await successful.controller.restore();
    expect(successful.controller.state()).toEqual({
      activeIcon: 'ludicrous',
      isAutomatic: false,
      supported: true,
    });

    const failed = setup({
      applyIcon: vi.fn(async () => {
        throw new Error('native restore failed');
      }),
    });
    failed.setStoredIcon('ludicrous');
    await expect(failed.controller.restore()).rejects.toThrow('native restore failed');
    expect(failed.controller.state()).toEqual({
      activeIcon: 'light',
      isAutomatic: true,
      supported: true,
    });
  });

  it('restores both preference and native icon when a change fails', async () => {
    const context = setup();
    context.setStoredIcon('dark');
    await context.controller.restore();
    context.applyIcon.mockImplementation(async (iconId) => {
      if (iconId === 'ludicrous') throw new Error('cache refresh failed');
    });

    await expect(context.controller.change('ludicrous')).rejects.toThrow('cache refresh failed');

    expect(context.storedIcon()).toBe('dark');
    expect(context.applyIcon).toHaveBeenLastCalledWith('dark');
    expect(context.controller.state().activeIcon).toBe('dark');
  });

  it('returns to the automatic icon when the first custom change fails', async () => {
    const applyIcon = vi.fn(async () => {
      throw new Error('finder update failed');
    });
    const context = setup({ applyIcon });

    await expect(context.controller.change('ludicrous')).rejects.toThrow('finder update failed');

    expect(context.storedIcon()).toBeNull();
    expect(context.resetNativeIcon).toHaveBeenCalledOnce();
    expect(context.controller.state().isAutomatic).toBe(true);
  });

  it('re-applies the custom icon when reset fails partway', async () => {
    const context = setup();
    context.setStoredIcon('calm');
    await context.controller.restore();
    context.resetNativeIcon.mockRejectedValueOnce(new Error('reset failed'));

    await expect(context.controller.reset()).rejects.toThrow('reset failed');

    expect(context.storedIcon()).toBe('calm');
    expect(context.applyIcon).toHaveBeenLastCalledWith('calm');
    expect(context.controller.state().activeIcon).toBe('calm');
  });

  it('serializes overlapping mutations', async () => {
    let finishFirst!: () => void;
    const calls: ApplicationIconId[] = [];
    const applyIcon = vi.fn((iconId: ApplicationIconId) => {
      calls.push(iconId);
      if (iconId !== 'ludicrous') return Promise.resolve();
      return new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    });
    const context = setup({ applyIcon });

    const first = context.controller.change('ludicrous');
    const second = context.controller.change('calm');
    await vi.waitFor(() => expect(calls).toEqual(['ludicrous']));
    finishFirst();
    await expect(first).resolves.toMatchObject({ activeIcon: 'ludicrous' });
    await expect(second).resolves.toMatchObject({ activeIcon: 'calm' });
    expect(calls).toEqual(['ludicrous', 'calm']);
  });

  it('continues the mutation queue after a rejected change', async () => {
    const applyIcon = vi.fn(async (iconId: ApplicationIconId) => {
      if (iconId === 'ludicrous') throw new Error('first change failed');
    });
    const context = setup({ applyIcon });

    const failed = context.controller.change('ludicrous');
    const next = context.controller.change('calm');

    await expect(failed).rejects.toThrow('first change failed');
    await expect(next).resolves.toMatchObject({ activeIcon: 'calm' });
    expect(context.storedIcon()).toBe('calm');
  });

  it('waits for startup restoration before accepting a user mutation', async () => {
    let finishRestore!: () => void;
    const calls: ApplicationIconId[] = [];
    const applyIcon = vi.fn((iconId: ApplicationIconId) => {
      calls.push(iconId);
      if (iconId !== 'dark') return Promise.resolve();
      return new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
    });
    const context = setup({ applyIcon });
    context.setStoredIcon('dark');

    const restore = context.controller.restore();
    const change = context.controller.change('ludicrous');
    await vi.waitFor(() => expect(calls).toEqual(['dark']));
    finishRestore();
    await restore;
    await expect(change).resolves.toMatchObject({ activeIcon: 'ludicrous' });
    expect(calls).toEqual(['dark', 'ludicrous']);
  });

  it('rejects unsupported and unallowlisted requests before persistence', async () => {
    const unsupported = setup({ supported: false });
    await expect(unsupported.controller.change('ludicrous')).rejects.toThrow('only on macOS');
    expect(unsupported.writeStoredIcon).not.toHaveBeenCalled();

    const invalid = setup();
    await expect(invalid.controller.change('../../secret')).rejects.toThrow('Unknown application icon');
    expect(invalid.writeStoredIcon).not.toHaveBeenCalled();
  });
});
