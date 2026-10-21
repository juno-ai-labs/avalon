import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepLinkErrorScreen } from './deep-link-error';

const state = vi.hoisted(() => ({
  dismissDeepLinkError: vi.fn(async () => undefined),
  getDeepLinkError: vi.fn(async (): Promise<{ id: number; message: string } | null> => null),
  changed: undefined as undefined | ((notice: { id: number; message: string } | null) => void),
}));

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    dismissDeepLinkError: state.dismissDeepLinkError,
    getDeepLinkError: state.getDeepLinkError,
    onDeepLinkErrorChanged: (listener: (notice: { id: number; message: string } | null) => void) => {
      state.changed = listener;
      return () => {
        state.changed = undefined;
      };
    },
  }),
  desktopServicesAvailable: () => false,
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
    state.getDeepLinkError.mockResolvedValue({ id: 1, message: 'Rally received an invalid connector completion link.' });
    render(<DeepLinkErrorScreen />);

    expect(await screen.findByText('Rally received an invalid connector completion link.')).toBeVisible();
  });

  it('replaces the message when a second link is refused while it is open', async () => {
    state.getDeepLinkError.mockResolvedValue({ id: 1, message: 'Rally could not open that note link.' });
    render(<DeepLinkErrorScreen />);
    expect(await screen.findByText('Rally could not open that note link.')).toBeVisible();

    // The window is a singleton, so the second failure re-shows this one rather
    // than opening another. Leaving the first message up would attribute the
    // window to the link the person has already dealt with.
    state.changed?.({ id: 2, message: 'Rally received an unexpected sign-in link.' });

    expect(await screen.findByText('Rally received an unexpected sign-in link.')).toBeVisible();
    expect(screen.queryByText('Rally could not open that note link.')).toBeNull();
  });

  it('keeps a message pushed while the opening read was still in flight', async () => {
    // The read is a snapshot taken when main served the invoke. A failure that
    // lands before it settles is newer, and letting the read win would put the
    // older link's message back and leave it there.
    let resolveRead: (notice: { id: number; message: string } | null) => void = () => undefined;
    state.getDeepLinkError.mockReturnValue(new Promise<{ id: number; message: string } | null>((resolve) => {
      resolveRead = resolve;
    }));
    render(<DeepLinkErrorScreen />);

    await waitFor(() => expect(state.changed).toBeDefined());
    state.changed?.({ id: 2, message: 'Rally received an unexpected sign-in link.' });
    expect(await screen.findByText('Rally received an unexpected sign-in link.')).toBeVisible();

    resolveRead({ id: 1, message: 'Rally could not open that note link.' });
    await Promise.resolve();

    expect(await screen.findByText('Rally received an unexpected sign-in link.')).toBeVisible();
    expect(screen.queryByText('Rally could not open that note link.')).toBeNull();
  });

  it('closes the window through main when Continue is pressed', async () => {
    state.getDeepLinkError.mockResolvedValue({ id: 1, message: 'Rally received an invalid sign-in link.' });
    render(<DeepLinkErrorScreen />);
    await screen.findByText('Rally received an invalid sign-in link.');

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(state.dismissDeepLinkError).toHaveBeenCalledWith(1));
  });

  it('acknowledges the notice it is showing, not the one it opened with', async () => {
    // A failure reported between reading the first message and the click landing
    // replaces the text. Acknowledging the id it opened with would let main close
    // the window on a message nobody has read.
    state.getDeepLinkError.mockResolvedValue({ id: 4, message: 'Rally could not open that note link.' });
    render(<DeepLinkErrorScreen />);
    await screen.findByText('Rally could not open that note link.');

    state.changed?.({ id: 5, message: 'Rally received an unexpected sign-in link.' });
    await screen.findByText('Rally received an unexpected sign-in link.');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(state.dismissDeepLinkError).toHaveBeenCalledWith(5));
  });

  it('closes the window itself when main cannot be reached', async () => {
    // Acknowledging must not be the one action that can fail: a window that
    // will not shut is worse than the message it is still showing.
    state.getDeepLinkError.mockResolvedValue({ id: 1, message: 'Rally received an invalid sign-in link.' });
    state.dismissDeepLinkError.mockRejectedValue(new Error('no such window'));
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    render(<DeepLinkErrorScreen />);
    await screen.findByText('Rally received an invalid sign-in link.');

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    close.mockRestore();
  });

  it('names the window for a person who is looking at it without context', async () => {
    // It opens over another application, so it carries its own title: the
    // message alone does not say what asked.
    state.getDeepLinkError.mockResolvedValue({ id: 1, message: 'Sign in could not be completed: access denied' });
    render(<DeepLinkErrorScreen />);

    const dialog = await screen.findByRole('alertdialog', { name: 'Rally could not open that link' });
    expect(dialog).toBeVisible();
    expect(dialog).toHaveAccessibleDescription('Sign in could not be completed: access denied');
  });
});
