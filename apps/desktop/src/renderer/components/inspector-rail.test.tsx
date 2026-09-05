import { SITE_MANIFEST_MIME_TYPE } from '@rally/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_CONVERTER_TIMEOUT_MS, ATTACHMENT_PROCESSING_LEASE_MS } from '@rally/contracts';
import type { DesktopApplicationSettings } from '../../common/desktop';
import type {
  ResourceVersion,
  WorkstreamAutomationSummary,
  WorkstreamDetail,
  WorkstreamResource,
} from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { ApiError } from '../lib/api';
import { InspectorRail } from './inspector-rail';
import { MAX_RESOURCE_PREVIEW_WAIT_MS, readResourcePreviewText } from '../lib/resource-preview';

const copyText = vi.hoisted(() => vi.fn());
const applicationSettings = vi.hoisted(() => ({
  current: { lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true },
  listeners: new Set<(settings: unknown) => void>(),
}));

function announceApplicationSettings(settings: DesktopApplicationSettings): void {
  applicationSettings.current = settings;
  act(() => {
    for (const listener of applicationSettings.listeners) listener(settings);
  });
}

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    copyText,
    getApplicationSettings: () => Promise.resolve(applicationSettings.current),
    onApplicationSettingsChanged: (listener: (settings: unknown) => void) => {
      applicationSettings.listeners.add(listener);
      return () => applicationSettings.listeners.delete(listener);
    },
  }),
}));

const workstream: WorkstreamDetail = {
  id: 'workstream-1',
  title: 'Monday invoice review',
  titleStatus: 'settled' as const,
  emailAddress: 'luminous-tidal-structured-curie@automation.rallywith.ai',
  harnessStatus: 'completed',
  scope: 'workspace' as const,
  lastActivityAt: '2026-07-31T20:00:12.000Z',
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
  createdAt: '2026-07-31T20:00:00.000Z',
  participants: [],
  viewers: [],
  resources: [],
  connections: [],
  backgroundTasks: [],
  latestHarnessRunId: 'harness-run-1',
  latestHarnessRun: {
    id: 'harness-run-1',
    origin: 'automation_schedule',
    status: 'completed',
    model: 'google/gemini-2.5-flash-lite',
    startedAt: '2026-07-31T20:00:00.000Z',
    completedAt: '2026-07-31T20:00:12.000Z',
    createdAt: '2026-07-31T20:00:00.000Z',
  },
};

