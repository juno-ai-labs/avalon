import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSTREAM_NAMING_GRACE_MS } from '@rally/contracts';
import type { DesktopSession } from '../../common/desktop';
import type { ElicitationData, HarnessRunMetadata, Message, WorkspaceMember, WorkstreamDetail, WorkstreamResource } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import {
  AddParticipantDialog,
  AddResourceDialog,
  acceptedMessageOverlayDeliveryState,
  highestVisibleAttentionSequence,
  initialTranscriptAnchorIndex,
  manualElicitationResponse,
  preservedPrependScrollTop,
  RunFailureNotice,
  orderedTranscriptOwnsRunTiming,
  WorkstreamErrorState,
  WorkstreamHeader,
  workstreamPayloadBelongsToRoute,
  workstreamPresenceViewers,
  workstreamRunTiming,
  workstreamShowsReadyState,
  resourceVersionsQueryKey,
  workspaceMemberFromSession,
} from './workstream';
import { JumpToLatestButton, RunStoppedNotice } from '../components/conversation-follow';
import { WorkstreamComposer } from '../components/workstream-composer';

describe('workspace foreground presence', () => {
  const member = (id: string, name: string): WorkspaceMember => ({
    id,
    name,
    email: `${id}@example.test`,
    timezone: 'America/Los_Angeles',
  });

  it('resolves non-participant viewers from WorkspaceDO presence instead of feed subscribers', () => {
    const participant = member('participant', 'Participant');
    const viewer = member('viewer', 'Viewer');
    const offline = member('offline', 'Offline');

    expect(workstreamPresenceViewers(
      [participant],
      [participant, viewer, offline],
      [participant.id, viewer.id],
    )).toEqual([{ ...viewer, viewing: true }]);
  });
});

describe('a resource history follows swaps the rail did not make', () => {
  it('keys the history on the version the detail shows, not on the resource alone', () => {
    // An agent republish or a watch-driven re-ingest arrives over the socket
    // and advances `currentVersion` without this cache being touched. Keyed on
    // the id alone, the rail then shows a history missing its newest entry
    // while presenting itself as the whole record.
    expect(resourceVersionsQueryKey('resource-1', 3))
      .not.toEqual(resourceVersionsQueryKey('resource-1', 4));
    expect(resourceVersionsQueryKey('resource-1', 3))
      .toEqual(resourceVersionsQueryKey('resource-1', 3));
    expect(resourceVersionsQueryKey('resource-1', 3))
      .not.toEqual(resourceVersionsQueryKey('resource-2', 3));
  });

  it('is a stable key while nothing is inspected', () => {
    expect(resourceVersionsQueryKey(null, null)).toEqual(resourceVersionsQueryKey(null, null));
  });
});

describe('transcript cursor pagination', () => {
  it('preserves the visible anchor when an older page is prepended', () => {
    expect(preservedPrependScrollTop(120, 2_000, 2_840)).toBe(960);
    expect(preservedPrependScrollTop(120, 2_000, 1_900)).toBe(120);
  });

});

describe('work-stream route handoff', () => {
  it('refuses to paint detail or transcript rows retained from another work stream', () => {
    const routeWorkstreamId = 'workstream-two';
    const workstream = { id: routeWorkstreamId };
    const transcript = {
      snapshotId: 'snapshot-route', snapshotThrough: 0, eventSequence: 0,
      snapshotAtUtc: '2026-08-27T12:00:00.000Z', unreadAnchorSequence: null,
      unreadReason: 'no_unread' as const, ranges: [], activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
    };

    expect(workstreamPayloadBelongsToRoute(routeWorkstreamId, workstream, transcript)).toBe(true);
    expect(workstreamPayloadBelongsToRoute(routeWorkstreamId, { id: 'workstream-one' }, transcript)).toBe(false);
    expect(workstreamPayloadBelongsToRoute(routeWorkstreamId, workstream, undefined)).toBe(false);
  });
});

const copyText = vi.hoisted(() => vi.fn());
const getRuntimeConfig = vi.hoisted(() => vi.fn());
const getApplicationSettings = vi.hoisted(() => vi.fn(async () => ({ debugEnabled: false })));
const onApplicationSettingsChanged = vi.hoisted(() => vi.fn(() => () => undefined));

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    copyText,
    getRuntimeConfig,
    getApplicationSettings,
    onApplicationSettingsChanged,
  }),
}));

const headerWorkstream: WorkstreamDetail = {
  id: 'workstream-header',
  title: 'Daily product brief',
  titleStatus: 'settled' as const,
  harnessStatus: 'completed',
  scope: 'workspace',
  lastActivityAt: '2026-08-07T12:00:00.000Z',
  latestAttentionSequenceNumber: 0,
  readThroughSequenceNumber: 0,
  manualUnreadFromSequenceNumber: null,
  manualUnreadGeneration: 0,
  hasUnread: false,
  firstUnreadSequenceNumber: null,
  nextPendingWakeup: null,
  pinPosition: null,
  participantUserIds: [],
  participantExtraCount: 0,
  createdAt: '2026-08-07T12:00:00.000Z',
  participants: [],
  viewers: [],
  resources: [],
  connections: [],
  backgroundTasks: [],
};

