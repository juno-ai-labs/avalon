import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllDrafts } from '../lib/draft-cache';
import type { Message, WorkspaceMember, WorkstreamDetail } from '../lib/types';
import { SubstreamLaunchSurface, type SubstreamLaunchProps } from './substream-launch';

vi.mock('../lib/platform', () => ({
  desktopServicesAvailable: () => false,
  desktopBridge: () => ({
    getApplicationSettings: () => Promise.resolve({ lockdownMode: false, lockdownAvailable: false, debugEnabled: false }),
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

describe('substream launch surface', () => {
  beforeEach(() => { clearAllDrafts(); vi.clearAllMocks(); });
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

  it('offers no stop control for the parent run it is standing in front of', () => {
    renderSurface();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
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
});
