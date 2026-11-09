import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyVersionedSidebarList } from '../lib/sidebar-list-store';
import type { AutomationDetail } from '../lib/types';
import type * as WorkspaceSocket from '../lib/workspace-socket';
import { orderedTranscriptQueryKey } from '../lib/use-workstream-socket';
import { AutomationScreen } from './automation';

const getAutomation = vi.hoisted(() => vi.fn());
const getAutomationRuns = vi.hoisted(() => vi.fn());
const setAutomationAppearance = vi.hoisted(() => vi.fn());
const archiveAutomation = vi.hoisted(() => vi.fn());
const getSidekickDelegates = vi.hoisted(() => vi.fn());
const createAutomation = vi.hoisted(() => vi.fn());
const shell = vi.hoisted(() => ({ host: 'desktop' as 'desktop' | 'browser' }));
const viewer = vi.hoisted(() => ({ session: undefined as { user: { id: string }; workspace: { role: string | null } } | undefined }));
const surfaceIntents = vi.hoisted(() => [] as (string | undefined)[]);
const surfaceMenus = vi.hoisted(() => [] as (ReadonlyArray<{ label: string; checked?: boolean; onSelect: () => void }> | undefined)[]);
vi.mock('../lib/collaboration-session', () => ({
  useOptionalCollaborationSession: () => null,
  useCollaborationSession: () => ({ session: viewer.session, api: { archiveAutomation, getAutomation, getAutomationRuns, setAutomationAppearance, getSidekickDelegates, createAutomation } }),
  useShellCapabilities: () => ({ host: shell.host, guest: false }),
}));
const socket = vi.hoisted(() => ({ mounted: false }));
vi.mock('../lib/workspace-socket', async (importOriginal) => ({
  ...await importOriginal<typeof WorkspaceSocket>(),
  useOptionalWorkspaceSocket: () => socket.mounted ? { presenceUserIdsByWorkstream: {} } : null,
}));
// The conversation beside the profile is its own surface with its own sockets,
// and none of it is what this file is about.
const surfaceCancels = vi.hoisted(() => [] as (((() => void) | undefined))[]);
vi.mock('./conversation-surface', () => ({ ConversationSurface: ({ messageIntent, composerMenuActions, composerNotice, onComposerCancel }: {
  messageIntent?: string;
  composerMenuActions?: ReadonlyArray<{ label: string; checked?: boolean; onSelect: () => void }>;
  composerNotice?: React.ReactNode;
  onComposerCancel?: () => void;
}) => {
  surfaceIntents.push(messageIntent);
  surfaceMenus.push(composerMenuActions);
  surfaceCancels.push(onComposerCancel);
  // The notice is the host's own markup, drawn where the composer would be.
  return <div>{composerNotice}</div>;
} }));

const SIDEKICK_ID = 'sidekick-1';

function detail(overrides: Partial<AutomationDetail> = {}): AutomationDetail {
  return {
    id: SIDEKICK_ID,
    name: 'Weekly changelog',
    description: 'Prepare a concise changelog every Friday.',
    scope: 'workspace',
    status: 'active',
    updatedAt: '2026-09-10T10:00:00.000Z',
    lifecycle: 'active',
    authorUserId: 'user-1',
    runAsUserId: 'user-1',
    currentDefinition: null,
    currentDefinitionRevision: 0,
    acceptedDefinitionRevision: null,
    connectorBindings: {},
    triggerSummaries: [],
    recentRuns: [],
    ...overrides,
  };
}

/**
 * The layout measures its own width to decide whether both panes fit, and jsdom
 * reports zero, so it renders compact — with the profile `inert` behind the
 * Conversation view. Switching to Details is what a person does there, and it
 * is what puts the hexagon in the accessibility tree.
 */
async function showProfile(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Sidekick details' }));
}