describe('running work-stream message delivery', () => {
  it('keeps accepted pending messages visibly pending until canonical promotion', () => {
    expect(acceptedMessageOverlayDeliveryState('pending', 'steer')).toBe('steer_pending');
    expect(acceptedMessageOverlayDeliveryState('pending', 'queue')).toBe('queue_pending');
    expect(acceptedMessageOverlayDeliveryState('pending', undefined)).toBe('queue_pending');
    expect(acceptedMessageOverlayDeliveryState('canonical', 'queue')).toBeUndefined();
  });

  it('queues a message for the in-flight loop without a delivery dropdown', async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <WorkstreamComposer
            attachments={[]}
            fileInputRef={createRef<HTMLInputElement>()}
            members={[]}
            onAttach={vi.fn()}
            onOpenAttachment={vi.fn()}
            onRemoveAttachment={vi.fn()}
            onRetryAttachment={vi.fn()}
            onSend={onSend}
            onStop={vi.fn(async () => undefined)}
            sending={false}
            uploading={false}
            workstream={{ ...headerWorkstream, harnessStatus: 'running' }}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('combobox', { name: 'Message delivery' })).not.toBeInTheDocument();
    const composer = screen.getByRole('textbox', { name: 'Message the work stream' });
    fireEvent.change(composer, { target: { value: 'Do this after the current loop stops' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      'Do this after the current loop stops',
      [],
      undefined,
      'queue',
    ));
  });
});

/**
 * jsdom performs no layout, so every element reports a width of zero and a
 * clipped title cannot be produced — only described. The properties are defined
 * on the prototype because the element under measurement is created by the
 * component; `restore` puts jsdom's own zero-width getters back, which
 * `restoreMocks` cannot do for a plain `defineProperty`.
 */
function stubElementWidths(widths: { clientWidth: number; scrollWidth: number }): { restore: () => void } {
  for (const [name, value] of Object.entries(widths)) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
  }
  return {
    restore: (): void => {
      for (const name of Object.keys(widths)) Reflect.deleteProperty(HTMLElement.prototype, name);
    },
  };
}

// One prop list for the header, so a re-render is the same tree with different
// data rather than a second, separately maintained copy of it.
function headerElement(
  workstream = headerWorkstream,
  overrides: {
    currentUserId?: string | null;
    grokBotMode?: boolean;
    onRename?: (title: string) => Promise<void>;
    presentUserIds?: readonly string[];
  } = {},
): React.JSX.Element {
  return (
    <Tooltip.Provider>
      <WorkstreamHeader
        currentUserId={overrides.currentUserId ?? null}
        grokBotMode={overrides.grokBotMode ?? false}
        onAddParticipant={vi.fn()}
        onAppearanceChange={vi.fn().mockResolvedValue(undefined)}
        // The screen opens the rail through the same store action.
        onOpenRail={(variant) => useUiStore.getState().openRail(variant)}
        onRename={overrides.onRename ?? (async () => undefined)}
        presentUserIds={overrides.presentUserIds ?? []}
      socketState="connected"
      workstream={workstream}
      workspaceTarget={{
        region: 'global',
        workspaceId: '00000000-0000-7000-8000-000000000001',
      }}
      />
    </Tooltip.Provider>
  );
}

function renderWorkstreamHeader(...args: Parameters<typeof headerElement>): ReturnType<typeof render> {
  return render(headerElement(...args));
}

describe('WorkstreamHeader presence', () => {
  const current = {
    id: 'user-current',
    name: 'Current User',
    email: 'current@rally.test',
    timezone: 'America/Los_Angeles',
  };
  const collaborator = {
    id: 'user-collaborator',
    name: 'Ari Collaborator',
    email: 'ari@rally.test',
    timezone: 'America/Los_Angeles',
  };

  it('pings a present collaborator but never the current user', () => {
    const { container } = renderWorkstreamHeader({
      ...headerWorkstream,
      participants: [current, collaborator],
    }, {
      currentUserId: current.id,
      presentUserIds: [current.id, collaborator.id],
    });

    const items = [...container.querySelectorAll('.participant-header-button .avatar-stack-item')];
    expect(items).toHaveLength(2);
    expect(items[0]).not.toHaveClass('is-present');
    expect(items[1]).toHaveClass('is-present');
    expect(screen.queryByTitle(current.name)).not.toBeInTheDocument();
    expect(screen.queryByTitle(collaborator.name)).not.toBeInTheDocument();
    expect(container.querySelectorAll('.avatar-presence-ping')).toHaveLength(1);
    expect(container.querySelector('.participant-header-button [tabindex]')).toBeNull();
  });
});

