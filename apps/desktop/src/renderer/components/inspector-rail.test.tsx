import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApplicationSettings } from '../../common/desktop';
import type { ResourceVersion, WorkstreamDetail, WorkstreamResource } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { InspectorRail } from './inspector-rail';

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
  origin: 'automation',
  automationName: 'Weekly invoice monitor',
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
  plannedFor: '2026-08-03T16:00:00.000Z',
  createdAt: '2026-07-31T20:00:00.000Z',
  participants: [],
  viewers: [],
  resources: [],
  connections: [],
  backgroundTasks: [],
  automationRuns: [],
  automationSubscriptionId: 'subscription-1',
  automationSubscription: {
    id: 'subscription-1',
    name: 'Weekly invoice monitor',
    scope: 'workspace',
    status: 'active',
    triggerSummary: 'Every Monday at 9:00 AM',
    executionScope: 'Workspace',
  },
  automationRunId: 'automation-run-1',
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
    const { container } = render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );
    // The class is the whole contract: `.rail-scroll` in `app.css` owns the
    // scrolling, the reserved gutter and the overscroll containment for this
    // rail and HyperSight's alike, and renaming it here would take all three
    // away with nothing else noticing.
    expect(container.querySelector('.rail-scroll')).not.toBeNull();
    const handle = screen.getByRole('separator', { name: 'Resize inspector' });

    expect(handle).toHaveAttribute('aria-valuenow', '360');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(useUiStore.getState().railWidth).toBe(376);

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(useUiStore.getState().railWidth).toBe(360);
  });

  it('shows automation-subscription and bounded harness-run metadata while debugging is on', async () => {
    render(
      <Tooltip.Provider>
        <InspectorRail workstream={workstream} />
      </Tooltip.Provider>,
    );

    expect(await screen.findByText('Every Monday at 9:00 AM')).toBeVisible();
    expect(screen.getAllByText('Weekly invoice monitor')).toHaveLength(2);
    expect(screen.getByText('subscription-1')).toBeVisible();
    expect(screen.getByText('automation-run-1')).toBeVisible();
    expect(screen.getByText('google/gemini-2.5-flash-lite')).toBeVisible();
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
    await waitFor(() => expect(screen.getByText('Origin')).toBeVisible());
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

  it('separates incoming sources from generated artifacts', () => {
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

    expect(within(screen.getByRole('heading', { name: 'Sources' }).closest('section')!).getByText(watched.title)).toBeVisible();
    expect(within(screen.getByRole('heading', { name: 'Artifacts' }).closest('section')!).getByText('Generated release brief')).toBeVisible();
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

  const history: ResourceVersion[] = [
    { version: 3, capturedAt: '2026-07-31T14:14:00.000Z', author: { kind: 'agent', runId: 'run-1' }, cause: 'published', contentAvailable: true },
    { version: 2, capturedAt: '2026-07-31T13:40:00.000Z', author: { kind: 'connector', connectionId: 'connection-1' }, cause: 'refetched', contentAvailable: true },
    { version: 1, capturedAt: '2026-07-31T11:02:00.000Z', author: { kind: 'member', userId: 'user-1' }, cause: 'created', contentAvailable: true },
  ];

  it('lists a resource’s versions with who moved it and when', () => {
    render(
      <Tooltip.Provider>
        <InspectorRail resourceVersions={history} workstream={{ ...workstream, resources: [watched] }} />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));

    const versions = screen.getByRole('heading', { name: 'Versions' }).closest('section')!;
    // Newest first, and the current one is not something to open a copy of.
    expect(within(versions).getAllByRole('listitem').map((row) => row.textContent))
      .toEqual([
        expect.stringContaining('V3'),
        expect.stringContaining('V2'),
        expect.stringContaining('V1'),
      ]);
    expect(within(versions).getByText(/Current/u)).toBeVisible();
    expect(within(versions).getByRole('button', { name: /Open version 1/u })).toBeVisible();
    expect(within(versions).queryByRole('button', { name: /Open version 3/u })).toBeNull();
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

    fireEvent.click(screen.getByRole('button', { name: /Open version 2/u }));

    expect(onOpenResourceVersion).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'resource-1' }),
      expect.objectContaining({ version: 2 }),
    );
  });

  it('shows no version section for a resource that has never changed', () => {
    render(
      <Tooltip.Provider>
        <InspectorRail
          resourceVersions={[history[2]!]}
          workstream={{ ...workstream, resources: [{ ...watched, currentVersion: 1 }] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Linear issue create: AVA-9/ }));

    // One version is no history: the section would say only that the resource
    // exists, which the detail above it already says.
    expect(screen.queryByRole('heading', { name: 'Versions' })).toBeNull();
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

  it('offers no re-fetch for a resource with no source to fetch from', () => {
    render(
      <Tooltip.Provider>
        <InspectorRail
          onRefreshResource={vi.fn()}
          workstream={{ ...workstream, resources: [{
            ...watched,
            title: 'Generated release brief',
            provider: 'rally_generated',
            relationshipType: 'generated',
            direction: 'artifact',
            watchStatus: 'unsupported',
          }] }}
        />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Generated release brief/ }));

    // Rally wrote this one. There is nowhere to re-fetch it from, and the
    // button would offer to overwrite a draft with itself.
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

});

describe('resource detail content preview', () => {
  const note: WorkstreamResource = {
    id: 'resource-note',
    title: 'Q3 board deck',
    resourceType: 'document',
    mimeType: 'text/markdown',
    contentAvailable: true,
    watchEnabled: false,
    watchStatus: 'unsupported',
    currentVersion: 2,
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

  it('renders the resource content beneath its metadata, so a citation is not a dead end', async () => {
    const loadResourceContent = vi.fn(async () => new Blob(['## Findings\n\nRevenue grew 40%.']));
    openDetail(note, loadResourceContent);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Findings' })).toBeInTheDocument());
    expect(loadResourceContent).toHaveBeenCalledExactlyOnceWith('resource-note', expect.anything());
    // Beneath the metadata, not instead of it.
    expect(screen.getByText('Version')).toBeInTheDocument();
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
    expect(screen.getByText('Version')).toBeInTheDocument();
  });

  it('says the preview is unavailable rather than leaving the panel half-drawn', async () => {
    const loadResourceContent = vi.fn(async () => { throw new Error('resource_content_unavailable'); });
    openDetail(note, loadResourceContent);

    await waitFor(() => expect(screen.getByText(/preview is not available/iu)).toBeInTheDocument());
    expect(screen.getByText('Version')).toBeInTheDocument();
  });

  it('does not try to render an image as text', () => {
    const loadResourceContent = vi.fn();
    openDetail({ ...note, mimeType: 'image/png', title: 'Screenshot.png' }, loadResourceContent);

    expect(loadResourceContent).not.toHaveBeenCalled();
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
