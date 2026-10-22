import { SITE_MANIFEST_MIME_TYPE } from '@rally/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_CONVERTER_TIMEOUT_MS, ATTACHMENT_PROCESSING_LEASE_MS } from '@rally/contracts';
import type { DesktopApplicationSettings } from '../../common/desktop';
import type {
  ResourceVersion,
  WorkstreamDetail,
  WorkstreamResource,
} from '../lib/types';
import { useState } from 'react';
import { useUiStore } from '../lib/ui-store';
import { ApiError } from '../lib/api';
import { InspectorRail } from './inspector-rail';
import { MAX_RESOURCE_PREVIEW_WAIT_MS, readResourcePreviewText } from '../lib/resource-preview';

const copyText = vi.hoisted(() => vi.fn());
const popOutArtifact = vi.hoisted(() => vi.fn());
const applicationSettings = vi.hoisted(() => ({
  current: { lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true },
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
    popOutArtifact,
    getApplicationSettings: () => Promise.resolve(applicationSettings.current),
    onApplicationSettingsChanged: (listener: (settings: unknown) => void) => {
      applicationSettings.listeners.add(listener);
      return () => applicationSettings.listeners.delete(listener);
    },
  }),
  desktopServicesAvailable: () => false,
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
  spaceIds: [],
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
    popOutArtifact.mockReset();
    popOutArtifact.mockResolvedValue(true);
    applicationSettings.listeners.clear();
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true };
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

  it.each([
    ['watch', 'The resource watch couldn’t be updated.'],
    ['detach', 'The resource couldn’t be archived.'],
    ['refresh', 'The resource couldn’t be refreshed.'],
    ['attach', 'The resource couldn’t be added.'],
  ] as const)('owns stable copy for a %s failure', (failure, copy) => {
    render(<Tooltip.Provider><InspectorRail failure={failure} workstream={workstream} /></Tooltip.Provider>);
    expect(screen.getByText(copy)).toBeVisible();
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

  // This handle has no collapse to offer: the panel closes from its own header
  // control, so the quick action the other two dividers spend on collapsing
  // gives back the even split the sidebar opens at instead. The hint says so,
  // and it is the only place that says so.
  it('resets the sidebar to the even split it opens at when the divider is double-clicked', () => {
    // The main pane starts 200px into a 1,000px window, so half of it is 400px.
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1_000);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('main-pane')) return DOMRect.fromRect({ x: 200, width: 800 });
      return DOMRect.fromRect({ width: this.classList.contains('rail-resizer-limit') ? 560 : 0 });
    });
    const pane = document.createElement('main');
    pane.className = 'main-pane';
    document.body.append(pane);
    useUiStore.setState({ railWidth: 520 });
    render(<Tooltip.Provider><InspectorRail workstream={workstream} /></Tooltip.Provider>);
    const handle = screen.getByRole('separator', { name: 'Resize inspector' });

    fireEvent.focus(handle);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Double-click or Enter to reset width');

    fireEvent.doubleClick(handle);
    expect(useUiStore.getState().railWidth).toBe(400);

    // The arrows step by a fixed amount, so without Enter the width the hint
    // names is reachable from the keyboard only by counting steps to a number
    // nothing on screen shows.
    useUiStore.setState({ railWidth: 520 });
    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(useUiStore.getState().railWidth).toBe(400);
    pane.remove();
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

  it('opens one resource in the right panel without opening the shell rail', () => {
    useUiStore.setState({ railOpen: false });
    render(<Tooltip.Provider><InspectorRail workstream={{ ...workstream, resources: [watched] }} panel={{ resourceId: watched.id, onClose: vi.fn() }} /></Tooltip.Provider>);
    expect(screen.getByRole('complementary', { name: `Resource: ${watched.title}` })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to context' })).toBeNull();
    expect(useUiStore.getState().railOpen).toBe(false);
  });

  it('opens the resource panel without a tooltip nobody asked for, and closes on the first Escape', () => {
    useUiStore.setState({ railOpen: false });
    const onClose = vi.fn();
    render(<Tooltip.Provider><InspectorRail workstream={{ ...workstream, resources: [watched] }} panel={{ resourceId: watched.id, onClose }} /></Tooltip.Provider>);

    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.keyDown(screen.getByRole('complementary', { name: `Resource: ${watched.title}` }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
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
    announceApplicationSettings({ releaseChannel: 'stable', releaseChannelAvailable: true, lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });

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

    announceApplicationSettings({ releaseChannel: 'stable', releaseChannelAvailable: true, lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, pushNotificationsEnabled: true, pushNotificationStatus: "unavailable", notificationBadgeStatus: "unknown", menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true, productAnalyticsEnabled: true, productAnalyticsEffective: true, productAnalyticsPreferencePending: false, nativeCrashRestartRequired: false });

    expect(address()).toHaveAttribute('title', workstream.emailAddress);
  });

  it('shows the complete channel email address in Details and copies it with feedback', async () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    const emailAddress = 'luminous-tidal-structured-curie@automation.rallywith.ai';
    expect(screen.getByText(emailAddress)).toBeVisible();

    const copyButton = screen.getByRole('button', { name: 'Copy thread email address' });
    fireEvent.click(copyButton);

    expect(copyText).toHaveBeenCalledWith(emailAddress);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied' })).toHaveClass('copy-button-copied');
    });
  });

  it('keeps the icon copy control retryable when the clipboard rejects the write', async () => {
    copyText.mockRejectedValueOnce(new Error('clipboard unavailable'));

    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy thread email address' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy failed — click to retry' })).toBeEnabled();
    });
    expect(screen.getByText('Copy failed. Try again.')).toBeInTheDocument();
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
          resourceVersionsFailed
          workstream={{ ...workstream, resources: [watched] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Versions' }));

    // Offline, a 500, and "this document never changed" are four different
    // truths; silence tells the reader the last one.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'History details' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Resource history couldn’t be loaded.');
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
    expect(dialog).toHaveAccessibleDescription(/will leave this thread/u);
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
      throw new Error('The channel refused the unlink.');
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

    expect(await screen.findByText('The resource couldn’t be archived.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByText('The channel refused the unlink.')).not.toBeInTheDocument();
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

  it('renders a resource panel with its document, a resize edge, and close', async () => {
    const onClose = vi.fn();
    render(
      <Tooltip.Provider>
        <InspectorRail
          loadResourceContent={vi.fn(async () => new Blob(['# Quarterly plan'], { type: 'text/markdown' }))}
          panel={{ resourceId: note.id, onClose }}
          workstream={{ ...workstream, resources: [note] }}
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('complementary', { name: `Resource: ${note.title}` })).toBeVisible();
    expect(screen.getByRole('separator', { name: 'Resize inspector' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open in a righthand sidebar' })).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Quarterly plan', level: 1 })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders an HTML artifact in a sandboxed frame, not as text', async () => {
    const page: WorkstreamResource = { ...note, id: 'resource-page', title: 'Launch page.html', mimeType: 'text/html' };
    render(
      <Tooltip.Provider>
        <InspectorRail
          loadResourceContent={vi.fn(async () => new Blob(['<h1>Launch</h1>'], { type: 'text/html' }))}
          panel={{ resourceId: page.id, onClose: vi.fn() }}
          workstream={{ ...workstream, resources: [page] }}
        />
      </Tooltip.Provider>,
    );

    const frame = await screen.findByTitle('Preview of Launch page.html');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('<body><h1>Launch</h1></body>');
    expect(screen.queryByText('<h1>Launch</h1>')).toBeNull();
  });

  it('offers the resource panel actions from its title pill menu', async () => {
    const onOpenResourceVersion = vi.fn();
    const version: ResourceVersion = { version: 1, title: note.title, mimeType: 'text/markdown', capturedAt: '2026-10-01T00:00:00.000Z', author: null, cause: null, contentAvailable: true };
    render(
      <Tooltip.Provider>
        <InspectorRail
          loadResourceContent={vi.fn(async () => new Blob(['# Quarterly plan'], { type: 'text/markdown' }))}
          onOpenResourceVersion={onOpenResourceVersion}
          panel={{ resourceId: note.id, onClose: vi.fn() }}
          resourceVersions={[{ ...version, version: 2 }, version]}
          workstream={{ ...workstream, resources: [note] }}
        />
      </Tooltip.Provider>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: `Artifact menu: ${note.title}` }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: 'Open in a new window' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: /Versions/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /V1/ }));
    expect(onOpenResourceVersion).toHaveBeenCalledWith(note, version);
  });

  it.each([
    ['archive.zip', 'application/zip'],
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ])('downloads original bytes for %s rather than its readable preview', async (title, mimeType) => {
    const resource = { ...note, title, mimeType };
    const originals = vi.fn(async () => new Blob(['original file bytes'], { type: mimeType }));
    const previews = vi.fn(async () => new Blob(['# Extracted prose'], { type: 'text/markdown' }));
    const urls = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download');
    const clicked: { name: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ name: this.download, href: this.href });
    });
    render(<Tooltip.Provider><InspectorRail resource={resource} panel={{ resourceId: note.id, onClose: vi.fn() }} loadResourceContent={previews} loadOriginalResourceContent={originals} /></Tooltip.Provider>);
    await screen.findByRole('heading', { name: 'Extracted prose' });
    fireEvent.pointerDown(screen.getByRole('button', { name: `Artifact menu: ${title}` }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Download' }));

    await waitFor(() => expect(clicked).toEqual([{ name: title, href: 'blob:download' }]));
    expect(originals).toHaveBeenCalledExactlyOnceWith(note.id);
    const saved = urls.mock.calls[0]![0] as Blob;
    const bytes = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(saved);
    });
    expect(bytes).toBe('original file bytes');
    expect(saved.type).toBe(mimeType);
  });

  it('reports a failed original-file download', async () => {
    render(<Tooltip.Provider><InspectorRail resource={note} panel={{ resourceId: note.id, onClose: vi.fn() }} loadOriginalResourceContent={async () => { throw new Error('offline'); }} /></Tooltip.Provider>);
    fireEvent.pointerDown(screen.getByRole('button', { name: `Artifact menu: ${note.title}` }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Download' }));
    expect(await screen.findByText('Download failed. Please try again.')).toBeVisible();
  });

  it.each([
    ['source.txt', 'text/plain'],
    ['source.py', 'text/x-python'],
    ['source.json', 'application/json'],
  ])('preserves literal text in %s', async (title, mimeType) => {
    render(<Tooltip.Provider><InspectorRail resource={{ ...note, title, mimeType }} panel={{ resourceId: note.id, onClose: vi.fn() }} loadResourceContent={async () => new Blob(['# literal\n  **unchanged**\n    third line'], { type: mimeType })} /></Tooltip.Provider>);
    const text = await screen.findByText(/# literal/);
    expect(text.closest('pre')).not.toBeNull();
    expect(text.closest('pre')?.textContent).toBe('# literal\n  **unchanged**\n    third line');
    expect(screen.queryByRole('heading', { name: 'literal' })).toBeNull();
  });

  it.each([false, true])('pins, copies a link to, and renames an artifact from its title pill menu (detached: %s)', async (detached) => {
    const onPin = vi.fn();
    const copy = vi.fn(async () => undefined);
    const onRenameResource = vi.fn(async () => undefined);
    render(
      <Tooltip.Provider>
        <InspectorRail
          onRenameResource={onRenameResource}
          panel={{ resourceId: note.id, onClose: vi.fn(), detached }}
          resourceLink={() => copy}
          resourcePin={() => ({ on: false, onChange: onPin })}
          workstream={{ ...workstream, resources: [note] }}
        />
      </Tooltip.Provider>,
    );
    const openMenu = (): void => {
      fireEvent.pointerDown(screen.getByRole('button', { name: `Artifact menu: ${note.title}` }), { button: 0, ctrlKey: false });
    };

    openMenu();
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Pinned in my sidebar' }));
    expect(onPin).toHaveBeenCalledWith(true);
    // Pin is a switch and keeps the main menu open. Copy from that same menu.
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy link' }));
    await waitFor(() => expect(copy).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(await screen.findByText('Copied.')).toBeVisible();

    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename artifact' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), { target: { value: '  Q4 plan  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(onRenameResource).toHaveBeenCalledWith(note, 'Q4 plan'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers Unpin for a pinned artifact and leaves out what its host cannot do', async () => {
    render(
      <Tooltip.Provider>
        <InspectorRail
          panel={{ resourceId: note.id, onClose: vi.fn() }}
          resourceLink={() => undefined}
          resourcePin={() => ({ on: true, onChange: vi.fn() })}
          workstream={{ ...workstream, resources: [note] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: `Artifact menu: ${note.title}` }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Pinned in my sidebar' })).toBeChecked();
    expect(screen.queryByRole('menuitem', { name: 'Copy link' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
  });

  it('keeps the rename dialog open and says so when the rename fails', async () => {
    const onRenameResource = vi.fn(async () => { throw new Error('refused'); });
    render(
      <Tooltip.Provider>
        <InspectorRail
          onRenameResource={onRenameResource}
          panel={{ resourceId: note.id, onClose: vi.fn() }}
          workstream={{ ...workstream, resources: [note] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: `Artifact menu: ${note.title}` }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename artifact' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), { target: { value: 'Q4 plan' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText('The artifact couldn’t be renamed.')).toBeVisible();
  });

  it('draws the Expand it is given for any artifact, a live site included', () => {
    const onSelect = vi.fn();
    const expandAction = [{ key: 'expand', label: 'Expand', icon: null, onSelect }];
    const { unmount } = render(
      <Tooltip.Provider>
        <InspectorRail panel={{ resourceId: note.id, onClose: vi.fn(), expandAction }} workstream={{ ...workstream, resources: [note] }} />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(onSelect).toHaveBeenCalledOnce();
    unmount();

    render(
      <Tooltip.Provider>
        <InspectorRail panel={{ resourceId: site.id, onClose: vi.fn(), expandAction }} workstream={{ ...workstream, resources: [site] }} />
      </Tooltip.Provider>,
    );
    expect(screen.getByRole('button', { name: 'Expand' })).toBeInTheDocument();
  });

  it('hands focus back to what opened the panel once an archive closes it', async () => {
    // The surface drops a panel whose resource is gone, as `ConversationSurface`
    // does after Archive; the panel's frame returns focus as it leaves.
    function Host(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      const [resources, setResources] = useState([note]);
      return <Tooltip.Provider>
        <button onClick={() => setOpen(true)} type="button">Open note</button>
        {open && resources.length > 0 && <InspectorRail
          onDetachResource={() => { setResources([]); }}
          panel={{ resourceId: note.id, onClose: () => setOpen(false) }}
          workstream={{ ...workstream, resources }}
        />}
      </Tooltip.Provider>;
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open note' });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole('complementary', { name: `Resource: ${note.title}` });

    fireEvent.pointerDown(screen.getByRole('button', { name: `Artifact menu: ${note.title}` }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'More' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('pops every non-site artifact out through its authorized preview bytes', async () => {
    const loadResourceContent = vi.fn(async () => new Blob(['# Quarterly plan'], { type: 'text/markdown' }));
    openDetail(note, loadResourceContent);

    const button = screen.getByRole('button', { name: 'Open in a new window' });
    expect(button.querySelector('.tabler-icon-window-maximize')).not.toBeNull();
    fireEvent.click(button);

    await waitFor(() => expect(popOutArtifact).toHaveBeenCalledWith({
      kind: 'generated', editable: false,
      resourceId: note.id,
      version: note.currentVersion,
      content: expect.any(Uint8Array),
      mimeType: 'text/markdown',
      sourceMimeType: 'text/markdown',
      title: note.title,
    }));
    expect(loadResourceContent).toHaveBeenCalledWith(note.id, expect.any(AbortSignal));
  });

  it('does not offer Open in a new window for a source resource', () => {
    openDetail({ ...note, direction: 'source' }, vi.fn(async () => new Blob(['source'])));
    expect(screen.queryByRole('button', { name: 'Open in a new window' })).not.toBeInTheDocument();
  });

  it('disables artifact readers when the preview route cannot represent the format', () => {
    const opaque = { ...note, title: 'bundle.bin', mimeType: 'application/octet-stream' };
    openDetail(opaque, vi.fn(async () => new Blob(['opaque'])));
    expect(screen.getByRole('button', { name: 'Open in a new window' })).toBeDisabled();
  });

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
      surface: {
        present: vi.fn(async () => true),
        setBounds: vi.fn(async () => undefined),
        snapshot: vi.fn(async () => null),
        close: vi.fn(async () => undefined),
        popOut: vi.fn(async () => true),
        copyText: vi.fn(async () => undefined),
        openExternal: vi.fn(async () => undefined),
      },
    };
  }

  it.each([false, true])('keeps public sharing in tiles and secondary actions above Versions (detached: %s)', async (detached) => {
    const artifacts = siteArtifacts();
    const internalCopy = vi.fn(async () => undefined);
    const pin = vi.fn();
    render(<Tooltip.Provider><InspectorRail
      panel={{ resourceId: site.id, onClose: vi.fn(), detached }}
      siteArtifacts={artifacts} resource={site}
      resourceLink={() => internalCopy}
      resourcePin={() => ({ on: true, onChange: pin })}
      onRenameResource={vi.fn(async () => undefined)} onDetachResource={vi.fn()}
    /></Tooltip.Provider>);
    await waitFor(() => expect(artifacts.surface.present).toHaveBeenCalled());
    for (const label of ['Copy public link', 'Open in browser', 'Open in a new window']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    const open = (): void => { fireEvent.pointerDown(screen.getByRole('button', { name: `Artifact menu: ${site.title}` }), { button: 0, ctrlKey: false }); };
    open();
    expect(await screen.findByRole('menuitem', { name: 'More' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Open in browser' })).toHaveClass('title-menu-tile');
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Rename', 'Copy public link', 'Open in browser', 'More',
      ...(detached ? [] : ['Open in a new window']), 'Versions',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy public link' }));
    await waitFor(() => expect(artifacts.surface.copyText).toHaveBeenCalledWith('https://3f2504e0-4f89-41d3-9a0c-0305e82c3301-g.rallyusercontent.test'));
    expect(internalCopy).not.toHaveBeenCalled();
    expect(await screen.findByText('Copied.')).toBeVisible();
    open();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Pinned in my sidebar' })).toBeChecked();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Open in a new window' }) !== null).toBe(!detached);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in browser' }));
    await waitFor(() => expect(artifacts.surface.openExternal).toHaveBeenCalled());
    open();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'More' }));
    expect(await screen.findByRole('menuitem', { name: 'Archive' })).toBeVisible();
  });

  it.each([false, true])('opens Stored data as its own pop-out level while retaining the preview (detached: %s)', async (detached) => {
    const artifacts = siteArtifacts();
    const openArtifact = artifacts.openArtifact;
    artifacts.openArtifact = vi.fn(async () => ({ ...await openArtifact(), stateful: true }));
    render(<Tooltip.Provider><InspectorRail
      panel={{ resourceId: site.id, onClose: vi.fn(), detached }}
      siteArtifacts={artifacts} resource={site}
    /></Tooltip.Provider>);
    await waitFor(() => expect(artifacts.surface.present).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Stored data' })).toBeNull();
    const openMenu = (): void => {
      fireEvent.pointerDown(screen.getByRole('button', { name: `Artifact menu: ${site.title}` }), { button: 0, ctrlKey: false });
    };
    openMenu();
    const data = await screen.findByRole('menuitem', { name: 'Stored data' });
    expect(data.querySelector('.title-menu-level-chevron')).not.toBeNull();
    expect(artifacts.describeData).not.toHaveBeenCalled();
    fireEvent.click(data);
    expect(await screen.findByText('No data yet')).toBeVisible();
    expect(artifacts.describeData).toHaveBeenCalledWith(site.id);
    expect(screen.getByTestId('site-preview-pane')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(await screen.findByRole('menuitem', { name: 'Stored data' })).toBeVisible();
    expect(screen.queryByText('No data yet')).toBeNull();
  });

  it('shows a live artifact as a page to open rather than a record to describe', async () => {
    const artifacts = siteArtifacts();
    render(
      <Tooltip.Provider>
        <InspectorRail siteArtifacts={artifacts} workstream={{ ...workstream, resources: [site] }} />
      </Tooltip.Provider>,
    );
    act(() => { useUiStore.getState().inspect({ type: 'resource', id: site.id }); });
    await waitFor(() => expect(artifacts.surface.present).toHaveBeenCalled());
    const button = screen.getByRole('button', { name: 'Open in a new window' });
    expect(button).toBeInTheDocument();
    expect(button.querySelector('.tabler-icon-window-maximize')).not.toBeNull();
  });

  it('opens a live site panel\'s labels beside its buttons, clear of the page below', async () => {
    // The page is a native view composited under the header that paints above
    // all renderer DOM, so a label hanging down is behind it. Upward does not
    // fit at the top of the window, and Radix would flip it back down.
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    try {
      const artifacts = siteArtifacts();
      render(
        <Tooltip.Provider>
          <InspectorRail panel={{ resourceId: site.id, onClose: vi.fn() }} siteArtifacts={artifacts} workstream={{ ...workstream, resources: [site] }} />
        </Tooltip.Provider>,
      );
      await waitFor(() => expect(artifacts.surface.present).toHaveBeenCalled());
      for (const name of ['Close panel']) {
        fireEvent.focus(screen.getByRole('button', { name }));
        expect(await screen.findByRole('tooltip')).toHaveAttribute('data-side', 'left');
        fireEvent.blur(screen.getByRole('button', { name }));
        await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to the ordinary resource card when live artifacts are off', () => {
    // Presentation only: with the flag off a site is still an ordinary resource
    // in the rail — it just is not rendered as a page.
    openDetail(site);
    expect(screen.queryByRole('button', { name: 'Open in a new window' })).not.toBeInTheDocument();
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

    expect(screen.getByText('Loading preview…')).toBeVisible();
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

describe('a channel’s Sidekicks in the main workstream rail', () => {
  beforeEach(() => {
    useUiStore.setState({ railOpen: true, railVariant: 'context', railWidth: 360, inspector: null });
  });
  it('keeps the Sidekicks heading for an empty answer and a pending one', () => {
    const { rerender } = render(<Tooltip.Provider><InspectorRail workstream={workstream} sidekicks={[]} /></Tooltip.Provider>);
    expect(screen.getByRole('heading', { name: 'Sidekicks' })).toBeVisible();
    rerender(<Tooltip.Provider><InspectorRail workstream={workstream} /></Tooltip.Provider>);
    expect(screen.getByRole('heading', { name: 'Sidekicks' })).toBeVisible();
  });
  it('shows the room’s Sidekicks and removes the one that offers it', () => {
    const onRemove = vi.fn();
    render(<Tooltip.Provider><InspectorRail workstream={workstream} sidekicks={[
      { id: 'sidekick-1', name: 'Editorial guidance', description: 'Write clearly.', onRemove },
    ]} /></Tooltip.Provider>);
    expect(screen.getByRole('heading', { name: 'Sidekicks' })).toBeVisible();
    // The rail's own tooltip carries the name, so the row takes no `title`:
    // the platform's draws in the desktop's type and never for a keyboard.
    expect(screen.getByRole('button', { name: 'Editorial guidance' })).not.toHaveAttribute('title');
    expect(screen.getByText('Write clearly.')).toBeVisible();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Editorial guidance' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from this breakout' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
  it('keeps an authorized unavailable attachment visible', () => {
    render(<Tooltip.Provider><InspectorRail workstream={workstream} sidekicks={[
      { id: 'sidekick-1', name: 'Editorial guidance', description: 'Write clearly.', note: 'Unavailable' },
    ]} /></Tooltip.Provider>);
    expect(screen.getByText('Unavailable · Write clearly.')).toBeVisible();
  });
});