describe('WorkstreamHeader GrokBot shell', () => {
  it('shows the conversation title and participant facepile without a right-sidebar entry point', () => {
    renderWorkstreamHeader(headerWorkstream, { grokBotMode: true });

    expect(screen.getByRole('heading', { name: 'Daily product brief' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Daily product brief' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show HyperSight' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More work-stream actions' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage work-stream participants' }).closest('header')).not.toBeNull();

    expect(screen.queryByRole('button', { name: 'Work-stream context' })).not.toBeInTheDocument();
  });
});

describe('WorkstreamHeader origin affordances', () => {
  beforeEach(() => {
    useUiStore.setState({ railOpen: false, railVariant: 'context', inspector: null });
  });

  it('copies the canonical HTTPS link, which survives being pasted outside Rally', async () => {
    const workstreamId = '019fec70-fba0-7b0e-9f7a-3dd1ef56520f';
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    copyText.mockReset();
    copyText.mockResolvedValue(undefined);
    getRuntimeConfig.mockResolvedValue({
      appVersion: 'test',
      isPackaged: true,
      platform: 'darwin',
      api: { global: 'https://api.rallywith.ai', eu: 'https://eu.api.rallywith.ai' },
      webBaseUrl: 'https://rallywith.ai',
      devAuthEnabled: false,
    });
    renderWorkstreamHeader({ ...headerWorkstream, id: workstreamId });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More work-stream actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy work-stream link' }));

    await waitFor(() => expect(copyText).toHaveBeenCalledWith(
      `https://rallywith.ai/app/workspaces/global/00000000-0000-7000-8000-000000000001/workstreams/${workstreamId}`,
    ));
    expect(copyText).not.toHaveBeenCalledWith(expect.stringContaining('rallywithai://'));
  });

  it('does not offer the retained right sidebar in the standard header either', () => {
    renderWorkstreamHeader();

    expect(screen.queryByRole('button', { name: 'Work-stream context' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide work-stream context' })).not.toBeInTheDocument();
  });

});

describe('WorkstreamHeader inline rename', () => {
  beforeEach(() => {
    useUiStore.setState({ railOpen: false, railVariant: 'context', inspector: null });
  });

  it('opens the editor on a double click and saves the new name', async () => {
    const onRename = vi.fn(async () => undefined);
    renderWorkstreamHeader(headerWorkstream, { onRename });

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));
    const input = screen.getByRole('textbox', { name: 'Work stream name' });
    expect(input).toHaveValue('Daily product brief');

    fireEvent.change(input, { target: { value: '  Launch planning  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('Launch planning'));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Work stream name' })).not.toBeInTheDocument());
  });

  it('discards the draft on Cancel and on Escape without calling the rename', async () => {
    const onRename = vi.fn(async () => undefined);
    renderWorkstreamHeader(headerWorkstream, { onRename });

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Work stream name' }), { target: { value: 'Discarded' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel rename' }));
    expect(screen.getByRole('button', { name: 'Daily product brief' })).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Work stream name' }), { target: { value: 'Also discarded' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Work stream name' }), { key: 'Escape' });

    expect(screen.getByRole('button', { name: 'Daily product brief' })).toBeInTheDocument();
    expect(onRename).not.toHaveBeenCalled();
  });

  it('keeps the draft when Escape is cancelling an IME candidate rather than the rename', () => {
    const onRename = vi.fn(async () => undefined);
    renderWorkstreamHeader(headerWorkstream, { onRename });

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));
    const input = screen.getByRole('textbox', { name: 'Work stream name' });
    fireEvent.change(input, { target: { value: 'Half-converted name' } });

    // Escape abandons the IME's candidate, not the rename. Discarding here
    // throws away the whole draft, and nothing offers it back.
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(screen.getByRole('textbox', { name: 'Work stream name' })).toHaveValue('Half-converted name');

    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 });
    expect(screen.getByRole('textbox', { name: 'Work stream name' })).toHaveValue('Half-converted name');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Work stream name' })).not.toBeInTheDocument();
    expect(onRename).not.toHaveBeenCalled();
  });

  it('refuses an empty name and keeps the editor open when the rename fails', async () => {
    const onRename = vi.fn(async () => {
      throw new Error('The work stream could not be renamed.');
    });
    renderWorkstreamHeader(headerWorkstream, { onRename });

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));
    const input = screen.getByRole('textbox', { name: 'Work stream name' });
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();

    fireEvent.change(input, { target: { value: 'Launch planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The work stream could not be renamed.');
    expect(screen.getByRole('textbox', { name: 'Work stream name' })).toHaveValue('Launch planning');
  });

  it('drops an open draft when the header moves to another work stream', () => {
    const { rerender } = renderWorkstreamHeader();

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Work stream name' }), { target: { value: 'Stale draft' } });

    rerender(headerElement({ ...headerWorkstream, id: 'workstream-other', title: 'Another stream' }));

    expect(screen.queryByRole('textbox', { name: 'Work stream name' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Another stream' })).toBeInTheDocument();
  });

  it('closes without a request when the name is unchanged, so Save is never inert', async () => {
    const onRename = vi.fn(async () => undefined);
    renderWorkstreamHeader(headerWorkstream, { onRename });

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Daily product brief' })).toBeInTheDocument();
  });

  it('names the title as a button inside the heading, and opens only on keyboard activation', () => {
    renderWorkstreamHeader();

    // The heading survives: assistive technology gets both the document
    // structure and something it can report as actionable.
    expect(screen.getByRole('heading', { name: 'Daily product brief' })).toBeInTheDocument();
    const title = screen.getByRole('button', { name: 'Daily product brief' });
    expect(title).toHaveAttribute('aria-keyshortcuts', 'Enter F2');

    // A single mouse click reports a detail of 1 and must not open the editor.
    fireEvent.click(title, { detail: 1 });
    expect(screen.queryByRole('textbox', { name: 'Work stream name' })).not.toBeInTheDocument();

    // Keyboard activation of a button reports a detail of 0.
    fireEvent.click(title, { detail: 0 });
    expect(screen.getByRole('textbox', { name: 'Work stream name' })).toBeInTheDocument();
  });

  it('holds the header for a name instead of showing the request it was created from', () => {
    const { rerender } = renderWorkstreamHeader({
      ...headerWorkstream,
      title: 'Create an email draft to Danny from Mucker that shares the download link',
      titleStatus: 'naming',
      // A work stream is named seconds after it is created, which is the only
      // time the skeleton is shown; the fixture's own date is days old, and
      // past the grace the provisional title is the title.
      createdAt: new Date().toISOString(),
    });

    // The heading is what carries the name, so it is the heading that has to
    // say a name is coming — a label on the placeholder itself reaches nobody.
    expect(screen.getByRole('heading', { name: 'Rally is naming this work stream' })).toBeInTheDocument();
    expect(screen.queryByText(/Create an email draft/u)).not.toBeInTheDocument();
    // Nothing to rename yet: the title on the row is a placeholder, and the
    // editor returns with the name a second later.
    expect(screen.queryByRole('button', { name: /Create an email draft/u })).not.toBeInTheDocument();

    // A name that arrives on its own has to be announced, or the skeleton has
    // promised something the header never delivers.
    const line = document.querySelector('.workstream-title-line');
    expect(line).toHaveAttribute('aria-live', 'polite');

    rerender(headerElement({ ...headerWorkstream, title: 'Download link email to Danny' }));
    expect(screen.getByRole('heading', { name: 'Download link email to Danny' })).toBeInTheDocument();
  });

  it('gives up on a name that never arrives rather than pulsing for the session', () => {
    vi.useFakeTimers();
    try {
      const created = new Date('2026-08-07T12:00:00.000Z');
      vi.setSystemTime(created);
      renderWorkstreamHeader({
        ...headerWorkstream,
        title: 'Create an email draft to Danny from Mucker',
        titleStatus: 'naming',
        createdAt: created.toISOString(),
      });

      expect(screen.getByRole('heading', { name: 'Rally is naming this work stream' })).toBeInTheDocument();

      // Nothing refetches this query on its own, so a rename event that never
      // arrived would otherwise leave the skeleton up for good.
      act(() => { vi.advanceTimersByTime(WORKSTREAM_NAMING_GRACE_MS + 1_000); });

      expect(screen.queryByRole('heading', { name: 'Rally is naming this work stream' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create an email draft to Danny from Mucker' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops announcing the title line while someone is typing a new name into it', () => {
    renderWorkstreamHeader();

    expect(document.querySelector('.workstream-title-line')).toHaveAttribute('aria-live', 'polite');

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));

    // The person renaming it is typing the new name; reading their own edit
    // back to them, and the swap from heading to form, is noise.
    expect(document.querySelector('.workstream-title-line')).toHaveAttribute('aria-live', 'off');
  });

  it('opens the editor on F2', () => {
    renderWorkstreamHeader();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Daily product brief' }), { key: 'F2' });

    expect(screen.getByRole('textbox', { name: 'Work stream name' })).toBeInTheDocument();
  });

  it('keeps the tooltip on the rename hint while the whole name is on screen', () => {
    renderWorkstreamHeader();

    // jsdom reports a zero width for everything, which reads as a title that
    // fits — the case where the hint is the only thing worth saying.
    expect(screen.getByRole('button', { name: 'Daily product brief' }))
      .toHaveAttribute('title', 'Double-click to rename');
  });

  it('leads the tooltip with the name once the header is too narrow to show it', () => {
    const widths = stubElementWidths({ clientWidth: 180, scrollWidth: 260 });
    try {
      const title = 'Email draft to Danny about the download link';
      const { rerender } = renderWorkstreamHeader({ ...headerWorkstream, title });

      // The ellipsis is the only thing standing between the reader and the
      // name, and it is not recoverable anywhere else on the screen.
      expect(screen.getByRole('button', { name: title }))
        .toHaveAttribute('title', `${title}\nDouble-click to rename`);

      // A shorter name that fits leaves nothing for the tooltip to recover.
      stubElementWidths({ clientWidth: 180, scrollWidth: 120 });
      rerender(headerElement({ ...headerWorkstream, title: 'Danny email' }));

      expect(screen.getByRole('button', { name: 'Danny email' }))
        .toHaveAttribute('title', 'Double-click to rename');
    } finally {
      widths.restore();
    }
  });

  it('measures the title again after the rename editor gives the heading back', () => {
    const widths = stubElementWidths({ clientWidth: 180, scrollWidth: 260 });
    try {
      const title = 'Email draft to Danny about the download link';
      renderWorkstreamHeader({ ...headerWorkstream, title });

      expect(screen.getByRole('button', { name: title }))
        .toHaveAttribute('title', `${title}\nDouble-click to rename`);

      // The editor replaces the heading outright, so the button that comes back
      // is a different element in a header that may have been resized while the
      // field was open — which is why the measurement follows the node rather
      // than being taken once.
      fireEvent.doubleClick(screen.getByRole('button', { name: title }));
      stubElementWidths({ clientWidth: 400, scrollWidth: 260 });
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Work stream name' }), { key: 'Escape' });

      expect(screen.getByRole('button', { name: title }))
        .toHaveAttribute('title', 'Double-click to rename');
    } finally {
      widths.restore();
    }
  });

  it('keeps the spoken description to the rename hint when the tooltip carries the name', () => {
    const widths = stubElementWidths({ clientWidth: 180, scrollWidth: 260 });
    try {
      const title = 'Email draft to Danny about the download link';
      renderWorkstreamHeader({ ...headerWorkstream, title });

      // Clipping is a visual state only: the button's accessible name is its
      // text either way, so a description that repeated the title would read
      // the whole name twice before reaching the part that is actually a hint.
      const button = screen.getByRole('button', { name: title });
      expect(button).toHaveAccessibleName(title);
      expect(button).toHaveAccessibleDescription('Double-click to rename');
      // The heading takes its own name from the button, and must not pick up
      // the hint sitting beside it.
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    } finally {
      widths.restore();
    }
  });

  it('caps the name at the length the contract accepts, as the sidebar dialog does', () => {
    renderWorkstreamHeader();

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));

    expect(screen.getByRole('textbox', { name: 'Work stream name' })).toHaveAttribute('maxlength', '180');
  });

  it('returns focus to the title when the editor closes, so the keyboard path can continue', async () => {
    const onRename = vi.fn(async () => undefined);
    renderWorkstreamHeader(headerWorkstream, { onRename });

    // Escape.
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Work stream name' }), { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Daily product brief' })).toHaveFocus();

    // Cancel.
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel rename' }));
    expect(screen.getByRole('button', { name: 'Daily product brief' })).toHaveFocus();

    // Save.
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Work stream name' }), { target: { value: 'Launch planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Daily product brief' })).toHaveFocus());
  });

  it('clears a failed save message on the next keystroke, so it never outlives its draft', async () => {
    const onRename = vi.fn(async () => {
      throw new Error('The request is invalid.');
    });
    renderWorkstreamHeader(headerWorkstream, { onRename });

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));
    const input = screen.getByRole('textbox', { name: 'Work stream name' });
    fireEvent.change(input, { target: { value: 'Rejected name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The request is invalid.');

    fireEvent.change(input, { target: { value: 'Corrected name' } });

    // The message stands where the status line goes, so a stale one hides the
    // work stream's real state.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leaves focus alone when a rename settles after the header moved on', async () => {
    let settle: (() => void) | undefined;
    const onRename = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    const { rerender } = renderWorkstreamHeader(headerWorkstream, { onRename });

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Work stream name' }), { target: { value: 'Launch planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(onRename).toHaveBeenCalled());

    rerender(headerElement({ ...headerWorkstream, id: 'workstream-other', title: 'Another stream' }, { onRename }));
    const elsewhere = screen.getByRole('button', { name: 'More work-stream actions' });
    elsewhere.focus();

    settle?.();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Another stream' })).toBeInTheDocument());

    // The stale rename must not yank focus onto the new stream's title.
    expect(elsewhere).toHaveFocus();
  });

  it('discards a rename that settles after the header moved to another work stream', async () => {
    let settle: (() => void) | undefined;
    const onRename = vi.fn(() => new Promise<void>((_resolve, reject) => {
      settle = () => reject(new Error('The stale stream could not be renamed.'));
    }));
    const { rerender } = renderWorkstreamHeader(headerWorkstream, { onRename });

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Daily product brief' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Work stream name' }), { target: { value: 'Launch planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('Launch planning'));

    rerender(headerElement({ ...headerWorkstream, id: 'workstream-other', title: 'Another stream' }, { onRename }));

    settle?.();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Another stream' })).toBeInTheDocument());

    // The old stream's failure must not land under the new stream's title, and
    // its editor must still be openable rather than stuck mid-save.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Another stream' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Work stream name' }), { target: { value: 'Renamed later' } });
    expect(screen.getByRole('button', { name: 'Save name' })).not.toBeDisabled();
  });
});

