import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutomationDetail, WorkstreamBoot } from '../lib/types';
import type * as UseWorkstreamSocketModule from '../lib/use-workstream-socket';

/*
 * A Sidekick's shared conversation as a person uses it: the screen, the real
 * conversation surface and its composer, down to the conversation socket's
 * `createMessage`, which `use-workstream-socket` sends as `create_message`
 * (its own test proves the intent reaches that command). Only the socket and
 * the REST reads behind the profile are doubles. And the same Sidekick opened
 * from a Canvas, in the Canvas's real panel, where it is its details alone.
 */

const SIDEKICK = '00000000-0000-7000-8000-000000000a51';
const AUTHOR = '00000000-0000-7000-8000-000000000a52';
const MEMBER = '00000000-0000-7000-8000-000000000a53';

const api = vi.hoisted(() => ({
  getAutomation: vi.fn(),
  getWorkspace: vi.fn(async () => ({ id: "w", name: "Team", region: "global", timezone: "UTC", modelSelectorVisible: false, currentUser: { id: "viewer", name: "Viewer", email: "viewer@example.test", timezone: "UTC" } })),
  getAutomationRuns: vi.fn(async () => []),
  getSidekickDelegates: vi.fn(),
  getSidekickSources: vi.fn(),
  getWorkspaceMembers: vi.fn(async () => []),
  getConnections: vi.fn(async () => []),
  recordActivityEvents: vi.fn(async () => undefined),
  clientFeatureFlags: vi.fn(),
}));
const session = vi.hoisted(() => ({ current: null as unknown }));
const createMessage = vi.hoisted(() => vi.fn());
const addFiles = vi.hoisted(() => vi.fn());
const canvasFiles = vi.hoisted(() => vi.fn());
const loadTranscriptRange = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/collaboration-session', () => ({
  useOptionalCollaborationSession: () => null,
  useCollaborationSession: () => ({ api, session: session.current }),
  useShellCapabilities: () => ({ host: 'desktop', guest: false }),
}));
vi.mock('../lib/use-client-feature-flags', () => ({ useClientFeatureFlags: () => ({ data: {} }) }));
vi.mock('../lib/use-workstream-socket', async (importOriginal) => ({
  ...await importOriginal<typeof UseWorkstreamSocketModule>(),
  useWorkstreamSocket: () => ({
    activeCompaction: null, activeInferenceDelays: [], createMessage,
    requestSnapshot: vi.fn(), retryOpening: vi.fn(), loadTranscriptRange,
    sendReady: true, state: 'connected', workspaceSocketState: 'connected',
  }),
}));
vi.mock('../lib/workspace-socket', () => ({
  useWorkspaceSocket: () => ({ presenceUserIdsByWorkstream: {} }),
  useOptionalWorkspaceSocket: () => null,
}));
vi.mock('../lib/use-file-attachments', () => ({
  useFileAttachments: (_api: unknown, draftKey: string) => ({
    addFiles: draftKey.includes('00000000-0000-7000-8000-000000000c51') ? canvasFiles : addFiles, attachments: [], consume: vi.fn(),
    leaseReady: vi.fn(async () => ({ leaseId: 'lease', attachments: [] })),
    commitLease: vi.fn(), restoreLease: vi.fn(), error: undefined, ready: [],
    removeAttachment: vi.fn(), retryAttachment: vi.fn(), uploading: false,
  }),
}));
vi.mock('../lib/use-transcript-follow', () => ({
  TRANSCRIPT_END_SLACK: 24,
  useTranscriptFollow: () => ({
    atEnd: true, isFollowing: () => true, onScroll: vi.fn(), onWheel: vi.fn(),
    release: vi.fn(), scrollTo: vi.fn(), scrollToEnd: vi.fn(),
  }),
}));

import { AutomationScreen, SidekickPanel } from './automation';
import { ConversationSurface } from './conversation-surface';
import { useUiStore } from '../lib/ui-store';
import { layoutKey, writeLayout } from '../lib/desktop-layout';

function sidekick(overrides: Partial<AutomationDetail> = {}): AutomationDetail {
  return {
    id: SIDEKICK, name: 'Incident triage', description: 'Watches alerts.', scope: 'workspace', status: 'active',
    updatedAt: '2026-11-07T09:00:00.000Z', lifecycle: 'active', authorUserId: AUTHOR, runAsUserId: AUTHOR,
    currentDefinition: null, currentDefinitionRevision: 1, acceptedDefinitionRevision: 1,
    connectorBindings: {}, triggerSummaries: [], recentRuns: [], ...overrides,
  };
}

