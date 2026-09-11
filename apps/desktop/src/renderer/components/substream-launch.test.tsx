import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllDrafts } from '../lib/draft-cache';
import type { Message, WorkspaceMember, WorkstreamDetail } from '../lib/types';
import { ConnectingCard } from './connecting-card';
import { SubstreamLaunchSurface, type SubstreamLaunchProps } from './substream-launch';

// The launch composer offers its model selector only while Application →
// Developer → Debug enabled is on, so this bridge is what turns it on and off.
const applicationSettings = vi.hoisted(() => ({
  current: { lockdownMode: false, lockdownAvailable: false, debugEnabled: false },
}));

vi.mock('../lib/platform', () => ({
  desktopServicesAvailable: () => false,
  desktopBridge: () => ({
    getApplicationSettings: () => Promise.resolve(applicationSettings.current),
    onApplicationSettingsChanged: () => () => undefined,
  }),
}));

/** The staged files a submit leases, so a test can see which way the lease went. */
const attachments = vi.hoisted(() => ({
  commitLease: vi.fn(),
  restoreLease: vi.fn(),
}));

vi.mock('../lib/use-file-attachments', () => ({
  useFileAttachments: () => ({
    addFiles: vi.fn(),
    attachments: [],
    commitLease: attachments.commitLease,
    consume: vi.fn(),
    error: undefined,
    leaseReady: vi.fn(async () => ({ leaseId: 'lease', attachments: [] })),
    ready: [],
    removeAttachment: vi.fn(),
    restoreLease: attachments.restoreLease,
    retryAttachment: vi.fn(),
    uploading: false,
  }),
}));

const creator: WorkspaceMember = {
  id: 'user-1', name: 'Adam', email: 'adam@example.com', timezone: 'America/Los_Angeles',
};

const parent: WorkstreamDetail = {
  id: 'workstream-1',
  title: 'Investigate the release',
  titleStatus: 'settled',
  harnessStatus: 'running',
  scope: 'workspace',
  lastActivityAt: '2026-09-09T20:00:00.000Z',
  latestAttentionSequenceNumber: 4,
  readThroughSequenceNumber: 4,
  manualUnreadFromSequenceNumber: null,
  manualUnreadGeneration: 0,
  hasUnread: false,
  firstUnreadSequenceNumber: null,
  nextPendingWakeup: null,
  pinPosition: null,
  participantUserIds: [],
  participantExtraCount: 0,
  createdAt: '2026-09-09T20:00:00.000Z',
  participants: [{ ...creator, role: 'creator' }],
  viewers: [],
  resources: [],
  connections: [],
  backgroundTasks: [],
};

function branchMessage(sequence: number): Message {
  return {
    id: `turn-${sequence}`,
    transcriptTurnId: `turn-${sequence}`,
    workstreamId: parent.id,
    sequenceNumber: sequence,
    authorType: 'agent',
    messageType: 'text',
    text: `Main turn ${sequence}`,
    createdAt: '2026-09-09T20:00:00.000Z',
  };
}

function renderSurface(overrides: Partial<SubstreamLaunchProps> = {}): {
  onCreate: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
} {
  const onCreate = vi.fn(async () => undefined);
  const onCancel = vi.fn();
  render(
    <Tooltip.Provider>
      <SubstreamLaunchSurface
        api={null}
        currentUser={creator}
        draft={{ throughTurnId: 'turn-4', provenance: [branchMessage(3), branchMessage(4)] }}
        launching={null}
        members={[creator]}
        onCancel={onCancel}
        onCreate={onCreate}
        onOpenAttachment={vi.fn()}
        parent={parent}
        workspaceId="workspace-1"
        workspaceRegion="global"
        {...overrides}
      />
    </Tooltip.Provider>,
  );
  return { onCreate, onCancel };
}

const composer = (): HTMLElement =>
  screen.getByRole('textbox', { name: 'What should this substream work on?' });