const transcript: Message[] = [
  {
    id: 'message-one',
    workstreamId: 'workstream-one',
    sequenceNumber: 1,
    attentionSequenceNumber: 1,
    authorType: 'human',
    messageType: 'text',
    text: 'Start',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'message-two',
    workstreamId: 'workstream-one',
    sequenceNumber: 2,
    attentionSequenceNumber: null,
    authorType: 'agent',
    messageType: 'tool_event',
    createdAt: '2026-08-01T00:00:01.000Z',
  },
  {
    id: 'message-three',
    workstreamId: 'workstream-one',
    sequenceNumber: 3,
    attentionSequenceNumber: 2,
    authorType: 'agent',
    messageType: 'text',
    text: 'Done',
    createdAt: '2026-08-01T00:00:02.000Z',
  },
];

describe('transcript read positioning', () => {
  it('opens one message before the first unread sequence to preserve context', () => {
    expect(initialTranscriptAnchorIndex(transcript, 2)).toBe(1);
    expect(initialTranscriptAnchorIndex(transcript, 1)).toBe(0);
    expect(initialTranscriptAnchorIndex(transcript, null)).toBeNull();
  });

  it('acknowledges visible attention messages but ignores tool and transient rows', () => {
    expect(highestVisibleAttentionSequence(transcript, [0, 1], 2)).toBe(1);
    expect(highestVisibleAttentionSequence(transcript, [1, 2], 2)).toBe(2);
    expect(highestVisibleAttentionSequence([
      ...transcript,
      { ...transcript[2]!, id: 'transient', sequenceNumber: 4, attentionSequenceNumber: null },
    ], [3], 2)).toBe(0);
  });

  it('does not acknowledge a settled run\'s accordion, which is machinery', () => {
    // It carries its turn's ordinal so the unread divider lands above it rather
    // than between it and its answer — but scrolling it into view, or scrolling
    // through an open one, says nothing about having read that answer.
    expect(highestVisibleAttentionSequence([
      ...transcript,
      {
        ...transcript[2]!, id: 'work-accordion', sequenceNumber: 4,
        messageType: 'work_accordion' as const, attentionSequenceNumber: 2,
      },
    ], [3], 2)).toBe(0);
  });
});