function boot(): WorkstreamBoot {
  return {
    id: SIDEKICK, title: 'Incident triage', titleStatus: 'settled', harnessStatus: 'completed', scope: 'workspace',
    lastActivityAt: '2026-11-07T09:00:00.000Z', latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null, manualUnreadGeneration: 0, hasUnread: false, firstUnreadSequenceNumber: null,
    nextPendingWakeup: null, pinPosition: null, spaceIds: [], participantUserIds: [], participantExtraCount: 0,
    createdAt: '2026-11-07T09:00:00.000Z', participants: [], viewers: [], resources: [], connections: [],
    backgroundTasks: [], openElicitations: [],
    transcript: {
      snapshotId: '00000000-0000-7000-8000-000000000a59', snapshotThrough: 0, eventSequence: 0,
      snapshotAtUtc: '2026-11-07T09:00:00.000Z', unreadAnchorSequence: null, unreadReason: 'no_unread',
      ranges: [], activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
    },
  } as WorkstreamBoot;
}

function renderSidekick(viewerId: string, search = '', inCanvas = false): QueryClient {
  session.current = { user: { id: viewerId, name: 'Viewer', email: 'viewer@example.test' }, workspace: { id: 'w', region: 'global', role: 'member' } };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const conversation = boot();
  queryClient.setQueryData(['workstream', SIDEKICK], conversation);
  queryClient.setQueryData(['ordered-transcript', SIDEKICK], conversation.transcript);
  queryClient.setQueryData(['substream-workstream', SIDEKICK, 'run-1'], conversation);
  queryClient.setQueryData(['substream-ordered-transcript', SIDEKICK, 'run-1'], conversation.transcript);
  const canvasId = '00000000-0000-7000-8000-000000000c51';
  queryClient.setQueryData(['workstream', canvasId], { ...conversation, id: canvasId, title: 'Launch plan' });
  queryClient.setQueryData(['ordered-transcript', canvasId], conversation.transcript);
  render(<Tooltip.Provider><QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={[inCanvas ? `/canvases/${canvasId}${search}` : `/sidekicks/${SIDEKICK}${search}`]}>
      <CurrentLocation />
      <Routes><Route element={<AutomationScreen />} path="/sidekicks/:id" />
        <Route path="/canvases/:id" element={<ConversationSurface parentId={canvasId} parentKind="canvas" substreamId="0" renderHeader={({ openPanel }) => <button onClick={() => openPanel({
          key: `sidekick:${SIDEKICK}`, label: 'Sidekick: Incident triage',
          render: (controls) => <SidekickPanel id={SIDEKICK} controls={controls} />,
        })}>Open attached Sidekick</button>} />} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider></Tooltip.Provider>);
  return queryClient;
}

function CurrentLocation(): React.JSX.Element {
  return <output data-testid="location">{useLocation().search}</output>;
}

async function send(text: string): Promise<void> {
  const composer = await screen.findByRole('textbox', { name: /^(Message Incident triage and the team|Describe a change to this Sidekick)$/u });
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
}