/** Open the composer's model pill, the way Radix's trigger expects to be opened. */
async function openModelMenu(): Promise<void> {
  const trigger = await screen.findByRole('button', { name: /^Model:/u });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

describe('substream launch surface', () => {
  beforeEach(() => {
    clearAllDrafts();
    vi.clearAllMocks();
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false };
  });
  afterEach(cleanup);

  it('shows the branch point above the composer and hands enter the words that were typed', async () => {
    const { onCreate } = renderSurface();
    const branch = screen.getByRole('region', { name: 'Branching from' });
    expect(branch.textContent).toContain('Main turn 3');
    expect(branch.textContent).toContain('Main turn 4');
    expect(screen.getByText('New substream from this message')).toBeInTheDocument();

    fireEvent.change(composer(), { target: { value: 'Compare it with last release' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Compare it with last release',
      attachmentIds: [],
      confirmedParticipantUserIds: [],
    })));
  });

  it('draws an attachment on the turn it is about to create', async () => {
    // `MessageBlock` shows an attachment row only when it has both the opener
    // and the loader, so a missing loader is not a degraded tile — it is no
    // tile, and then the file appears when the real transcript arrives.
    renderSurface({
      loadAttachmentContent: async () => new Blob(['x']),
      launching: {
        attachments: [{
          id: '00000000-0000-7000-8000-0000000000e1',
          fileName: 'pricing.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 12,
          contentAvailable: true,
          createdAt: '2026-09-09T20:05:00.000Z',
        }],
        createdAt: '2026-09-09T20:05:00.000Z',
        startedAt: Date.parse('2026-09-09T20:05:00.000Z'),
        text: 'Check this against last quarter',
      },
    });
    // The name is split into base and suffix for the middle-ellipsis, so this
    // asks for the half that carries it.
    expect(await screen.findByText('pricing')).toBeInTheDocument();
  });

  it('says only what it is when there is no branch point to show', () => {
    renderSurface({ draft: { throughTurnId: null, provenance: [] } });
    expect(screen.queryByRole('region', { name: 'Branching from' })).not.toBeInTheDocument();
    expect(screen.getByText('New substream')).toBeInTheDocument();
  });

  it('carries the parent\'s connecting card and holds creation while the parent is a seed', () => {
    const { onCreate } = renderSurface({
      connecting: <ConnectingCard detail="Starting a substream is available once Rally connects" name="Remembered" state="connecting" subject="work stream" />,
      sendBlocked: true,
    });

    expect(document.querySelector('.connecting-card')?.textContent ?? '').toContain('Connecting to Remembered…');
    fireEvent.change(composer(), { target: { value: 'Branch from a seed' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(onCreate).not.toHaveBeenCalled();
    expect(composer()).toHaveValue('Branch from a seed');
    expect(screen.getByRole('button', { name: /Create substream/u })).toBeDisabled();
    // Once on the card, once as the launch composer's footer hint.
    expect(screen.getAllByText('Starting a substream is available once Rally connects')).toHaveLength(2);
  });

  it('offers no stop control for the parent run it is standing in front of', () => {
    renderSurface();
    const slot = document.querySelector('.composer-stop-slot');
    expect(slot).toHaveAttribute('inert');
    expect(slot).toHaveAttribute('data-visible', 'false');
  });

  it('draws the typed turn and the work timer while the substream is being created', () => {
    renderSurface({
      launching: {
        attachments: [],
        createdAt: '2026-09-09T20:05:00.000Z',
        startedAt: Date.parse('2026-09-09T20:05:00.000Z'),
        text: 'Compare it with last release',
      },
    });
    // The same turn, in the same place, at the same geometry the created
    // substream will draw it at.
    expect(screen.getByText('Compare it with last release')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 }).querySelector('.title-skeleton')).not.toBeNull();
  });

  it('stops offering to cancel once creation is in flight', () => {
    renderSurface({
      launching: {
        attachments: [],
        createdAt: '2026-09-09T20:05:00.000Z',
        startedAt: Date.parse('2026-09-09T20:05:00.000Z'),
        text: 'Compare it with last release',
      },
    });
    // The row is on its way out, but it is still in the tab order while it
    // goes — and this control cannot stop a creation the server has claimed.
    expect(screen.getByRole('button', { name: 'Cancel new substream' })).toBeDisabled();
  });

  it('keeps the words when creation fails, because the composer restores what it cleared', async () => {
    const { onCreate } = renderSurface();
    onCreate.mockRejectedValueOnce(new Error('The substream could not be created.'));
    fireEvent.change(composer(), { target: { value: 'Look at the invoice' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(composer()).toHaveValue('Look at the invoice'));
  });

  it('gives the staged files back on a failure and spends them only on a send', async () => {
    // Which way the lease goes is what a failed creation costs somebody: files
    // committed for a message that never landed are gone, and they are the one
    // part of a draft that cannot be typed again.
    const { onCreate } = renderSurface();
    onCreate.mockRejectedValueOnce(new Error('The substream could not be created.'));
    fireEvent.change(composer(), { target: { value: 'Look at the invoice' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(attachments.restoreLease).toHaveBeenCalledWith('lease'));
    expect(attachments.commitLease).not.toHaveBeenCalled();

    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(attachments.commitLease).toHaveBeenCalledWith('lease'));
  });

  it('hides the model selector unless developer mode is on', async () => {
    renderSurface();

    await screen.findByRole('textbox', { name: 'What should this substream work on?' });
    expect(screen.queryByRole('button', { name: /^Model:/u })).not.toBeInTheDocument();
  });

  it('pins the substream to the model chosen in developer mode', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    const { onCreate } = renderSurface();

    await openModelMenu();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Grok 4.6' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.change(composer(), { target: { value: 'Compare it with last release' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: 'x-ai/grok-4.6',
    })));
  });

  it('starts unpinned rather than inheriting the pin its parent carries', async () => {
    // A substream is its own conversation with its own row. Seeding this from
    // the parent would change what an untouched composer does for every
    // substream of a pinned work stream, silently, and none of those
    // conversations asked for it.
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    const { onCreate } = renderSurface({ parent: { ...parent, modelOverride: 'x-ai/grok-4.6' } });

    await openModelMenu();
    expect(await screen.findByRole('menuitemradio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.change(composer(), { target: { value: 'Compare it with last release' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: null,
    })));
  });
});
