import * as Tooltip from '@radix-ui/react-tooltip';
import type { WorkstreamTranscriptSnapshot } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkstreamDetail } from '../lib/types';
import type * as SocketModule from '../lib/use-workstream-socket';
import type * as DictationModule from '../lib/use-realtime-dictation';

// The real launcher, Canvas, conversation and composer; the network and audio
// devices are doubles so creation and the first socket snapshot can be held independently.
const api = vi.hoisted(() => ({
  createCanvas: vi.fn(), getCanvas: vi.fn(), getWorkspaceMembers: vi.fn(async () => []),
  getWorkspace: vi.fn(async () => ({ id: 'org', region: 'global', modelSelectorVisible: false })),
  getConnections: vi.fn(async () => []), recordActivityEvents: vi.fn(async () => undefined),
  acknowledgeConversationRead: vi.fn(),
}));
const socket = vi.hoisted(() => ({
  createMessage: vi.fn(), enabled: false, ready: false,
}));
const audio = vi.hoisted(() => ({ start: vi.fn(), emit: undefined as ((text: string) => void) | undefined }));
const host = vi.hoisted(() => ({ current: 'desktop' }));
vi.mock('../lib/collaboration-session', () => ({
  useOptionalCollaborationSession: () => ({ api }),
  useCollaborationSession: () => ({ api, session: {
    user: { id: '00000000-0000-7000-8000-0000000000a1', name: 'Adam' },
    workspace: { id: 'org', region: 'global', role: 'member' },
  } }),
  useShellCapabilities: () => ({ host: host.current, guest: false }),
}));
vi.mock('../lib/workspace-socket', () => ({ useOptionalWorkspaceSocket: () => null }));
vi.mock('../lib/use-workstream-socket', async (importOriginal) => ({
  ...await importOriginal<typeof SocketModule>(),
  useWorkstreamSocket: (_api: unknown, _id: string, enabled: boolean) => {
    socket.enabled = enabled;
    return {
      activeCompaction: null, activeInferenceDelays: [], createMessage: socket.createMessage,
      requestSnapshot: vi.fn(), retryOpening: vi.fn(), loadTranscriptRange: vi.fn(),
      sendReady: socket.ready, state: socket.ready ? 'connected' : 'opening',
    };
  },
}));
vi.mock('../lib/use-realtime-dictation', async (importOriginal) => {
  const React = await import('react');
  return {
    ...await importOriginal<typeof DictationModule>(),
    useRealtimeDictation: (_api: unknown, onTranscript: (text: string) => void) => {
      const [state, setState] = React.useState('idle');
      audio.emit = onTranscript;
      return {
        state, devices: [], selectedDeviceId: 'default', setSelectedDeviceId: vi.fn(),
        prefetch: vi.fn(), clearError: vi.fn(),
        start: async () => { audio.start(); setState('listening'); },
        stop: async () => { setState('idle'); },
      };
    },
  };
});
vi.mock('../lib/use-transcript-follow', () => ({
  TRANSCRIPT_END_SLACK: 24,
  useTranscriptFollow: () => ({
    atEnd: true, isFollowing: () => true, onScroll: vi.fn(), onWheel: vi.fn(),
    release: vi.fn(), scrollTo: vi.fn(), scrollToEnd: vi.fn(),
  }),
}));

import { useCreateCanvas } from '../lib/canvases';
import { CanvasScreen } from './canvas';

