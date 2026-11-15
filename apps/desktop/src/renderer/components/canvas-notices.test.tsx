import { CanvasNoticesRecordSchema } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
function view(channels: ('push' | 'email')[] | null = null) {
  return { purpose: PURPOSE, registeredBy: { kind: 'rally', name: 'Rally' }, participant: true, channels, updatedAt: REGISTERED_AT };
}

function renderCard(api: object, shown: ReturnType<typeof record>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<CollaborationSessionProvider api={api as never} session={{ user: { id: 'user-adam' }, workspace: { id: 'workspace' } } as never}>
    <QueryClientProvider client={client}><CanvasNoticesRecordCard record={shown} /></QueryClientProvider>
  </CollaborationSessionProvider>);
}

afterEach(() => vi.restoreAllMocks());

/** jsdom lays nothing out: the controls row is wide enough for a button per channel. */
function layOutWide() {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('canvas-notices-record-controls') ? 600 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('channel-chips-probe') ? 160 : 0;
  });
}

describe('CanvasNoticesRecordCard', () => {
  it('reads the Canvas again when it holds a record newer than its view, and then draws the controls', async () => {
    const getCanvas = vi.fn()
      .mockResolvedValueOnce(detail(null))
      .mockResolvedValue(detail(view()));
    renderCard({ getCanvas, getMyPreferences: vi.fn(async () => ({ notify: {} })) }, record(PURPOSE, REGISTERED_AT));
    expect(await screen.findByRole('button', { name: 'Mute this Canvas' })).toBeInTheDocument();
    expect(getCanvas).toHaveBeenCalledTimes(2);
  });

  it('leaves an older record as history, with no controls and no second read', async () => {
    const getCanvas = vi.fn(async () => detail(view()));
    renderCard({ getCanvas, getMyPreferences: vi.fn(async () => ({ notify: {} })) }, record('Tell you about drafts.', REGISTERED_AT - 60_000));
    expect(await screen.findByText('Turned on by Rally.')).toBeInTheDocument();
    await waitFor(() => expect(getCanvas).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Mute this Canvas' })).toBeNull();
  });

  it('chooses this Canvas’s channels from what Settings says, and goes back to Settings', async () => {
    layOutWide();
    const setCanvasNoticeChoice = vi.fn(async (_canvasId: string, channels: string[] | null) => detail(view(channels as never)));
    renderCard({ getCanvas: vi.fn(async () => detail(view())), setCanvasNoticeChoice,
      getMyPreferences: vi.fn(async () => ({ notify: { canvasNotices: ['push', 'email'] } })) }, record(PURPOSE, REGISTERED_AT));
    // Settings has both on; turning email off for this Canvas keeps push.
    fireEvent.click(await screen.findByRole('button', { name: /Email/ }));
    await waitFor(() => expect(setCanvasNoticeChoice).toHaveBeenCalledWith(CANVAS, ['push']));
    expect(await screen.findByText('You get these by push.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use Settings' }));
    await waitFor(() => expect(setCanvasNoticeChoice).toHaveBeenLastCalledWith(CANVAS, null));
  });
});