describe('InspectorRail details', () => {
  beforeEach(() => {
    copyText.mockReset();
    copyText.mockResolvedValue(undefined);
    applicationSettings.listeners.clear();
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true };
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    useUiStore.setState({
      railOpen: true,
      railVariant: 'context',
      railWidth: 360,
      inspector: null,
    });
  });

  it('steps the stored width from the handle standing beside the rail', () => {
    // jsdom has no CSS layout; supply the geometry of the shared CSS probe,
    // not a second implementation of the responsive-width formula.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return DOMRect.fromRect({ width: this.classList.contains('rail-resizer-limit') ? 560 : 0 });
    });
    const { container } = render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );
    // The class is the whole contract: `.rail-scroll` in `app.css` owns the
    // scrolling, the reserved gutter and the overscroll containment for this
    // rail, and renaming it here would remove those behaviors without anything
    // else noticing.
    expect(container.querySelector('.rail-scroll')).not.toBeNull();
    const handle = screen.getByRole('separator', { name: 'Resize inspector' });

    expect(handle).toHaveAttribute('aria-valuemax', '560');
    expect(handle).toHaveAttribute('aria-valuenow', '360');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(useUiStore.getState().railWidth).toBe(344);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(useUiStore.getState().railWidth).toBe(360);
  });

  it('starts a pointer drag from the visible width rather than a larger saved width', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return DOMRect.fromRect({ width: this.classList.contains('rail-resizer-limit') ? 560 : 0 });
    });
    useUiStore.setState({ railWidth: 900 });
    render(<Tooltip.Provider><InspectorRail workstream={workstream} /></Tooltip.Provider>);
    const handle = screen.getByRole('separator', { name: 'Resize inspector' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 464 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 480 });
    expect(useUiStore.getState().railWidth).toBe(544);
    fireEvent.pointerUp(handle, { pointerId: 1 });
  });

  it('opens resource management in a lightbox without opening the shell rail', () => {
    useUiStore.setState({ railOpen: false });
    const onSelect = vi.fn();
    const onAddResource = vi.fn();
    render(<Tooltip.Provider><InspectorRail workstream={{ ...workstream, resources: [watched] }} onAddResource={onAddResource} lightbox={{ resourceId: null, returnFocus: document.body, onSelect, onClose: vi.fn() }} /></Tooltip.Provider>);
    expect(screen.getByRole('dialog', { name: 'Resources' })).toBeVisible();
    expect(document.querySelector('.rail-surface')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add resource' }));
    expect(onAddResource).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(watched.title, 'u') }));
    expect(onSelect).toHaveBeenCalledWith(watched.id);
    expect(useUiStore.getState().railOpen).toBe(false);
  });

  it('shows bounded harness-run metadata while debugging is on', async () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    expect(await screen.findByText('google/gemini-2.5-flash-lite')).toBeVisible();
    expect(screen.getByText('automation schedule')).toBeVisible();
    expect(screen.getByText('harness-run-1')).toBeVisible();
    expect(screen.getByText('workstream-1')).toBeVisible();
  });

  it('collapses Details to the four human-facing rows when debugging is turned off', async () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    const details = screen.getByText('Email').closest('dl') as HTMLElement;
    const labels = (): string[] => [...details.querySelectorAll('dt')].map((term) => term.textContent ?? '');

    // The stored preference is on, so the wiring rows have to arrive before the
    // collapse below can mean anything.
    await waitFor(() => expect(labels()).toContain('Harness run'));

    // The Settings window owns the preference, so the rail learns about a
    // change through the application-settings broadcast.
    announceApplicationSettings({ lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });

    expect(labels()).toEqual(['Email', 'Created by', 'Created', 'Last activity']);
    expect(within(details).queryByText('harness-run-1')).not.toBeInTheDocument();
  });

  it('clips the address to one line in both states so the row reads the same way', async () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    const address = (): HTMLElement => screen.getByText(workstream.emailAddress ?? '');
    await waitFor(() => expect(screen.getByText('Harness run')).toBeVisible());
    expect(address()).toHaveAttribute('title', workstream.emailAddress);

    announceApplicationSettings({ lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });

    expect(address()).toHaveAttribute('title', workstream.emailAddress);
  });

  it('shows the complete work-stream email address in Details and copies it with feedback', async () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    const emailAddress = 'luminous-tidal-structured-curie@automation.rallywith.ai';
    expect(screen.getByText(emailAddress)).toBeVisible();

    const copyButton = screen.getByRole('button', { name: 'Copy work-stream email address' });
    expect(copyButton).toHaveAttribute('title', 'Copy work-stream email address');
    fireEvent.click(copyButton);

    expect(copyText).toHaveBeenCalledWith(emailAddress);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Work-stream email address copied' })).toHaveAttribute('title', 'Copied');
    });
  });

  it('keeps the icon copy control retryable when the clipboard rejects the write', async () => {
    copyText.mockRejectedValueOnce(new Error('clipboard unavailable'));

    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy work-stream email address' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy failed; retry work-stream email address' }))
        .toHaveAttribute('title', 'Copy failed — click to retry');
    });
    expect(screen.getByRole('status')).toHaveTextContent('could not be copied');
  });

  // The watch control sits beside the button that opens the resource, rather
  // than inside it, and the two are kept apart by sibling order and a
  // positioned overlay. These lock that arrangement in.
  const watched: WorkstreamResource = {
    id: 'resource-1',
    title: 'Linear issue create: AVA-9',
    resourceType: 'issue',
    provider: 'linear',
    refreshSupported: true,
    watchEnabled: false,
    watchStatus: 'paused',
    currentVersion: 3,
    relationshipType: 'attachment',
    direction: 'source',
  };

  function renderResources(resources: WorkstreamResource[], onToggleWatch = vi.fn()): { onToggleWatch: ReturnType<typeof vi.fn> } {
    render(
      <Tooltip.Provider>
        <InspectorRail onToggleWatch={onToggleWatch} workstream={{ ...workstream, resources }} />
      </Tooltip.Provider>,
    );
    return { onToggleWatch };
  }

  it('toggles the watch without opening the resource it belongs to', () => {
    const { onToggleWatch } = renderResources([watched]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Watch' }));

    expect(onToggleWatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'resource-1' }), true);
    expect(useUiStore.getState().inspector).toBeNull();
  });

  it('keeps incoming sources and generated artifacts in one resources section', () => {
    renderResources([
      watched,
      {
        ...watched,
        id: 'resource-2',
        title: 'Generated release brief',
        provider: 'rally_generated',
        relationshipType: 'generated',
        direction: 'artifact',
      },
    ]);

    const resources = screen.getByRole('heading', { name: 'Resources' }).closest('section')!;
    expect(within(resources).getByText(watched.title)).toBeVisible();
    expect(within(resources).getByText('Generated release brief')).toBeVisible();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('opens the resource from the row without touching the watch', () => {
    const { onToggleWatch } = renderResources([watched]);

    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));

    expect(useUiStore.getState().inspector).toEqual({ type: 'resource', id: 'resource-1' });
    expect(onToggleWatch).not.toHaveBeenCalled();
  });

  it('names every watch state in full even where the row shows the short form', () => {
    renderResources([
      watched,
      { ...watched, id: 'resource-2', title: 'Watched doc', watchEnabled: true, watchStatus: 'watching' },
      { ...watched, id: 'resource-3', title: 'Local note', provider: 'fixture', watchStatus: 'unsupported' },
      { ...watched, id: 'resource-4', title: 'Stale issue', watchStatus: 'error' },
    ]);

    expect(screen.getByRole('checkbox', { name: 'Watch' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Watching' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Watch unavailable' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Watch needs attention' })).toBeEnabled();
    expect(screen.getByText('Unavailable')).toBeVisible();
    expect(screen.getByText('Needs attention')).toBeVisible();
  });

  const historyEntry = { title: 'Linear issue create: AVA-9', mimeType: 'text/markdown', contentAvailable: true };
  const history: ResourceVersion[] = [
    { ...historyEntry, version: 3, capturedAt: '2026-07-31T14:14:00.000Z', author: { kind: 'agent', runId: 'run-1' }, cause: 'published' },
    { ...historyEntry, version: 2, capturedAt: '2026-07-31T13:40:00.000Z', author: { kind: 'connector', connectionId: 'connection-1' }, cause: 'refetched' },
    { ...historyEntry, version: 1, capturedAt: '2026-07-31T11:02:00.000Z', author: { kind: 'member', userId: 'user-1' }, cause: 'created' },
  ];

  it('lists a resource’s versions with who moved it and when', () => {
    render(
      <Tooltip.Provider>
        <InspectorRail
          resourceVersions={history}
          workstream={{
            ...workstream,
            participants: [{ id: 'user-1', name: 'Alex', email: 'alex@example.test', timezone: 'UTC' }],
            resources: [watched],
          }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Versions' }));

    const versions = screen.getByRole('menu', { name: 'Versions' });
    // Newest first, and the current one is not something to open a copy of.
    expect(within(versions).getAllByRole('menuitem').map((row) => row.textContent))
      .toEqual([
        expect.stringContaining('V3'),
        expect.stringContaining('V2'),
        expect.stringContaining('V1'),
      ]);
    expect(within(versions).getByText(/Current/u)).toBeVisible();
    expect(within(versions).getByRole('menuitem', { name: /V1/u })).not.toHaveAttribute('aria-disabled', 'true');
    expect(within(versions).getByRole('menuitem', { name: /V3/u })).toHaveAttribute('aria-disabled', 'true');
    // Who moved it, in words the rail can actually show: Rally for a run, the
    // participant's own name for a member, the provider for a connector.
    expect(within(versions).getByText('Rally')).toBeVisible();
    expect(within(versions).getByText('linear')).toBeVisible();
    expect(within(versions).getByText('Alex')).toBeVisible();
    // The document stays in the rail; Versions is a header dropdown, not a pane.
    // Radix marks the rest of the page inert while the menu is open, so the
    // title is hidden from the accessibility tree without leaving the DOM.
    expect(document.querySelector('.inspector-detail')).not.toBeNull();
    expect(screen.getByRole('heading', { hidden: true, name: watched.title })).toBeInTheDocument();
  });

  it('marks the newest version current even when the detail has not caught up', () => {
    // The list and the resource detail are separate caches. Deriving "current"
    // from the detail's number puts the badge on a superseded row the moment
    // they disagree — and offers to open the live one as history, which is the
    // inversion this whole surface exists to prevent.
    render(
      <Tooltip.Provider>
        <InspectorRail
          resourceVersions={history}
          workstream={{ ...workstream, resources: [{ ...watched, currentVersion: 2 }] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Versions' }));

    const versions = screen.getByRole('menu', { name: 'Versions' });
    expect(within(versions).getByRole('menuitem', { name: /V3/u })).toHaveAttribute('aria-disabled', 'true');
    expect(within(versions).getByRole('menuitem', { name: /V2/u })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('says a version cannot be opened rather than offering an unreadable one', () => {
    // The version routes serve stored bytes, with no per-version conversion —
    // so a PDF's prior version would reach the preview as binary noise.
    render(
      <Tooltip.Provider>
        <InspectorRail
          resourceVersions={[
            history[0]!,
            { ...history[1]!, mimeType: 'application/pdf', title: 'Report.pdf' },
          ]}
          workstream={{ ...workstream, resources: [watched] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Versions' }));

    expect(screen.getByRole('menuitem', { name: /V2/u })).toHaveAttribute('aria-disabled', 'true');
  });

  it('says history is unavailable rather than saying there is none', () => {
    render(
      <Tooltip.Provider>
        <InspectorRail
          resourceVersionsError="Rally could not load this history."
          workstream={{ ...workstream, resources: [watched] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Versions' }));

    // Offline, a 500, and "this document never changed" are four different
    // truths; silence tells the reader the last one.
    expect(screen.getByRole('menu', { name: 'Versions' })).toBeVisible();
    expect(screen.getByText('Rally could not load this history.')).toBeVisible();
  });

  it('says versions are loading rather than that there are none', () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={{ ...workstream, resources: [watched] }} />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Versions' }));

    expect(screen.getByText('Loading versions…')).toBeVisible();
    expect(screen.queryByText('No versions yet.')).toBeNull();
  });

  it('says there are no versions when the history loaded empty', () => {
    render(
      <Tooltip.Provider>
        <InspectorRail
          resourceVersions={[]}
          workstream={{ ...workstream, resources: [watched] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Versions' }));

    expect(screen.getByText('No versions yet.')).toBeVisible();
    expect(screen.queryByText('Loading versions…')).toBeNull();
  });

  it('opens a prior version read-only rather than replacing what is current', () => {
    const onOpenResourceVersion = vi.fn();
    render(
      <Tooltip.Provider>
        <InspectorRail
          onOpenResourceVersion={onOpenResourceVersion}
          resourceVersions={history}
          workstream={{ ...workstream, resources: [watched] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Versions' }));

    fireEvent.click(screen.getByRole('menuitem', { name: /V2/u }));

    expect(onOpenResourceVersion).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'resource-1' }),
      expect.objectContaining({ version: 2 }),
      // The control that opened it, so the preview can hand focus back to the
      // rail instead of dropping it on the document.
      expect.any(HTMLElement),
    );
  });

  it('still lists a single version when Versions is opened', () => {
    render(
      <Tooltip.Provider>
        <InspectorRail
          resourceVersions={[history[2]!]}
          workstream={{ ...workstream, resources: [{ ...watched, currentVersion: 1 }] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));

    // One version is no history on the document itself. The Versions control
    // still opens onto that one row rather than pretending there is nothing.
    expect(screen.queryByRole('menu', { name: 'Versions' })).toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Versions' }));
    expect(screen.getByText('V1')).toBeVisible();
  });

  it('offers a re-fetch for a watched source, and none for a generated artifact', () => {
    const onRefreshResource = vi.fn();
    render(
      <Tooltip.Provider>
        <InspectorRail
          onRefreshResource={onRefreshResource}
          workstream={{ ...workstream, resources: [{ ...watched, watchEnabled: true, watchStatus: 'watching' }] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh from source' }));

    expect(onRefreshResource).toHaveBeenCalledWith(expect.objectContaining({ id: 'resource-1' }));
  });

  // Each half of the gate on its own, because a fixture that falsifies both at
  // once pins neither: a rail that dropped either condition passed it.
  it.each([
    ['Rally wrote it, so there is nowhere to re-fetch from', {
      title: 'Generated release brief', provider: 'rally_generated',
      relationshipType: 'generated' as const, direction: 'artifact' as const,
      watchEnabled: true, watchStatus: 'watching' as const,
    }],
    ['nothing external owns it, so a re-fetch has no source', {
      title: 'Uploaded brief', provider: 'avalon_upload',
      direction: 'source' as const, refreshSupported: false,
      watchStatus: 'unsupported' as const,
    }],
    ['its connector does not implement resource hydration', {
      title: 'Slack channel', provider: 'slack',
      direction: 'source' as const, refreshSupported: false,
      watchStatus: 'paused' as const,
    }],
  ])('offers no re-fetch when %s', (_reason, overrides) => {
    render(
      <Tooltip.Provider>
        <InspectorRail
          onRefreshResource={vi.fn()}
          workstream={{ ...workstream, resources: [{ ...watched, ...overrides }] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: new RegExp(overrides.title, 'u') }));

    expect(screen.queryByRole('button', { name: 'Refresh from source' })).toBeNull();
  });

  it('keeps the watch control out of the button that opens the resource', () => {
    renderResources([{ ...watched, watchStatus: 'unsupported' }]);

    const checkbox = screen.getByRole('checkbox', { name: 'Watch unavailable' });
    expect(checkbox).toBeDisabled();
    // Nesting the label back inside the button would send its clicks to the
    // resource instead of the checkbox, which is the arrangement this row
    // exists to avoid. jsdom has no layout, so the overlay that widens the
    // button's hit area back over the whole row is checked in a real engine.
    expect(screen.getByRole('button', { name: /Linear issue create: AVA-9/ })).not.toContainElement(checkbox);
  });

  it('puts the resource name in the header and drops the metadata card', () => {
    render(
      <Tooltip.Provider>
        <InspectorRail
          onDetachResource={vi.fn()}
          workstream={{ ...workstream, resources: [{ ...watched, updatedAt: '2026-08-29T19:54:00.000Z' }] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));

    expect(screen.getByRole('heading', { name: watched.title })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Details' })).toBeNull();
    expect(screen.queryByText('Type')).toBeNull();
    expect(screen.queryByText('Direction')).toBeNull();
    expect(screen.queryByText('Version')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.getByText(/Last updated/u)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Versions' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Archive' })).toHaveClass('icon-button-danger');
  });

  it('hides Archive when nothing can unlink the resource', () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={{ ...workstream, resources: [watched] }} />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));

    expect(screen.getByRole('button', { name: 'Versions' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('asks before archiving, and Continue unlinks the resource', async () => {
    const onDetachResource = vi.fn();
    render(
      <Tooltip.Provider>
        <InspectorRail
          onDetachResource={onDetachResource}
          workstream={{ ...workstream, resources: [watched] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    const dialog = screen.getByRole('dialog', { name: 'Archive this resource?' });
    expect(dialog).toHaveAccessibleDescription(/will leave this work stream/u);
    expect(within(dialog).getByText(new RegExp(watched.title, 'u'))).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onDetachResource).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(onDetachResource).toHaveBeenCalledWith(expect.objectContaining({ id: 'resource-1' }));
    });
    expect(useUiStore.getState().inspector).toBeNull();
  });

  it('keeps the archive dialog open when the unlink fails', async () => {
    const onDetachResource = vi.fn(async () => {
      throw new Error('The work stream refused the unlink.');
    });
    render(
      <Tooltip.Provider>
        <InspectorRail
          onDetachResource={onDetachResource}
          workstream={{ ...workstream, resources: [watched] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('The work stream refused the unlink.')).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Archive this resource?' })).toBeVisible();
    expect(useUiStore.getState().inspector).toEqual({ type: 'resource', id: 'resource-1' });
  });

  it('disables archive actions while the unlink is in flight', async () => {
    let finish: (() => void) | undefined;
    const onDetachResource = vi.fn(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    render(
      <Tooltip.Provider>
        <InspectorRail
          onDetachResource={onDetachResource}
          workstream={{ ...workstream, resources: [watched] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Continue' })).toBeDisabled();
    });
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(useUiStore.getState().inspector).toEqual({ type: 'resource', id: 'resource-1' });

    finish?.();
    await waitFor(() => {
      expect(useUiStore.getState().inspector).toBeNull();
    });
  });

  it('groups versions under sparse relative dates', () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14).toISOString();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 11).toISOString();
    render(
      <Tooltip.Provider>
        <InspectorRail
          resourceVersions={[
            { ...historyEntry, version: 3, capturedAt: today, author: { kind: 'agent', runId: 'run-1' }, cause: 'published' },
            { ...historyEntry, version: 2, capturedAt: yesterday, author: { kind: 'connector', connectionId: 'connection-1' }, cause: 'refetched' },
          ]}
          workstream={{ ...workstream, resources: [watched] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Versions' }));

    expect(screen.getByText('today')).toBeVisible();
    expect(screen.getByText('yesterday')).toBeVisible();
  });

});

describe('resource detail content preview', () => {
  // This block used to inherit `railOpen` from the suite above it, which held
  // only in source order: shuffled, the rail rendered nothing and every test
  // here failed against an empty document (7 of 12 runs under
  // `--sequence.shuffle`). A describe block owns its own store state.
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    useUiStore.setState({ railOpen: true, railVariant: 'context', railWidth: 360, inspector: null });
  });

  const note: WorkstreamResource = {
    id: 'resource-note',
    title: 'Q3 board deck',
    resourceType: 'document',
    mimeType: 'text/markdown',
    contentAvailable: true,
    refreshSupported: false,
    watchEnabled: false,
    watchStatus: 'unsupported',
    currentVersion: 2,
    updatedAt: '2026-08-29T19:54:00.000Z',
    relationshipType: 'context',
    direction: 'artifact',
  };

  function openDetail(resource: WorkstreamResource, loadResourceContent?: (id: string, signal?: AbortSignal) => Promise<Blob>) {
    render(
      <Tooltip.Provider>
        <InspectorRail
          {...(loadResourceContent ? { loadResourceContent } : {})}
          workstream={{ ...workstream, resources: [resource] }}
        />
      </Tooltip.Provider>,
    );
    act(() => { useUiStore.getState().inspect({ type: 'resource', id: resource.id }); });
  }

  const site: WorkstreamResource = {
    ...note,
    id: 'resource-site',
    title: 'Offsite RSVP',
    resourceType: 'generated_site',
    mimeType: SITE_MANIFEST_MIME_TYPE,
  };

  function siteArtifacts() {
    return {
      openArtifact: vi.fn(async () => ({
        openUrl: 'https://3f2504e0-4f89-41d3-9a0c-0305e82c3301-g.rallyusercontent.test/__rally/open#c',
        canonicalUrl: 'https://3f2504e0-4f89-41d3-9a0c-0305e82c3301-g.rallyusercontent.test',
        artifactId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        mode: 'active' as const,
        stateful: false,
      })),
      describeData: vi.fn(async () => ({ tables: [] })),
      loadTable: vi.fn(async () => ({ rows: [], csv: '' })),
      loadErrors: vi.fn(async () => []),
      surface: {
        present: vi.fn(async () => true),
        setBounds: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        popOut: vi.fn(async () => undefined),
        copyText: vi.fn(async () => undefined),
        openExternal: vi.fn(async () => undefined),
      },
    };
  }

  it('shows a live artifact as a page to open rather than a record to describe', async () => {
    const artifacts = siteArtifacts();
    render(
      <Tooltip.Provider>
        <InspectorRail siteArtifacts={artifacts} workstream={{ ...workstream, resources: [site] }} />
      </Tooltip.Provider>,
    );
    act(() => { useUiStore.getState().inspect({ type: 'resource', id: site.id }); });
    await waitFor(() => expect(artifacts.surface.present).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Pop out/u })).toBeInTheDocument();
  });

  it('falls back to the ordinary resource card when live artifacts are off', () => {
    // Presentation only: with the flag off a site is still an ordinary resource
    // in the rail — it just is not rendered as a page.
    openDetail(site);
    expect(screen.queryByRole('button', { name: /Pop out/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Preview/u })).not.toBeInTheDocument();
    expect(document.querySelector('.inspector-detail')).toBeInTheDocument();
  });

  it('never tries to read a site as text, which would show its manifest', () => {
    // A site's stored content is the index, not the page.
    const loadResourceContent = vi.fn(async () => new Blob(['{"version":1}']));
    openDetail(site, loadResourceContent);
    expect(loadResourceContent).not.toHaveBeenCalled();
  });

  it('renders the resource content beneath its metadata, so a citation is not a dead end', async () => {
    const loadResourceContent = vi.fn(async () => new Blob(['## Findings\n\nRevenue grew 40%.']));
    openDetail(note, loadResourceContent);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Findings' })).toBeInTheDocument());
    // The rail is the document reader, not a compact transcript reply. Its
    // sections stay fully rendered rather than inheriting the feed's heading
    // accordions and three-line preview.
    expect(screen.queryByRole('button', { name: 'Collapse section' })).not.toBeInTheDocument();
    expect(document.querySelector('.markdown-collapse')).toBeNull();
    expect(loadResourceContent).toHaveBeenCalledExactlyOnceWith('resource-note', expect.anything());
    // Last-updated sits in the same scroll as the body, not a metadata card.
    expect(screen.getByText(/Last updated/u)).toBeInTheDocument();
    expect(screen.queryByText('Version')).not.toBeInTheDocument();
    expect(document.querySelector('.inspector-detail-preview')).toBeNull();
    expect(document.querySelector('.inspector-detail-document')).not.toBeNull();
    const updated = screen.getByText(/Last updated/u);
    const rule = document.querySelector('.inspector-detail-rule');
    const documentBody = document.querySelector('.inspector-detail-document');
    expect(rule).not.toBeNull();
    expect(updated.compareDocumentPosition(rule!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(rule!.compareDocumentPosition(documentBody!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('renders an image resource in the detail instead of leaving it empty', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:diagram');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const loadResourceContent = vi.fn(async () => new Blob(['PNG'], { type: 'image/png' }));
    try {
      openDetail({
        ...note,
        id: 'resource-image',
        title: 'diagram.png',
        mimeType: 'image/png',
      }, loadResourceContent);

      const image = await screen.findByRole('img', { name: 'diagram.png' });
      expect(image).toHaveAttribute('src', 'blob:diagram');
      expect(document.querySelector('.inspector-detail-document')).not.toBeNull();
      expect(loadResourceContent).toHaveBeenCalledExactlyOnceWith('resource-image', expect.anything());
    } finally {
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });

  it('renders generated audio in the detail as a disclosed player', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:voice');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const loadResourceContent = vi.fn(async () => new Blob(['ID3audio'], { type: 'audio/mpeg' }));
    try {
      openDetail({
        ...note,
        id: 'resource-audio',
        title: 'launch-update.mp3',
        mimeType: 'audio/mpeg',
      }, loadResourceContent);

      const player = await screen.findByLabelText('Audio: launch-update.mp3');
      expect(player.tagName).toBe('AUDIO');
      expect(player).toHaveAttribute('controls');
      expect(player).toHaveAttribute('src', 'blob:voice');
      expect(loadResourceContent).toHaveBeenCalledExactlyOnceWith('resource-audio', expect.anything());
    } finally {
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });

  it('re-reads the content when the resource is revised in place', async () => {
    // A watched source re-ingested keeps its id, and the metadata beside this
    // preview shows the new version number — so keying the read on the id alone
    // put version 3's number over version 2's text, which is a citation
    // substantiating a claim with the wrong revision.
    let revision = 2;
    const loadResourceContent = vi.fn(async () => new Blob([`## Findings\n\nRevenue grew ${revision}0%.`]));
    const { rerender } = render(
      <Tooltip.Provider>
        <InspectorRail loadResourceContent={loadResourceContent} workstream={{ ...workstream, resources: [note] }} />
      </Tooltip.Provider>,
    );
    act(() => { useUiStore.getState().inspect({ type: 'resource', id: note.id }); });
    await waitFor(() => expect(screen.getByText('Revenue grew 20%.')).toBeInTheDocument());

    revision = 3;
    const revised = { ...note, currentVersion: note.currentVersion + 1 };
    rerender(
      <Tooltip.Provider>
        <InspectorRail loadResourceContent={loadResourceContent} workstream={{ ...workstream, resources: [revised] }} />
      </Tooltip.Provider>,
    );

    await waitFor(() => expect(screen.getByText('Revenue grew 30%.')).toBeInTheDocument());
  });

  it('renders a document\'s bytes as written, never through the model-text repair', async () => {
    // The repair rewrites what a *model* wrote. A stored document is a file, and
    // rewriting its bytes on the way to a reader is not this app's business.
    const loadResourceContent = vi.fn(async () => new Blob(['Cost is $\\rightarrow$ 40.']));
    openDetail(note, loadResourceContent);

    await waitFor(() => expect(screen.getByText(/Cost is/u)).toHaveTextContent('Cost is $\\rightarrow$ 40.'));
  });

  it('shows nothing but metadata for a resource with no stored content', () => {
    const loadResourceContent = vi.fn();
    openDetail({ ...note, contentAvailable: false }, loadResourceContent);

    expect(loadResourceContent).not.toHaveBeenCalled();
    expect(screen.getByText(/Last updated/u)).toBeInTheDocument();
  });

  it('says the preview is unavailable rather than leaving the panel half-drawn', async () => {
    const loadResourceContent = vi.fn(async () => { throw new Error('resource_content_unavailable'); });
    openDetail(note, loadResourceContent);

    await waitFor(() => expect(screen.getByText(/preview is not available/iu)).toBeInTheDocument());
    expect(screen.getByText(/Last updated/u)).toBeInTheDocument();
  });

  /** What `/resources/:id/preview` answers while a derivative is materializing. */
  function stillProcessing(retryAfterMs = 5): ApiError {
    return new ApiError('The attachment preview is still being prepared', 409, 'resource_processing', { retryAfterMs });
  }

  it('waits out a preview the server says it is still preparing, and renders it', async () => {
    // A PDF or an Office file attached moments ago has no text derivative yet,
    // and the route says so with a 409 and a delay rather than a verdict.
    // Collapsing that into the failed state left the reader on "not available"
    // for the life of the mount, seconds after the derivative was ready.
    const loadResourceContent = vi.fn()
      .mockRejectedValueOnce(stillProcessing())
      .mockRejectedValueOnce(stillProcessing())
      .mockResolvedValueOnce(new Blob(['## Extracted\n\nRevenue grew 40%.']));
    openDetail({ ...note, mimeType: 'application/pdf', title: 'Contract.pdf' }, loadResourceContent);

    expect(screen.getByRole('status')).toHaveTextContent('Loading preview');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Extracted' })).toBeInTheDocument());
    expect(loadResourceContent).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/preview is not available/iu)).not.toBeInTheDocument();
  });

  it('waits the delay the response named, not a schedule of its own', async () => {
    // The route knows whether it is waiting on a claim, a hash write or a
    // conversion and answers 250ms or 1s accordingly. Fake timers because the
    // assertion is the exact number: a schedule invented here would satisfy any
    // lower bound a real-timer test could safely assert.
    vi.useFakeTimers();
    try {
      const loadResourceContent = vi.fn()
        .mockRejectedValueOnce(stillProcessing(1_000))
        .mockResolvedValueOnce(new Blob(['Ready.']));
      const read = readResourcePreviewText(loadResourceContent, note.id, new AbortController().signal, MAX_RESOURCE_PREVIEW_WAIT_MS);

      await vi.advanceTimersByTimeAsync(999);
      expect(loadResourceContent).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(read).resolves.toBe('Ready.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a processing answer that names no delay, rather than spinning on a number of its own', async () => {
    const loadResourceContent = vi.fn()
      .mockRejectedValue(new ApiError('The attachment preview is still being prepared', 409, 'resource_processing'));
    openDetail(note, loadResourceContent);

    await waitFor(() => expect(screen.getByText(/preview is not available/iu)).toBeInTheDocument());
    expect(loadResourceContent).toHaveBeenCalledTimes(1);
  });

  it('does not re-ask a rejection that is final, however it is decorated', async () => {
    // 422 is an answer. A `retryAfterMs` riding along on one does not make it a
    // wait, and reading it as one would turn this into a general retry layer
    // over responses that are already settled — which is what the code check,
    // not just the `instanceof`, is here to prevent.
    const loadResourceContent = vi.fn()
      .mockRejectedValue(new ApiError('This attachment format cannot be previewed', 422, 'resource_preview_unsupported', { retryAfterMs: 5 }));
    openDetail(note, loadResourceContent);

    await waitFor(() => expect(screen.getByText(/preview is not available/iu)).toBeInTheDocument());
    expect(loadResourceContent).toHaveBeenCalledTimes(1);
  });

  it('treats a zero delay as no delay, rather than asking as fast as the network allows', async () => {
    // The budget bounds how long the loop runs, not how many requests it makes:
    // `wait(0)` resolves on the next tick, so a route answering 0 would be asked
    // again immediately, for the whole budget. Clamping to a floor instead would
    // mean inventing the floor.
    const loadResourceContent = vi.fn().mockRejectedValue(stillProcessing(0));
    openDetail(note, loadResourceContent);

    await waitFor(() => expect(screen.getByText(/preview is not available/iu)).toBeInTheDocument());
    expect(loadResourceContent).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the panel that asked for it is gone', async () => {
    let attempts = 0;
    const loadResourceContent = vi.fn(async (_id: string, signal?: AbortSignal) => {
      attempts += 1;
      if (signal?.aborted) throw new Error('aborted');
      throw stillProcessing(10);
    });
    const { unmount } = render(
      <Tooltip.Provider>
        <InspectorRail loadResourceContent={loadResourceContent} workstream={{ ...workstream, resources: [note] }} />
      </Tooltip.Provider>,
    );
    act(() => { useUiStore.getState().inspect({ type: 'resource', id: note.id }); });
    await waitFor(() => expect(attempts).toBeGreaterThan(1));

    unmount();
    const afterUnmount = attempts;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(attempts).toBe(afterUnmount);
  });

  it('drops a pending retry when the resource is revised out from under it', async () => {
    // The wait armed for version 2 belongs to a read that is over. Letting it
    // fire would put a request for the superseded revision behind the one the
    // metadata beside it now describes. Unmounting is not the only way a read
    // ends, and the effect keys on `currentVersion` as well as the id.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const loadResourceContent = vi.fn()
        .mockRejectedValueOnce(stillProcessing(30_000))
        .mockResolvedValue(new Blob(['## Findings\n\nRevenue grew 30%.']));
      const { rerender } = render(
        <Tooltip.Provider>
          <InspectorRail loadResourceContent={loadResourceContent} workstream={{ ...workstream, resources: [note] }} />
        </Tooltip.Provider>,
      );
      act(() => { useUiStore.getState().inspect({ type: 'resource', id: note.id }); });
      await waitFor(() => expect(loadResourceContent).toHaveBeenCalledOnce());

      rerender(
        <Tooltip.Provider>
          <InspectorRail
            loadResourceContent={loadResourceContent}
            workstream={{ ...workstream, resources: [{ ...note, currentVersion: note.currentVersion + 1 }] }}
          />
        </Tooltip.Provider>,
      );
      await waitFor(() => expect(screen.getByText('Revenue grew 30%.')).toBeInTheDocument());

      // Long past the delay the abandoned read was waiting out.
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

      expect(loadResourceContent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('the wait deadline', () => {
    // The budget is the server's arithmetic, not a number this file chose, and
    // the only way that stays true is if it is still being computed from the
    // two constants it was derived from. A literal typed in here would drift
    // silently the day either server number moves — which is the failure the
    // shared constants exist to prevent, so it is asserted rather than trusted.
    it('is the server\'s own lease plus its converter timeout, not a copy of their sum', () => {
      expect(MAX_RESOURCE_PREVIEW_WAIT_MS).toBe(ATTACHMENT_PROCESSING_LEASE_MS + ATTACHMENT_CONVERTER_TIMEOUT_MS);
    });

    // Enforcement takes the budget as an argument, so the trip is provable
    // against a deadline a test does not have to spend in real time. Never
    // assert on the constant's literal value: that test would fail the day the
    // sum behind it changes.
    it('stops asking once the budget would be overspent, and surfaces the last rejection', async () => {
      vi.useFakeTimers();
      try {
        const loadResourceContent = vi.fn().mockRejectedValue(stillProcessing(1_000));
        const read = readResourcePreviewText(loadResourceContent, note.id, new AbortController().signal, 2_500);
        const settled = expect(read).rejects.toThrow(/still being prepared/iu);

        await vi.advanceTimersByTimeAsync(5_000);
        await settled;
        // Attempts at 0s and 1s are inside the budget; the one at 2s would have
        // to wait until 3s to try again, which is past it, so it gives up there
        // rather than one whole delay late.
        expect(loadResourceContent).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still resolves a preview that converges well inside the budget', async () => {
      vi.useFakeTimers();
      try {
        let attempts = 0;
        const loadResourceContent = vi.fn(async () => {
          attempts += 1;
          if (attempts <= 20) throw stillProcessing(1_000);
          return new Blob(['Ready at last.']);
        });
        const read = readResourcePreviewText(loadResourceContent, note.id, new AbortController().signal, MAX_RESOURCE_PREVIEW_WAIT_MS);

        await vi.advanceTimersByTimeAsync(25_000);
        await expect(read).resolves.toBe('Ready at last.');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it.each([
    ['a Word document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Plan.docx'],
    ['a PDF', 'application/pdf', 'Contract.pdf'],
    ['a resource with no declared type', null, 'Fetched page'],
  ])('asks the preview route for %s rather than deciding locally that it is unreadable', async (_label, mimeType, title) => {
    // The server owns what is previewable: it returns the bytes for text and
    // an extracted-text derivative for everything else, and a clear 422 when it
    // genuinely cannot. Deciding here instead meant a Word document rendered as
    // the raw bytes of a zip, and a PDF — the most commonly attached document
    // there is — showed nothing at all.
    const loadResourceContent = vi.fn(async () => new Blob(['## Extracted\n\nReadable after all.']));
    openDetail({ ...note, ...(mimeType ? { mimeType } : { mimeType: undefined }), title }, loadResourceContent);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Extracted' })).toBeInTheDocument());
    expect(loadResourceContent).toHaveBeenCalledExactlyOnceWith(note.id, expect.anything());
  });
});

describe("a work stream's own automations in the rail", () => {
  const automation: WorkstreamAutomationSummary = {
    id: 'automation-1',
    name: 'Weekly changelog',
    description: 'What shipped this week.',
    status: 'active',
    updatedAt: '2026-09-01T09:00:00.000Z',
  };

  beforeEach(() => {
    useUiStore.setState({
      railOpen: true,
      railVariant: 'context',
      railWidth: 360,
      inspector: null,
    });
  });

  function renderRail(props: Partial<React.ComponentProps<typeof InspectorRail>> = {}): void {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} {...props} />
      </Tooltip.Provider>,
    );
  }

  it('sits between Artifacts and Details, where the rest of the room context is', () => {
    renderRail({ workstreamAutomations: [automation] });

    const headings = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent);
    expect(headings).toContain('Automations');
    expect(headings.indexOf('Automations')).toBeGreaterThan(headings.indexOf('Artifacts'));
    expect(headings.indexOf('Automations')).toBeLessThan(headings.indexOf('Details'));
  });

  it('opens the automation it names', () => {
    const onOpenWorkstreamAutomation = vi.fn();
    renderRail({ workstreamAutomations: [automation], onOpenWorkstreamAutomation });

    fireEvent.click(screen.getByRole('button', { name: /Weekly changelog/ }));

    expect(onOpenWorkstreamAutomation).toHaveBeenCalledWith('automation-1');
  });

  it('keeps loading, failed and genuinely-none apart', () => {
    // A room's automations are listed here and nowhere else, so "No
    // automations" is a claim about the room. Saying it while the fetch is in
    // flight, or after one failed, tells somebody their automations are gone.
    const { unmount } = render(
      <Tooltip.Provider><InspectorRail workstream={workstream} /></Tooltip.Provider>,
    );
    expect(screen.getByText('Loading automations…')).toBeInTheDocument();
    expect(screen.queryByText('No automations')).not.toBeInTheDocument();
    unmount();

    const failed = render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} workstreamAutomationsError="offline" />
      </Tooltip.Provider>,
    );
    expect(screen.getByText('Could not load automations')).toBeInTheDocument();
    expect(screen.queryByText('No automations')).not.toBeInTheDocument();
    failed.unmount();

    renderRail({ workstreamAutomations: [] });
    expect(screen.getByText('No automations')).toBeInTheDocument();
  });

  it('labels a draft as one, and still opens it', () => {
    // A draft is listed so the room can find the conversation it is being
    // written in; the label keeps it from reading as something that runs.
    const onOpenWorkstreamAutomation = vi.fn();
    renderRail({
      workstreamAutomations: [{ ...automation, status: 'draft' }],
      onOpenWorkstreamAutomation,
    });

    expect(screen.getByText('Draft')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Weekly changelog/ }));
    expect(onOpenWorkstreamAutomation).toHaveBeenCalledWith('automation-1');
  });

  it('shows no automations section on a parent that cannot own any', () => {
    renderRail({ automationsSection: false, workstreamAutomations: [] });

    expect(screen.queryByRole('heading', { level: 3, name: 'Automations' })).toBeNull();
    expect(screen.queryByText('No automations')).toBeNull();
  });
});