function Launcher(): React.JSX.Element {
  const create = useCreateCanvas();
  return <button onClick={() => void create()}>New Canvas</button>;
}
function Location(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="location">{location.pathname}</output><button onClick={() => void navigate('/elsewhere')}>Leave</button></>;
}
function mount(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<Tooltip.Provider><QueryClientProvider client={client}><MemoryRouter initialEntries={['/canvases']}>
    <Location /><Routes>
      <Route path="/canvases" element={<Launcher />} />
      <Route path="/canvases/:id" element={<CanvasScreen />} />
      <Route path="/elsewhere" element={<p>Elsewhere</p>} />
    </Routes>
  </MemoryRouter></QueryClientProvider></Tooltip.Provider>);
  return client;
}
function pendingCreate(): { resolve: () => void; reject: () => void } {
  let resolve!: (value: { canvasId: string; turnId: null }) => void;
  let reject!: (error: Error) => void;
  api.createCanvas.mockImplementation(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
  return {
    resolve: () => resolve({ canvasId: (api.createCanvas.mock.calls[0]![0] as { canvasId: string }).canvasId, turnId: null }),
    reject: () => reject(new Error('Connection lost')),
  };
}
function canvasId(): string {
  return (api.createCanvas.mock.calls[0]![0] as { canvasId: string }).canvasId;
}
function deliverSnapshot(client: QueryClient): void {
  const id = canvasId();
  socket.ready = true;
  const detail: WorkstreamDetail = {
    id, title: 'New Canvas', titleStatus: 'settled', harnessStatus: 'completed', scope: 'personal',
    createdAt: '2026-11-11T12:00:00.000Z', lastActivityAt: '2026-11-11T12:00:00.000Z',
    latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0, manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0, hasUnread: false, firstUnreadSequenceNumber: null, nextPendingWakeup: null,
    pinPosition: null, participantUserIds: [], participantExtraCount: 0, participants: [], viewers: [],
    resources: [], connections: [], backgroundTasks: [],
  };
  const transcript: WorkstreamTranscriptSnapshot = {
    snapshotId: '00000000-0000-7000-8000-000000000059', snapshotThrough: 0, eventSequence: 0,
    snapshotAtUtc: '2026-11-11T12:00:00.000Z', unreadAnchorSequence: null, unreadReason: 'no_unread',
    ranges: [], activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
  };
  client.setQueryData(['workstream', id], detail);
  client.setQueryData(['ordered-transcript', id], transcript);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  socket.ready = false;
  socket.enabled = false;
  audio.emit = undefined;
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  api.getCanvas.mockImplementation(async (id: string) => ({
    id, title: 'New Canvas', titleStatus: 'settled', createdByUserId: '00000000-0000-7000-8000-0000000000a1',
    createdAt: '2026-11-11T12:00:00.000Z', updatedAt: '2026-11-11T12:00:00.000Z',
    lastEditor: null, writerSidekickId: null, visibility: 'creator', participantUserIds: [], artifacts: [], canManage: true,
  }));
  socket.createMessage.mockResolvedValue({ turnId: 'turn', clientMessageId: 'message', createdAt: '2026-11-11T12:01:00.000Z', deliveryState: 'queued' });
});
afterEach(() => vi.unstubAllGlobals());

describe('optimistic Canvas creation', () => {
  it.each(['browser', 'desktop'])('opens immediately on %s, keeps the draft, and waits for creation and the live snapshot to send', async (currentHost) => {
    host.current = currentHost;
    const create = pendingCreate();
    const client = mount();
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas' }));
    const input = screen.getByRole('textbox', { name: 'Ask Rally or the people here' });
    expect(screen.getByTestId('location')).toHaveTextContent(`/canvases/${canvasId()}`);
    expect(api.getCanvas).not.toHaveBeenCalled();
    expect(socket.enabled).toBe(false);
    fireEvent.change(input, { target: { value: 'Start this while creating' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: /^Send message/ })).toBeDisabled();
    expect(socket.createMessage).not.toHaveBeenCalled();
    await act(async () => create.resolve());
    await waitFor(() => expect(socket.enabled).toBe(true));
    expect(screen.getByRole('button', { name: /^Send message/ })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Ask Rally or the people here' })).toBe(input);
    expect(input).toHaveValue('Start this while creating');
    await act(async () => deliverSnapshot(client));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(socket.createMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'Start this while creating' })));
  });

  it('allows recording while creating and keeps the recording mounted when the Canvas becomes ready', async () => {
    const create = pendingCreate();
    const client = mount();
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
    act(() => audio.emit?.('Spoken before creation'));
    const input = screen.getByRole('textbox', { name: 'Ask Rally or the people here' });
    expect(input).toHaveValue('Spoken before creation');
    expect(screen.getByRole('button', { name: /^Send message/ })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeEnabled();
    await act(async () => create.resolve());
    await act(async () => deliverSnapshot(client));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'Ask Rally or the people here' })).toBe(input);
    expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeEnabled();
    expect(input).toHaveValue('Spoken before creation');
    expect(socket.createMessage).not.toHaveBeenCalled();
  });

  it('retries a failed creation in place with the same Canvas ID and preserves the draft', async () => {
    const create = pendingCreate();
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas' }));
    const input = screen.getByRole('textbox', { name: 'Ask Rally or the people here' });
    fireEvent.change(input, { target: { value: 'Keep my draft' } });
    await act(async () => create.reject());
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(api.createCanvas).toHaveBeenCalledTimes(2);
    expect(api.createCanvas.mock.calls[1]![0]).toEqual(api.createCanvas.mock.calls[0]![0]);
    expect(input).toHaveValue('Keep my draft');
    expect(socket.enabled).toBe(false);
    await act(async () => create.resolve());
    await waitFor(() => expect(socket.enabled).toBe(true));
  });

  it('does not navigate back to a Canvas when creation finishes after leaving it', async () => {
    const create = pendingCreate();
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'New Canvas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    await act(async () => create.resolve());
    expect(screen.getByTestId('location')).toHaveTextContent('/elsewhere');
  });
});
