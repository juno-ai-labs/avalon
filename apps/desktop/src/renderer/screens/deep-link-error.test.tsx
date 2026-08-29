import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepLinkErrorScreen } from './deep-link-error';

const state = vi.hoisted(() => ({
  dismissDeepLinkError: vi.fn(async () => undefined),
  getDeepLinkError: vi.fn(async (): Promise<string | null> => null),
  changed: undefined as undefined | ((message: string | null) => void),
}));

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    dismissDeepLinkError: state.dismissDeepLinkError,
    getDeepLinkError: state.getDeepLinkError,
    onDeepLinkErrorChanged: (listener: (message: string | null) => void) => {
      state.changed = listener;
      return () => {
        state.changed = undefined;
      };
    },
  }),
}));

describe('the deep-link failure window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.changed = undefined;
    state.getDeepLinkError.mockResolvedValue(null);
    state.dismissDeepLinkError.mockResolvedValue(undefined);
  });

  it('shows the message main is already holding', async () => {
    // The window is opened by main with the message, so by the time this
    // renderer exists the message predates it. Nothing pushes it here — the
    // mount has to go and read it.
    state.getDeepLinkError.mockResolvedValue('Rally received an invalid connector completion link.');
    render(<DeepLinkErrorScreen />);

    expect(await screen.findByText('Rally received an invalid connector completion link.')).toBeVisible();
  });

  it('replaces the message when a second link is refused while it is open', async () => {
    state.getDeepLinkError.mockResolvedValue('Rally could not open that note link.');
    render(<DeepLinkErrorScreen />);
    expect(await screen.findByText('Rally could not open that note link.')).toBeVisible();

    // The window is a singleton, so the second failure re-shows this one rather
    // than opening another. Leaving the first message up would attribute the
    // window to the link the person has already dealt with.
    state.changed?.('Rally received an unexpected sign-in link.');

    expect(await screen.findByText('Rally received an unexpected sign-in link.')).toBeVisible();
    expect(screen.queryByText('Rally could not open that note link.')).toBeNull();
  });

  it('closes the window through main when Continue is pressed', async () => {
    state.getDeepLinkError.mockResolvedValue('Rally received an invalid sign-in link.');
    render(<DeepLinkErrorScreen />);
    await screen.findByText('Rally received an invalid sign-in link.');

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(state.dismissDeepLinkError).toHaveBeenCalledOnce());
  });

  it('closes the window itself when main cannot be reached', async () => {
    // Acknowledging must not be the one action that can fail: a window that
    // will not shut is worse than the message it is still showing.
    state.getDeepLinkError.mockResolvedValue('Rally received an invalid sign-in link.');
    state.dismissDeepLinkError.mockRejectedValue(new Error('no such window'));
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    render(<DeepLinkErrorScreen />);
    await screen.findByText('Rally received an invalid sign-in link.');

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    close.mockRestore();
  });

  it('names the window for a person who is looking at it without context', async () => {
    // It opens over another application, so it carries its own title: the
    // message alone does not say what asked.
    state.getDeepLinkError.mockResolvedValue('Sign in could not be completed: access denied');
    render(<DeepLinkErrorScreen />);

    expect(await screen.findByRole('alertdialog', { name: 'Rally could not open that link' })).toBeVisible();
  });
});