function renderScreen(client: QueryClient, entry = `/sidekicks/${SIDEKICK_ID}`) {
  return render(
    <QueryClientProvider client={client}>
      <Tooltip.Provider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route element={<AutomationScreen />} path="/sidekicks/:id" />
            <Route element={<div>Sidekicks library</div>} path="/sidekicks" />
          </Routes>
        </MemoryRouter>
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getAutomation.mockReset().mockResolvedValue(detail());
  getAutomationRuns.mockReset().mockResolvedValue([]);
  setAutomationAppearance.mockReset();
  archiveAutomation.mockReset().mockResolvedValue(undefined);
  getSidekickDelegates.mockReset().mockResolvedValue({ sidekickId: SIDEKICK_ID, creatorUserId: 'user-1', you: { userId: 'user-1', allowed: false }, delegates: [] });
  createAutomation.mockReset().mockResolvedValue({ automationId: SIDEKICK_ID });
  shell.host = 'desktop';
  viewer.session = undefined;
  surfaceIntents.length = 0;
  surfaceMenus.length = 0;
  surfaceCancels.length = 0;
  window.location.hash = '';
  socket.mounted = false;
});

describe("The Sidekick's conversation composer", () => {
  async function open(userId: string, role: string | null, overrides: Partial<AutomationDetail> = {}) {
    viewer.session = { user: { id: userId }, workspace: { role } };
    getAutomation.mockResolvedValue(detail(overrides));
    renderScreen(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    await waitFor(() => expect(surfaceIntents.length).toBeGreaterThan(0));
  }
  const editAction = () => surfaceMenus.at(-1)?.find((action) => action.label === 'Edit Sidekick');

  it("asks the Sidekick for a run from the author until they switch on Edit Sidekick", async () => {
    await open('user-1', 'member');
    expect(surfaceIntents.at(-1)).toBeUndefined();
    expect(editAction()).toMatchObject({ checked: false });
    act(() => editAction()!.onSelect());
    await waitFor(() => expect(surfaceIntents.at(-1)).toBe('edit_sidekick'));
    expect(editAction()).toMatchObject({ checked: true });
    act(() => editAction()!.onSelect());
    await waitFor(() => expect(surfaceIntents.at(-1)).toBeUndefined());
  });

  it('names the open Sidekick in its one header, and the open run after it', async () => {
    await open('user-1', 'member');
    expect(await screen.findByRole('button', { name: 'Sidekick menu: Weekly changelog' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sidekicks' })).toBeNull();
  });

  it("puts the run's pill after the Sidekick's, which leads back to the shared conversation", async () => {
    viewer.session = { user: { id: 'user-1' }, workspace: { role: 'member' } };
    renderScreen(new QueryClient({ defaultOptions: { queries: { retry: false } } }), `/sidekicks/${SIDEKICK_ID}?run=run-1`);
    const back = await screen.findByRole('button', { name: /Weekly changelog/ });
    expect(screen.getByText('Run')).toBeInTheDocument();
    fireEvent.click(back);
    expect(await screen.findByRole('button', { name: 'Sidekick menu: Weekly changelog' })).toBeInTheDocument();
  });

  it("numbers the run's pill as its row in the shared conversation does", async () => {
    viewer.session = { user: { id: 'user-1' }, workspace: { role: 'member' } };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const RUN_ID = '00000000-0000-7000-8000-0000000000bb';
    // The shared conversation as its socket leaves it: the run's row, numbered 6.
    client.setQueryData(orderedTranscriptQueryKey(SIDEKICK_ID), {
      snapshotId: 'snapshot-shared', snapshotThrough: 1, eventSequence: 1, snapshotAtUtc: '2026-11-08T10:00:00.000Z',
      unreadAnchorSequence: null, unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest', requested: { startInclusive: 1, endExclusive: 2 }, covered: { startInclusive: 1, endExclusive: 2 },
        turns: [{
          transcriptSequence: 1, turnId: 'turn-run-1', entryKind: 'conversation', actor: 'system', authorUserId: null,
          authorSnapshot: null, attentionOrdinal: 1, clientMessageId: 'automation-activation:run-1', externalActor: null,
          createdAtUtc: '2026-11-08T10:00:00.000Z', revision: 1,
          blocks: [{
            type: 'text', blockId: 'block-run-1', blockIndex: 0, text: 'Done.', streaming: false,
            messageType: 'automation_activation',
            structuredContent: {
              type: 'automation_activation', schemaVersion: 1, automationId: '00000000-0000-7000-8000-0000000000aa', automationName: 'Weekly changelog',
              runId: RUN_ID, deliveryId: 'delivery-1', trigger: { kind: 'manual' }, occurredAt: 1789088651967,
              run: { state: 'completed', stepCount: 2, reply: 'Done.' },
            },
            sidekickRun: { requesterUserId: 'user-1', runNumber: 6 },
            mentions: [], attachments: [],
          }],
          blockCount: 1, activityId: null,
        }],
        activities: [], pluginRuns: [],
      }],
      activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
    });
    renderScreen(client, `/sidekicks/${SIDEKICK_ID}?run=${RUN_ID}`);
    await screen.findByRole('button', { name: /Weekly changelog/ });
    expect(screen.getByText('Run 6')).toBeInTheDocument();
  });

  it('numbers the run from the link that opened it before its shared conversation has loaded', async () => {
    viewer.session = { user: { id: 'user-1' }, workspace: { role: 'member' } };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const RUN_ID = '00000000-0000-7000-8000-0000000000bc';
    render(
      <QueryClientProvider client={client}>
        <Tooltip.Provider>
          <MemoryRouter initialEntries={[{ pathname: `/sidekicks/${SIDEKICK_ID}`, search: `?run=${RUN_ID}`, state: { runNumber: 5 } }]}>
            <Routes><Route element={<AutomationScreen />} path="/sidekicks/:id" /></Routes>
          </MemoryRouter>
        </Tooltip.Provider>
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: /Weekly changelog/ });
    expect(screen.getByText('Run 5')).toBeInTheDocument();
  });

  it('leaves Edit Sidekick from the chip at the composer, and on Escape', async () => {
    await open('user-1', 'member');
    act(() => editAction()!.onSelect());
    await waitFor(() => expect(surfaceIntents.at(-1)).toBe('edit_sidekick'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop editing this Sidekick' }));
    await waitFor(() => expect(surfaceIntents.at(-1)).toBeUndefined());
    expect(screen.queryByText('Editing this Sidekick')).toBeNull();

    act(() => editAction()!.onSelect());
    await waitFor(() => expect(surfaceIntents.at(-1)).toBe('edit_sidekick'));
    act(() => surfaceCancels.at(-1)!());
    await waitFor(() => expect(surfaceIntents.at(-1)).toBeUndefined());
    // Off, the composer has no mode to leave.
    expect(surfaceCancels.at(-1)).toBeUndefined();
  });

  it('names the window after the open Sidekick', async () => {
    document.title = 'Rally';
    await open('user-1', 'member');
    await waitFor(() => expect(document.title).toBe('Weekly changelog · Rally'));
  });

  it('opens a draft already editing, since it has nothing to run yet', async () => {
    await open('user-1', 'member', { lifecycle: 'draft', status: 'draft' });
    expect(surfaceIntents.at(-1)).toBe('edit_sidekick');
  });

  it("offers an Organization admin the edit on an Organization Sidekick", async () => {
    await open('user-2', 'admin');
    expect(editAction()).toBeDefined();
  });

  it("offers a member who does not manage it no edit, so they only ask for runs", async () => {
    await open('user-2', 'member');
    expect(editAction()).toBeUndefined();
    expect(surfaceIntents.at(-1)).toBeUndefined();
  });

  it("offers an admin no edit on a personal Sidekick they did not write", async () => {
    await open('user-2', 'admin', { scope: 'you' });
    expect(editAction()).toBeUndefined();
  });
});

describe('Immediate Sidekick creation', () => {
  it('creates immediately on opening New Sidekick without an enrollment screen', async () => {
    renderScreen(new QueryClient({ defaultOptions: { queries: { retry: false } } }), '/sidekicks/new');
    await showProfile();
    expect(screen.getByRole('heading', { name: 'Weekly changelog' })).toBeInTheDocument();
    expect(createAutomation).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Create Sidekick' })).not.toBeInTheDocument();
  });

  it('reopens the draft this person already has rather than making a second', async () => {
    socket.mounted = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    applyVersionedSidebarList(client, 'automations', 1, [
      { id: SIDEKICK_ID, name: 'New Sidekick', description: '', scope: 'you', status: 'draft', updatedAt: '2026-11-08T09:00:00.000Z' },
    ]);
    getAutomation.mockResolvedValue(detail({ lifecycle: 'draft', status: 'draft', name: 'New Sidekick' }));
    renderScreen(client, '/sidekicks/new');
    expect(await screen.findByRole('button', { name: 'Sidekick menu: New Sidekick' })).toBeInTheDocument();
    expect(createAutomation).not.toHaveBeenCalled();
  });
});

describe('AutomationScreen load failure', () => {
  it.each(['desktop', 'browser'] as const)('offers a retry and leaves the way out to the sidebar beside it (%s)', async (host) => {
    shell.host = host;
    getAutomation.mockRejectedValue(new Error('Sidekick not found'));
    renderScreen(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});

describe('AutomationScreen archival', () => {
  it('leaves the archived Sidekick route', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderScreen(client);
    await showProfile();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More Sidekick actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive Sidekick' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Archive Sidekick' }))
      .getByRole('button', { name: 'Archive' }));

    await screen.findByText('Sidekicks library');
    expect(archiveAutomation).toHaveBeenCalledWith(SIDEKICK_ID);
  });
});

describe('AutomationScreen appearance saving', () => {
  it('keeps a newer Sidekick when an older appearance response lands after it', async () => {
    // The pick's response is held open, which is the window the defect lived
    // in: it is a whole Sidekick, and it was written to the cache whatever had
    // happened to that entry meanwhile.
    let settle!: (value: AutomationDetail) => void;
    setAutomationAppearance.mockImplementation(() => new Promise<AutomationDetail>((resolve) => { settle = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderScreen(client);
    await showProfile();

    fireEvent.keyDown(await screen.findByRole('button', { name: 'Change Sidekick icon and color' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Rocket' }));
    await waitFor(() => expect(setAutomationAppearance).toHaveBeenCalledWith(SIDEKICK_ID, { icon: 'rocket' }));

    // Somebody else pauses it while the pick is still in flight — the shape of
    // every other writer of this entry, including the workspace socket's push.
    client.setQueryData<AutomationDetail>(['automation', SIDEKICK_ID], detail({
      lifecycle: 'paused',
      status: 'paused',
      appearance: { icon: 'rocket', color: null },
      updatedAt: '2026-09-10T10:00:05.000Z',
    }));
    expect(await screen.findByText('Paused')).toBeInTheDocument();

    // The pick's own answer, committed before that pause and so older than it.
    await act(async () => settle(detail({ appearance: { icon: 'rocket', color: null } })));

    // The pause survives. Writing the older response back would show an active
    // Sidekick that the server has already paused, and the push that would have
    // corrected it has been spent.
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText('Active')).toBeNull();
  });

  it('applies its own response when nothing newer arrived', async () => {
    setAutomationAppearance.mockResolvedValue(detail({
      appearance: { icon: 'rocket', color: 'purple' },
      updatedAt: '2026-09-10T10:00:05.000Z',
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderScreen(client);
    await showProfile();

    fireEvent.keyDown(await screen.findByRole('button', { name: 'Change Sidekick icon and color' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Purple' }));

    await waitFor(() => expect(client.getQueryData<AutomationDetail>(['automation', SIDEKICK_ID])?.appearance)
      .toEqual({ icon: 'rocket', color: 'purple' }));
  });
});