const openElicitation: ElicitationData = {
  id: 'elicitation-one',
  prompt: 'What should Rally do?',
  responseType: 'single_select',
  options: [{ label: 'Review it', value: 'review' }],
  minimumSelections: 1,
  maximumSelections: 1,
  status: 'open',
};

const harnessRun: HarnessRunMetadata = {
  id: 'run-one',
  origin: 'message',
  status: 'running',
  startedAt: '2026-08-05T12:00:00.000Z',
  createdAt: '2026-08-05T11:59:59.000Z',
};

describe('workstreamRunTiming', () => {
  it('adapts the current harness run to the shared live work timer', () => {
    expect(workstreamRunTiming('running', harnessRun)).toEqual({
      active: true,
      durationMs: 0,
      startedAt: Date.parse('2026-08-05T12:00:00.000Z'),
    });
  });

  it('retains the canonical elapsed time after the turn completes', () => {
    expect(workstreamRunTiming('completed', {
      ...harnessRun,
      status: 'completed',
      completedAt: '2026-08-05T12:01:23.000Z',
    })).toEqual({ active: false, durationMs: 83_000 });
  });

  it('does not describe a run awaiting input as completed work', () => {
    expect(workstreamRunTiming('needs_input', {
      ...harnessRun,
      status: 'needs_input',
    })).toBeNull();
  });
});