async function openComposerMenu(): Promise<void> {
  const trigger = await screen.findByRole('button', { name: 'Composer actions' });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

describe("a Sidekick's shared conversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useUiStore.setState({ railOpen: false, railScope: null, railExpanded: false, railLeaving: false });
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    createMessage.mockResolvedValue({ turnId: 'turn', clientMessageId: 'message', createdAt: '2026-11-07T09:01:00.000Z', deliveryState: 'queued' });
    api.getAutomation.mockResolvedValue(sidekick());
    api.getSidekickDelegates.mockResolvedValue({ sidekickId: SIDEKICK, creatorUserId: AUTHOR, you: { userId: AUTHOR, allowed: false }, delegates: [] });
    api.getSidekickSources.mockResolvedValue({ sidekickId: SIDEKICK, sources: [], requests: [] });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("opens the Sidekick's details alone in the Canvas panel, preserves the Canvas draft and releases only its own slot", async () => {
    writeLayout(layoutKey('w', AUTHOR, `artifact-panel:${SIDEKICK}:0`), JSON.stringify({ resourceId: 'old-sidekick-artifact', workstreamScoped: false }));
    renderSidekick(AUTHOR, '', true);
    const canvasComposer = await screen.findByRole('textbox', { name: 'Ask Rally or the people here' });
    fireEvent.change(canvasComposer, { target: { value: 'Keep this Canvas draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open attached Sidekick' }));
    const panel = await screen.findByRole('complementary', { name: 'Sidekick: Incident triage' });
    const details = await within(panel).findByRole('complementary', { name: 'Sidekick details' });
    expect(await within(details).findByRole('heading', { level: 1, name: 'Incident triage' })).toBeInTheDocument();
    expect(details).not.toHaveAttribute('inert');
    // No conversation: no composer, no feed, and nothing to switch to one.
    expect(within(panel).queryByRole('textbox')).toBeNull();
    expect(within(panel).queryByRole('log', { name: 'Transcript' })).toBeNull();
    expect(within(panel).queryByRole('region', { name: 'Sidekick conversation' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Sidekick details' })).toBeNull();
    expect(canvasComposer).toHaveValue('Keep this Canvas draft');
    expect(useUiStore.getState().railScope).toBe('00000000-0000-7000-8000-000000000c51');
    fireEvent.click(within(panel).getByRole('button', { name: 'Close panel' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Sidekick: Incident triage' })).toBeNull());
    expect(canvasComposer).toHaveValue('Keep this Canvas draft');
    expect(useUiStore.getState().railOpen).toBe(false);
  });

  it('starts no run, lists none, reads none and offers no Pause or Archive from the Canvas panel', async () => {
    api.getAutomation.mockResolvedValue(sidekick({ runnable: true }));
    renderSidekick(AUTHOR, '', true);
    fireEvent.click(screen.getByRole('button', { name: 'Open attached Sidekick' }));
    const panel = await screen.findByRole('complementary', { name: 'Sidekick: Incident triage' });
    await within(panel).findByRole('heading', { level: 1, name: 'Incident triage' });
    expect(within(panel).getByText('Active')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Pause' })).toBeNull();
    fireEvent.pointerDown(within(panel).getByRole('button', { name: 'More Sidekick actions' }), { button: 0, ctrlKey: false });
    const more = await screen.findByRole('menu');
    expect(within(more).getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual(['Copy link']);
    fireEvent.keyDown(more, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    fireEvent.pointerDown(within(panel).getByRole('button', { name: 'Sidekick menu: Incident triage' }), { button: 0, ctrlKey: false });
    const pill = await screen.findByRole('menu');
    expect(within(pill).getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual(['Copy link']);
    expect(api.getAutomationRuns).not.toHaveBeenCalled();
  });

  it("keeps the route's run out of the Canvas panel: the pill stays the Sidekick's", async () => {
    renderSidekick(AUTHOR, '?run=run-1', true);
    fireEvent.click(screen.getByRole('button', { name: 'Open attached Sidekick' }));
    const panel = await screen.findByRole('complementary', { name: 'Sidekick: Incident triage' });
    await within(panel).findByRole('heading', { level: 1, name: 'Incident triage' });
    expect(within(panel).getByRole('button', { name: 'Sidekick menu: Incident triage' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Back to Incident triage' })).toBeNull();
    expect(within(panel).queryByText('Ready to begin')).toBeNull();
  });

  it('attaches a paste on the Sidekick panel to neither conversation', async () => {
    renderSidekick(AUTHOR, '', true);
    fireEvent.click(screen.getByRole('button', { name: 'Open attached Sidekick' }));
    const panel = await screen.findByRole('complementary', { name: 'Sidekick: Incident triage' });
    const clipboardData = { files: [new File(['png'], 'screenshot.png', { type: 'image/png' })], types: ['Files'], getData: () => '' };
    fireEvent.paste(await within(panel).findByRole('complementary', { name: 'Sidekick details' }), { clipboardData });
    expect(addFiles).not.toHaveBeenCalled();
    expect(canvasFiles).not.toHaveBeenCalled();
    fireEvent.paste(screen.getByRole('textbox', { name: 'Ask Rally or the people here' }), { clipboardData });
    expect(canvasFiles).toHaveBeenCalledOnce();
    expect(addFiles).not.toHaveBeenCalled();
  });

  it('keeps the Sidekick open when a new Canvas artifact arrives', async () => {
    const client = renderSidekick(AUTHOR, '', true);
    fireEvent.click(screen.getByRole('button', { name: 'Open attached Sidekick' }));
    const panel = await screen.findByRole('complementary', { name: 'Sidekick: Incident triage' });
    await within(panel).findByRole('heading', { level: 1, name: 'Incident triage' });
    await act(async () => client.setQueryData<WorkstreamBoot>(['workstream', '00000000-0000-7000-8000-000000000c51'], (current) => ({
      ...current!, resources: [{ id: 'new-artifact', direction: 'artifact', title: 'Report', resourceType: 'file', mimeType: 'text/plain', refreshSupported: false, watchEnabled: false, watchStatus: 'unsupported', currentVersion: 1, relationshipType: 'generated' }],
    })));
    expect(screen.getByRole('complementary', { name: 'Sidekick: Incident triage' })).toBe(panel);
  });

  it("sends a manager's message as a wizard edit once Edit Sidekick is on", async () => {
    renderSidekick(AUTHOR);
    await openComposerMenu();
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Edit Sidekick' }));
    expect(await screen.findByText('Editing this Sidekick')).toBeInTheDocument();
    await send('Post updates to #status from now on.');
    await waitFor(() => expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Post updates to #status from now on.', intent: 'edit_sidekick',
    })));
  });

  it("sends a manager's message as a request for a run until they switch the edit on", async () => {
    renderSidekick(AUTHOR);
    await send('Check the checkout latency now.');
    await waitFor(() => expect(createMessage).toHaveBeenCalled());
    expect(createMessage.mock.calls[0]![0]).not.toHaveProperty('intent');
  });

  it("shows a run's own conversation without a composer: replies go in the shared conversation", async () => {
    renderSidekick(AUTHOR, '?run=run-1');
    expect(await screen.findByText('Run')).toBeInTheDocument();
    await screen.findByText('Ready to begin');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
  });

  it("takes no file dropped or pasted on a run's own conversation, which has no draft to show it", async () => {
    renderSidekick(AUTHOR, '?run=run-1');
    await screen.findByText('Ready to begin');
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    const transfer = {
      files: [file], items: [{ kind: 'file', type: 'text/plain', getAsFile: () => file }], types: ['Files'], getData: () => '',
    };
    fireEvent.drop(screen.getByRole('log', { name: 'Transcript' }), { dataTransfer: transfer });
    fireEvent.paste(window, { clipboardData: transfer });
    expect(addFiles).not.toHaveBeenCalled();
  });

  it('takes a file dropped on the shared conversation into its draft', async () => {
    renderSidekick(AUTHOR);
    await screen.findByRole('textbox', { name: 'Message Incident triage and the team' });
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    fireEvent.drop(screen.getByRole('log', { name: 'Transcript' }), { dataTransfer: { files: [file], items: [{ kind: 'file', type: 'text/plain', getAsFile: () => file }], types: ['Files'] } });
    expect(addFiles).toHaveBeenCalled();
  });

  it('offers someone who does not manage it no edit', async () => {
    renderSidekick(MEMBER);
    await screen.findByRole('textbox', { name: 'Message Incident triage and the team' });
    expect(screen.queryByText('Editing this Sidekick')).toBeNull();
    const trigger = screen.queryByRole('button', { name: 'Composer actions' });
    if (trigger) {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      expect(await screen.findByRole('menu')).toBeInTheDocument();
      expect(screen.queryByRole('menuitemcheckbox', { name: 'Edit Sidekick' })).toBeNull();
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    }
    await send('What happened overnight?');
    await waitFor(() => expect(createMessage).toHaveBeenCalled());
    expect(createMessage.mock.calls[0]![0]).not.toHaveProperty('intent');
  });
  it('shows the model control when the Organization enables it', async () => {
    api.getWorkspace.mockResolvedValueOnce({ id: 'w', name: 'Team', region: 'global', timezone: 'UTC', modelSelectorVisible: true,
      currentUser: { id: AUTHOR, name: 'Viewer', email: 'viewer@example.test', timezone: 'UTC' } });
    renderSidekick(AUTHOR);
    await screen.findByRole('textbox', { name: 'Message Incident triage and the team' });
    expect(await screen.findByRole('button', { name: /^Model:/u })).toBeDisabled();
  });

  it('hides the model control when the refreshed Organization setting turns off', async () => {
    api.getWorkspace.mockResolvedValueOnce({ id: 'w', name: 'Team', region: 'global', timezone: 'UTC', modelSelectorVisible: true,
      currentUser: { id: AUTHOR, name: 'Viewer', email: 'viewer@example.test', timezone: 'UTC' } });
    const queryClient = renderSidekick(AUTHOR);
    expect(await screen.findByRole('button', { name: /^Model:/u })).toBeDisabled();
    await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Model:/u })).not.toBeInTheDocument());
  });
});
