import { CanvasNoticesRecordSchema } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CollaborationSessionProvider } from '../lib/collaboration-session';
import { CanvasNoticesRecordCard } from './canvas-notices';

const CANVAS = '00000000-0000-7000-8000-00000000c0c1';
const PURPOSE = 'Tell you when a new episode is out.';
const REGISTERED_AT = 1_800_000_000_000;
function record(purpose: string, recordedAt: number) {
  return CanvasNoticesRecordSchema.parse({ kind: 'canvas_notices_record', canvasId: CANVAS, purpose, registeredBy: { kind: 'rally', name: 'Rally' }, recordedAt });
}

function detail(notices: object | null) {
  return { id: CANVAS, title: 'Newsletter', visibility: 'workspace', notices };
}
function view(channels: ('push' | 'email')[] | null = null, purpose = PURPOSE, updatedAt = REGISTERED_AT) {
  return { purpose, registeredBy: { kind: 'rally', name: 'Rally' }, participant: true, channels, updatedAt };
}

/** The API calls the card makes besides the Canvas: Settings and this deployment's flags. */
function api(calls: object, settings: ('push' | 'email')[] = ['push', 'email']) {
  return { getMyPreferences: vi.fn(async () => ({ notify: { canvasNotices: settings } })),
    clientFeatureFlags: vi.fn(async () => ({ pushNotificationsEnabled: true })), ...calls };
}

function renderCard(calls: object, shown: ReturnType<typeof record>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<CollaborationSessionProvider api={calls as never} session={{ user: { id: 'user-adam' }, workspace: { id: 'workspace' } } as never}>
    <QueryClientProvider client={client}><CanvasNoticesRecordCard record={shown} /></QueryClientProvider>
  </CollaborationSessionProvider>);
}

afterEach(() => vi.restoreAllMocks());

/** jsdom lays nothing out: the actions row is wide enough for a button per channel. */
function layOutWide() {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('canvas-notices-record-actions') ? 600 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('channel-chips-probe') ? 160 : 0;
  });
}

describe('CanvasNoticesRecordCard', () => {
  it('reads the Canvas again when it holds no view of notices yet, and then draws the controls', async () => {
    const getCanvas = vi.fn()
      .mockResolvedValueOnce(detail(null))
      .mockResolvedValue(detail(view()));
    renderCard(api({ getCanvas }), record(PURPOSE, REGISTERED_AT));
    expect(await screen.findByRole('button', { name: 'Mute notifications' })).toBeInTheDocument();
    expect(getCanvas).toHaveBeenCalledTimes(2);
  });

  it('reads the Canvas again when its view is older than the record, as when the sentence changed', async () => {
    const getCanvas = vi.fn()
      .mockResolvedValueOnce(detail(view(null, 'Tell you about drafts.', REGISTERED_AT - 60_000)))
      .mockResolvedValue(detail(view()));
    renderCard(api({ getCanvas }), record(PURPOSE, REGISTERED_AT));
    expect(await screen.findByRole('button', { name: 'Mute notifications' })).toBeInTheDocument();
    expect(getCanvas).toHaveBeenCalledTimes(2);
  });

  it('leaves an older record as history, with no controls and no second read', async () => {
    const getCanvas = vi.fn(async () => detail(view()));
    renderCard(api({ getCanvas }), record('Tell you about drafts.', REGISTERED_AT - 60_000));
    expect(await screen.findByText('This Canvas used to send notices for:')).toBeInTheDocument();
    // Let any effect-driven read run before counting.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(getCanvas).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Mute notifications' })).toBeNull();
  });

  it('chooses this Canvas’s channels from what Settings says, and goes back to Settings', async () => {
    layOutWide();
    const setCanvasNoticeChoice = vi.fn(async (_canvasId: string, channels: string[] | null) => detail(view(channels as never)));
    renderCard(api({ getCanvas: vi.fn(async () => detail(view())), setCanvasNoticeChoice }), record(PURPOSE, REGISTERED_AT));
    expect(await screen.findByText('You get these by push, or by email when no device is set up, as your Settings say.')).toBeInTheDocument();
    // Settings has both on; turning email off for this Canvas keeps push.
    fireEvent.click(await screen.findByRole('button', { name: /Email/ }));
    await waitFor(() => expect(setCanvasNoticeChoice).toHaveBeenCalledWith(CANVAS, ['push']));
    expect(await screen.findByText('You get these by push.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use my Settings' }));
    await waitFor(() => expect(setCanvasNoticeChoice).toHaveBeenLastCalledWith(CANVAS, null));
  });

  it('says notices are off when Settings has them off, and turning them on here chooses both channels', async () => {
    const setCanvasNoticeChoice = vi.fn(async (_canvasId: string, channels: string[] | null) => detail(view(channels as never)));
    renderCard(api({ getCanvas: vi.fn(async () => detail(view())), setCanvasNoticeChoice }, []), record(PURPOSE, REGISTERED_AT));
    expect(await screen.findByText('Canvas notices are off in your Settings.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mute notifications' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on notifications' }));
    await waitFor(() => expect(setCanvasNoticeChoice).toHaveBeenCalledWith(CANVAS, ['push', 'email']));
  });

  it('shows a choice at once, and puts it back when the server refuses it', async () => {
    let refuse: (error: Error) => void = () => undefined;
    const setCanvasNoticeChoice = vi.fn(() => new Promise((_resolve, reject) => { refuse = reject; }));
    renderCard(api({ getCanvas: vi.fn(async () => detail(view())), setCanvasNoticeChoice }), record(PURPOSE, REGISTERED_AT));
    fireEvent.click(await screen.findByRole('button', { name: 'Mute notifications' }));
    expect(await screen.findByText('You muted notices from this Canvas.')).toBeInTheDocument();
    await act(async () => { refuse(new Error('Offline')); });
    expect(await screen.findByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('You get these by push, or by email when no device is set up, as your Settings say.')).toBeInTheDocument();
  });
});