describe('workstreamShowsReadyState', () => {
  it('never invites another start while a newly created run is admitted or running', () => {
    expect(workstreamShowsReadyState(0, false, 'scheduled')).toBe(false);
    expect(workstreamShowsReadyState(0, false, 'running')).toBe(false);
    expect(workstreamShowsReadyState(0, false, 'completed')).toBe(true);
    expect(workstreamShowsReadyState(1, false, 'completed')).toBe(false);
    expect(workstreamShowsReadyState(0, true, 'completed')).toBe(false);
  });
});

describe('orderedTranscriptOwnsRunTiming', () => {
  it('replaces the legacy timer only after the canonical response timing has an ordered turn anchor', () => {
    const snapshot: NonNullable<Parameters<typeof orderedTranscriptOwnsRunTiming>[0]> = {
      activities: [
        { activityId: 'run-one:activity', parentActivityId: null, scope: 'response', subjectId: 'run-one' },
        {
          activityId: 'run-one:turn:1:activity',
          parentActivityId: 'run-one:activity',
          scope: 'assistant_turn',
          subjectId: 'run-one:turn:1',
        },
      ],
      ranges: [],
      activeTurns: [],
    };

    expect(orderedTranscriptOwnsRunTiming(snapshot, 'run-one')).toBe(false);
    snapshot.ranges = [{
      turns: [{ activityId: 'run-one:turn:1:activity' }],
    }];
    expect(orderedTranscriptOwnsRunTiming(snapshot, 'run-one')).toBe(true);
    expect(orderedTranscriptOwnsRunTiming(snapshot, 'run-two')).toBe(false);
    expect(orderedTranscriptOwnsRunTiming(undefined, 'run-one')).toBe(false);
  });
});

describe('manualElicitationResponse', () => {
  it('turns a composer entry into a custom single-select response', () => {
    expect(manualElicitationResponse(openElicitation, '  Take a closer look  ')).toEqual({
      answer: 'Take a closer look',
      customResponse: 'Take a closer look',
    });
  });

  it('wraps a custom multi-select response and leaves text responses as text', () => {
    expect(manualElicitationResponse({ ...openElicitation, responseType: 'multi_select' }, 'Summarize both')).toEqual({
      answer: ['Summarize both'],
      customResponse: 'Summarize both',
    });
    expect(manualElicitationResponse({ ...openElicitation, responseType: 'text' }, 'Explain the risk')).toEqual({
      answer: 'Explain the risk',
    });
  });
});

describe('WorkstreamErrorState', () => {
  beforeEach(() => {
    copyText.mockReset();
    copyText.mockResolvedValue(undefined);
  });

  it('offers the work-stream ID from a More menu so an unopenable work stream can still be reported', async () => {
    const onRetry = vi.fn();
    render(
      <Tooltip.Provider>
        <WorkstreamErrorState description="An unexpected error occurred" onRetry={onRetry} workstreamId="workstream-unopenable" />
      </Tooltip.Provider>,
    );

    expect(screen.getByText('Work stream could not be opened')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More work-stream actions' }), {
      button: 0,
      ctrlKey: false,
    });
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Copy work-stream ID']);

    fireEvent.click(items[0]!);
    expect(copyText).toHaveBeenCalledWith('workstream-unopenable');
  });
});

describe('JumpToLatestButton', () => {
  it('is compact and icon-only while retaining an accessible action name', () => {
    const onJump = vi.fn();
    render(
      <Tooltip.Provider>
        <JumpToLatestButton onJump={onJump} />
      </Tooltip.Provider>,
    );

    const button = screen.getByRole('button', { name: 'Jump to latest' });
    expect(button).not.toHaveTextContent('Latest');
    fireEvent.click(button);
    expect(onJump).toHaveBeenCalledOnce();
  });
});

describe('RunFailureNotice', () => {
  it('shows a typed member-safe error and exposes retry and request-id actions', () => {
    const onCopyRequestId = vi.fn();
    const onRetry = vi.fn();
    render(
      <RunFailureNotice
        code="context_limit_exceeded"
        message="The run exceeded the model context window."
        onCopyRequestId={onCopyRequestId}
        onRetry={onRetry}
        requestId="run-request-123"
        retrying={false}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The run exceeded the model context window.');
    expect(screen.getByRole('alert')).toHaveTextContent('context_limit_exceeded');
    fireEvent.click(screen.getByRole('button', { name: 'Copy request ID' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onCopyRequestId).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('prevents a duplicate retry while the retry request is pending', () => {
    render(
      <RunFailureNotice
        code="provider_timeout"
        message="The provider timed out."
        onCopyRequestId={vi.fn()}
        onRetry={vi.fn()}
        retrying
      />,
    );

    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });
});

describe('RunStoppedNotice', () => {
  it('makes a terminal member stop explicit and offers a fresh retry', () => {
    const onRetry = vi.fn();
    render(<RunStoppedNotice onRetry={onRetry} retrying={false} />);

    expect(screen.getByRole('status', { name: 'Run stopped' }))
      .toHaveTextContent('Its partial tool activity is no longer running.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('AddParticipantDialog', () => {
  const member = (id: string, name: string, status?: 'active' | 'invited' | 'suspended') => ({
    id,
    name,
    email: `${name.toLowerCase()}@example.com`,
    timezone: 'UTC',
    ...(status ? { status } : {}),
  });

  it('shows why an add was refused instead of leaving the dialog looking idle', () => {
    render(
      <Tooltip.Provider>
        <AddParticipantDialog
          current={[]}
          error="A participant is not an active workspace member"
          members={[member('member-1', 'Adam', 'active')]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          onOpenChange={vi.fn()}
          open
          pending={false}
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByText('A participant is not an active workspace member')).toBeTruthy();
    // The list stays usable: the refusal is about one attempt, not the dialog.
    expect(screen.getByRole('button', { name: /Adam/u })).toBeTruthy();
  });

  it('offers only active memberships, because the endpoint refuses the rest', () => {
    const onAdd = vi.fn();
    render(
      <Tooltip.Provider>
        <AddParticipantDialog
          current={[]}
          members={[
            member('member-1', 'Adam', 'active'),
            member('member-2', 'Invited', 'invited'),
            member('member-3', 'Suspended', 'suspended'),
          ]}
          onAdd={onAdd}
          onRemove={vi.fn()}
          onOpenChange={vi.fn()}
          open
          pending={false}
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('button', { name: /Adam/u })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Invited/u })).toBeNull();
    expect(screen.queryByRole('button', { name: /Suspended/u })).toBeNull();
  });

  it('keeps a person whose status the caller did not resolve', () => {
    // Participants and viewers reach this dialog without a status; treating a
    // missing one as inactive would empty the list for every caller but the
    // workspace roster.
    render(
      <Tooltip.Provider>
        <AddParticipantDialog
          current={[]}
          members={[member('member-1', 'Unstated')]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          onOpenChange={vi.fn()}
          open
          pending={false}
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('button', { name: /Unstated/u })).toBeTruthy();
  });

  it('shows participants beside addable members and gives participants a destructive menu', () => {
    const adam = member('member-1', 'Adam', 'active');
    const katherine = member('member-2', 'Katherine', 'active');
    const suspendedKatherine = member('member-2', 'Katherine', 'suspended');
    const jordan = member('member-3', 'Jordan', 'active');
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    render(
      <Tooltip.Provider>
        <AddParticipantDialog
          current={[adam, katherine]}
          members={[adam, suspendedKatherine, jordan]}
          onAdd={onAdd}
          onRemove={onRemove}
          onOpenChange={vi.fn()}
          open
          pending={false}
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('button', { name: 'Add Jordan to work stream' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Katherine participant actions' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add Adam to work stream' })).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Adam participant actions' }), {
      button: 0,
      ctrlKey: false,
    });
    const remove = screen.getByRole('menuitem', { name: 'Remove from work stream' });
    expect(remove).toHaveClass('menu-item-danger');
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledWith(adam);

    // The whole nonparticipant row remains the add target; only an existing
    // participant's row delegates its action to the ellipsis control.
    fireEvent.click(screen.getByText('Jordan'));
    expect(onAdd).toHaveBeenCalledWith(jordan);
  });

  it('keeps the final participant visible but disables removing them', () => {
    const adam = member('member-1', 'Adam', 'active');
    render(
      <Tooltip.Provider>
        <AddParticipantDialog
          current={[adam]}
          members={[adam]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          onOpenChange={vi.fn()}
          open
          pending={false}
        />
      </Tooltip.Provider>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Adam participant actions' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByRole('menuitem', { name: 'Remove from work stream' }))
      .toHaveAttribute('data-disabled');
  });
});

describe('AddResourceDialog', () => {
  it('searches and attaches discovered connector resources while retaining upload fallback', () => {
    const resource: WorkstreamResource = {
      id: 'resource-1',
      title: 'Rally release pull request',
      resourceType: 'github_pull_request',
      provider: 'github',
      canonicalUrl: 'https://github.com/juno-ai-labs/rally/pull/42',
      refreshSupported: true,
      watchEnabled: false,
      watchStatus: 'paused',
      currentVersion: 1,
      relationshipType: 'attachment',
      direction: 'source',
    };
    const onAttach = vi.fn();
    const onSearchChange = vi.fn();
    const onUpload = vi.fn();
    render(
      <Tooltip.Provider>
        <AddResourceDialog
          current={[]}
          fetching={false}
          hasMore={false}
          loading={false}
          onAttach={onAttach}
          onLoadMore={vi.fn()}
          onOpenChange={vi.fn()}
          onSearchChange={onSearchChange}
          onUpload={onUpload}
          open
          pending={false}
          resources={[resource]}
          search=""
        />
      </Tooltip.Provider>,
    );

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search resources' }), { target: { value: 'release' } });
    expect(onSearchChange).toHaveBeenCalledWith('release');
    fireEvent.click(screen.getByRole('button', { name: /Rally release pull request/u }));
    expect(onAttach).toHaveBeenCalledWith(resource);
    fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
    expect(onUpload).toHaveBeenCalledOnce();
  });
});

describe('workspaceMemberFromSession', () => {
  it('uses the signed-in person for an optimistic human message in a multiplayer stream', () => {
    const session: DesktopSession = {
      accessToken: 'access-token-longer-than-twenty-characters',
      expiresAt: '2026-07-31T20:00:00.000Z',
      apiBaseUrl: 'https://api.rallywith.ai',
      user: {
        id: 'user-current',
        name: 'Current Person',
        email: 'current@example.com',
        avatarUrl: 'https://example.com/current.png',
      },
      workspace: {
        id: 'workspace-one',
        name: 'Rally',
        region: 'global',
        role: 'member',
      },
    };

    expect(workspaceMemberFromSession(session)).toEqual({
      id: 'user-current',
      name: 'Current Person',
      email: 'current@example.com',
      avatarUrl: 'https://example.com/current.png',
      role: 'member',
      timezone: 'America/Los_Angeles',
    });
  });
});
