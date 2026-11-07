import { asSpaceId, WorkstreamSchema } from '@rally/contracts';
import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import "../../../../../tests/isolated-region";
import type { DesktopSession } from '../../common/desktop';
import type { CookieClientSession } from '@rally/contracts/client-session';
import type { ApiError } from './api';
import { RallyApi, mapWorkstreamSummary, mapResource, mapWorkstreamDetail, redactQuery } from './api';
import { clearAllLocalCache } from './local-cache';
import { refreshPoppedOutArtifacts } from './popped-out-artifacts';
import { SOCKET_TICKET_REQUEST_TIMEOUT_MS } from './socket-ticket-request';

const reportJavascriptError = vi.hoisted(() => vi.fn());
const reportTelemetryProductIntent = vi.hoisted(() => vi.fn());
vi.mock('./telemetry', async (importOriginal) => ({
  ...await importOriginal(),
  reportJavascriptError,
  reportTelemetryProductIntent,
}));

const timestamp = '2026-07-31T20:00:00.000Z';
const workspaceId = '00000000-0000-7000-8000-000000000001';
const userId = '00000000-0000-7000-8000-000000000002';
const workstreamId = '00000000-0000-7000-8000-000000000003';
const connectionId = '00000000-0000-7000-8000-000000000004';
const messageId = '00000000-0000-7000-8000-000000000005';
const resourceId = '00000000-0000-7000-8000-000000000006';
const automationId = '00000000-0000-7000-8000-000000000008';
const runId = '00000000-0000-7000-8000-000000000009';
const taskId = '00000000-0000-7000-8000-000000000013';

const user = {
  id: userId,
  email: 'adam@example.com',
  name: 'Adam',
  avatarUrl: null,
  timezone: 'America/Los_Angeles',
  createdAt: timestamp,
};

const detail = {
  id: workstreamId,
  workspaceId,
  title: 'Investigate ENG-142',
  titleStatus: 'settled' as const,
  objective: 'Find the cause.',
  emailAddress: 'luminous-tidal-structured-curie@automation.rallywith.ai',
  createdByUserId: userId,
  harnessStatus: 'idle' as const,
  lastActivityAt: timestamp,
  latestAttentionSequenceNumber: 4,
  readThroughSequenceNumber: 3,
  manualUnreadFromSequenceNumber: null,
  manualUnreadGeneration: 0,
  hasUnread: true,
  youAreMentioned: false,
  unseen: false,
  firstUnreadSequenceNumber: 4,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
  scope: 'workspace' as const,
  systemKind: null,
  modelOverride: null,
  nextPendingWakeup: null,
  pinPosition: null,
  spacePins: [],
  participantUserIds: [],
  participantExtraCount: 0,
  spaceIds: [],
  participants: [{ user, participationReason: 'creator' as const, joinedAt: timestamp }],
  viewers: [{ user, connectedAt: timestamp }],
  resources: [],
  connections: [{
    id: connectionId,
    modelPluginId: 'plugin_google_drive_docs_sheets',
    workspaceId,
    connectorType: 'google' as const,
    scope: 'personal' as const,
    ownerUserId: userId,
    ownerName: 'Adam',
    displayName: 'Google Drive',
    grantedCapabilities: ['search'],
    status: 'needs_reconnect' as const,
    settingsKind: null,
    userDelivery: null,
    toolCount: null,
    toolCountMissing: null,
    lastSyncAt: null,
    createdAt: timestamp,
  }],
  backgroundTasks: [],
  openElicitations: [],
  suggestions: [],
  latestHarnessRunId: null,
  transcript: {
    snapshotId: '00000000-0000-7000-8000-000000000777',
    snapshotThrough: 0,
    eventSequence: 0,
    snapshotAtUtc: timestamp,
    unreadAnchorSequence: null,
    unreadReason: 'no_unread' as const,
    ranges: [],
    activities: [],
    activeActivities: [],
    pluginRuns: [],
    activeTurns: [],
    pendingInputs: [],
  },
};

const resource = {
  id: resourceId,
  slug: 'luminous-tidal-structured-curie',
  workspaceId,
  connectionId,
  resourceType: 'document',
  provider: 'google_drive',
  providerResourceId: 'drive-1',
  title: 'Launch brief',
  mimeType: 'application/pdf',
  canonicalUrl: 'https://drive.google.com/file/d/drive-1',
  refreshSupported: true,
  watchEnabled: false,
  watchStatus: 'unsupported' as const,
  lastHydratedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  contentAvailable: false,
  sizeBytes: 0,
  currentVersion: 1,
};

const session: DesktopSession = {
  accessToken: 'access-token-longer-than-twenty-characters',
  expiresAt: timestamp,
  apiBaseUrl: 'https://api.example.com',
  user: { id: user.id, email: user.email, name: user.name },
  workspace: { id: workspaceId, name: 'Rally Studio', region: 'global', role: 'owner' },
};


const wireAutomationDetail = {
  id: automationId,
  name: 'Blog monitor',
  description: 'Check a blog for new posts.',
  emailAddress: null,
  scope: 'personal' as const,
  owningWorkstreamId: null,
  status: 'draft' as const,
  nextRunAt: null,
  lastRunAt: null,
  updatedAt: timestamp,
  lifecycle: 'draft' as const,
  authorUserId: userId,
  runAsUserId: userId,
  currentDefinition: {
    name: 'Blog monitor',
    description: 'Check a blog for new posts.',
    overview: 'Checks the configured blog every day.',
    instructions: 'Check the configured blog and report new posts.',
    triggers: [{ type: 'interval' as const, intervalSeconds: 86_400, summary: 'Every 24 hours' }],
    requiredCapabilities: [],
    expectedOutputs: ['New post summary'],
    defaultBehavior: {},
    recommendedPlugins: [],
    memoryTables: [],
    customTools: [],
    suggestedScope: 'personal' as const,
    followUpQuestion: null,
    elicitation: null,
    ready: true,
  },
  currentDefinitionRevision: 1,
  acceptedDefinitionRevision: null,
  connectorBindings: {},
  recentRuns: [],
};

const wireAutomationRun = {
  id: runId,
  automationId,
  coordinatorUserId: userId,
  triggerType: 'schedule' as const,
  plannedFor: timestamp,
  startedAt: timestamp,
  completedAt: '2026-07-31T20:00:12.000Z',
  status: 'completed' as const,
  resultSummary: 'Two new posts.',
  createdAt: timestamp,
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  reportJavascriptError.mockReset();
  reportTelemetryProductIntent.mockReset();
});

describe('Rally API wire adapter', () => {
  it('keeps overlapping detached-window refreshes on their observed resource revisions', async () => {
    vi.stubGlobal('Blob', (await new Response('').blob()).constructor);
    await clearAllLocalCache();
    let finishOlder!: (response: Response) => void;
    let firstArrived!: () => void;
    let secondRead!: () => void;
    const started = new Promise<void>((resolve) => { firstArrived = resolve; });
    const joined = new Promise<void>((resolve) => { secondRead = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => { firstArrived(); return new Promise<Response>((resolve) => { finishOlder = resolve; }); })
      .mockImplementationOnce(async () => new Response('Version three', { headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);
    const updates: { version: number; content: number[] }[] = [];
    const bridge = {
      getPoppedOutArtifactVersions: async () => ({ [resourceId]: 1 }),
      updatePoppedOutArtifact: async (update: { version: number; content?: Uint8Array }) => {
        updates.push({ version: update.version, content: Array.from(update.content ?? []) });
        return false;
      },
    };
    let readers = 0;
    const loadResourceContent = (id: string, signal?: AbortSignal, version?: number) => {
      const result = api.getResourcePreviewContent(id, signal, version);
      if (++readers === 2) secondRead();
      return result;
    };
    const inFlight = new Set<string>();
    const older = refreshPoppedOutArtifacts({ bridge, inFlight, loadResourceContent,
      resources: [{ id: resourceId, currentVersion: 2, title: 'Image', mimeType: 'text/plain' }] });
    await started;
    const newer = refreshPoppedOutArtifacts({ bridge, inFlight, loadResourceContent,
      resources: [{ id: resourceId, currentVersion: 3, title: 'Image', mimeType: 'text/plain' }] });
    await joined;
    finishOlder(new Response('Version two', { headers: { 'content-type': 'text/plain' } }));
    await Promise.all([older, newer]);
    expect(updates.sort((a, b) => a.version - b.version)).toEqual([
      { version: 2, content: [86, 101, 114, 115, 105, 111, 110, 32, 116, 119, 111] },
      { version: 3, content: [86, 101, 114, 115, 105, 111, 110, 32, 116, 104, 114, 101, 101] },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces in-flight favicon requests without extending a missing response lifetime', async () => {
    let releaseIcon: ((response: Response) => void) | undefined;
    const iconResponse = new Promise<Response>((resolve) => { releaseIcon = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => iconResponse)
      .mockImplementationOnce(async () => new Response(null, { status: 404 }))
      .mockImplementationOnce(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    const first = api.getFavicon('Docs.Example.com');
    const second = api.getFavicon('docs.example.com');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseIcon?.(new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      headers: { 'Content-Type': 'image/png' },
    }));
    const [firstIcon, secondIcon] = await Promise.all([first, second]);
    expect(firstIcon).toBe(secondIcon);

    const firstMissing = api.getFavicon('missing.example.com');
    const secondMissing = api.getFavicon('MISSING.example.com');
    await expect(Promise.all([firstMissing, secondMissing])).resolves.toEqual([null, null]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(api.getFavicon('missing.example.com')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('hands a prefetched transcription ticket to the next request inside its window, once', async () => {
    const fetchMock = vi.fn(async () => json({ url: 'wss://api.rally.test/socket/transcription', ticket: 'prefetched' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    api.prefetchTranscriptionSocketTicket(50_000);
    // A second prefetch inside the window is the same ticket, not another request.
    api.prefetchTranscriptionSocketTicket(50_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(api.getTranscriptionSocketTicket()).resolves.toMatchObject({ ticket: 'prefetched' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Single-use: the next request after the handout goes to the service.
    await api.getTranscriptionSocketTicket();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requests a fresh transcription ticket once the prefetched one has aged past its window', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => json({ url: 'wss://api.rally.test/socket/transcription', ticket: 'ticket' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    api.prefetchTranscriptionSocketTicket(50_000);
    await vi.advanceTimersByTimeAsync(50_001);
    await api.getTranscriptionSocketTicket();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requests a fresh transcription ticket when the prefetch resolves only after its window', async () => {
    vi.useFakeTimers();
    let releasePrefetch!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releasePrefetch = resolve; }))
      .mockResolvedValueOnce(json({ url: 'wss://api.rally.test/socket/transcription', ticket: 'fresh' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    api.prefetchTranscriptionSocketTicket(50_000);
    const ticket = api.getTranscriptionSocketTicket();
    await vi.advanceTimersByTimeAsync(50_001);
    releasePrefetch(json({ url: 'wss://api.rally.test/socket/transcription', ticket: 'late' }));

    await expect(ticket).resolves.toMatchObject({ ticket: 'fresh' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to a fresh request when the prefetched transcription ticket failed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: 'dictation_not_configured' }, { status: 503 }))
      .mockResolvedValueOnce(json({ url: 'wss://api.rally.test/socket/transcription', ticket: 'fresh' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    api.prefetchTranscriptionSocketTicket(50_000);
    await expect(api.getTranscriptionSocketTicket()).resolves.toMatchObject({ ticket: 'fresh' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels transcription ticket acquisition even when the transport does not settle', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);
    const controller = new AbortController();
    const ticket = api.getTranscriptionSocketTicket(controller.signal);
    const rejection = expect(ticket).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    controller.abort();
    await rejection;
  });


  it('does not erase a directory visit when a child response is merged', () => {
    const child = mapWorkstreamSummary(WorkstreamSchema.parse(detail));
    expect(child).not.toHaveProperty('lastAccessedAt');
    const cached = { ...child, lastAccessedAt: '2026-09-08T00:00:00.000Z' };
    expect({ ...cached, ...child }.lastAccessedAt).toBe(cached.lastAccessedAt);
    expect(mapWorkstreamSummary(WorkstreamSchema.parse({ ...detail, lastAccessedAt: null })))
      .toHaveProperty('lastAccessedAt', null);
  });
  it('reads a Channel feed from an API that still sends locked rows, keeping only its threads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      items: [
        { kind: 'locked', placedAt: '2026-10-03T00:00:00.000Z', attentionSequenceNumber: 2, threadId: 'secret' },
        { kind: 'thread', placedAt: '2026-10-02T00:00:00.000Z', attentionSequenceNumber: 1, thread: detail },
      ],
      nextCursor: null,
      latestAttentionSequenceNumber: 2,
    })));
    const api = new RallyApi('https://api.rally.test', session);
    const page = await api.getChannelFeed('outbound', null);
    expect(page.items.map((item) => item.kind === 'thread' ? [item.thread.id, item.attentionSequenceNumber] : [item.kind]))
      .toEqual([[detail.id, 1]]);
    expect(page.latestAttentionSequenceNumber).toBe(2);
  });

  it('describes external triggers without exposing event identifiers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      ...wireAutomationDetail,
      currentDefinition: { ...wireAutomationDetail.currentDefinition, ready: false, triggers: [
        { type: 'connector_activity', connectorType: 'github', eventTypes: ['pull_request.opened'], deterministicFilters: {} },
        { type: 'webhook', eventTypes: ['build.finished'] },
      ] },
    })));
    const api = new RallyApi('https://api.rally.test', session);
    expect((await api.getAutomation(automationId)).triggerSummaries).toEqual([
      'When there is matching activity in github', 'When an external service sends an update',
    ]);
  });

  it('carries a saved tool through the detail parse, Rally plugin and all', async () => {
    const tool = {
      name: 'day_math',
      description: 'Doubles a day count.',
      inputSchema: { type: 'object', properties: { days: { type: 'integer', description: 'Days to double.' } }, required: ['days'] },
      code: 'return { doubled: input.days * 2 };',
      requiredPlugins: ['rally_core'],
    };
    vi.stubGlobal('fetch', vi.fn(async () => json({
      ...wireAutomationDetail,
      currentDefinition: { ...wireAutomationDetail.currentDefinition, customTools: [tool] },
    })));
    const api = new RallyApi('https://api.rally.test', session);
    const detail = await api.getAutomation(automationId);
    expect(detail.currentDefinition?.customTools).toEqual([expect.objectContaining({
      name: 'day_math',
      code: 'return { doubled: input.days * 2 };',
      requiredPlugins: ['rally_core'],
      inputSchema: expect.objectContaining({ properties: { days: { type: 'integer', description: 'Days to double.' } } }),
    })]);
  });

  it('maps an automation detail: scope, lifecycle, revisions, trigger lines and runs', async () => {
    // The header reads the two revisions to decide whether Create may be
    // pressed, so both have to survive the mapping exactly as the wire says
    // them; the trigger lines are rendered here rather than in the header.
    vi.stubGlobal('fetch', vi.fn(async () => json({
      ...wireAutomationDetail,
      scope: 'workspace',
      status: 'active',
      lifecycle: 'active',
      acceptedDefinitionRevision: 1,
      recentRuns: [wireAutomationRun],
    })));
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.getAutomation(automationId)).resolves.toMatchObject({
      id: automationId,
      scope: 'workspace',
      status: 'active',
      lifecycle: 'active',
      currentDefinitionRevision: 1,
      acceptedDefinitionRevision: 1,
      currentDefinition: expect.objectContaining({ ready: true }),
      triggerSummaries: ['Every 24 hours'],
      recentRuns: [expect.objectContaining({
        id: runId,
        triggerType: 'schedule',
        status: 'completed',
        resultSummary: 'Two new posts.',
        durationMs: 12_000,
      })],
    });
  });

  it('creates an automation with no body and hands back the id its route opens', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return json({ automationId }, { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.createAutomation()).resolves.toEqual({ automationId });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.rally.test/automations');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it('reads and changes delegation with a host-generated action identity and no selectable consenting user', async () => {
    const operationId = '00000000-0000-7000-8000-000000000041';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ sidekickId: automationId, creatorUserId: userId,
        you: { userId, allowed: false }, delegates: [] }))
      .mockResolvedValueOnce(json({ sidekickId: automationId, userId, allowed: true, changed: true }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);
    expect(await api.getSidekickDelegates(automationId)).toMatchObject({ delegates: [] });
    expect(await api.setMySidekickDelegation(automationId, true, operationId)).toMatchObject({ userId, allowed: true });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `https://api.rally.test/sidekicks/${automationId}/delegation`,
      `https://api.rally.test/sidekicks/${automationId}/delegation`,
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ allowed: true, operationId });
  });

  it('applies the current revision with no body and lists runs from their own route', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ ...wireAutomationDetail, lifecycle: 'active', status: 'active', acceptedDefinitionRevision: 1 }))
      .mockResolvedValueOnce(json({ items: [wireAutomationRun] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.acceptAutomation(automationId)).resolves.toMatchObject({ acceptedDefinitionRevision: 1 });
    await expect(api.getAutomationRuns(automationId)).resolves.toEqual([expect.objectContaining({ id: runId, coordinatorUserId: userId })]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://api.rally.test/sidekicks/${automationId}/accept`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`https://api.rally.test/sidekicks/${automationId}/runs`);
  });

  it('tells the person to restart Rally when a plain response does not match its schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [{ notAnAutomation: true }] })));
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.getAutomations()).rejects.toMatchObject({
      code: 'invalid_response',
      message: expect.stringContaining('Restarting Rally'),
    } satisfies Partial<ApiError>);
  });

  it('carries a channel’s model pin through to the renderer detail', () => {
    // Every realtime snapshot replaces the cached detail through this mapper, so
    // a pin dropped here is a pin that survives the first load and disappears on
    // the next socket update — taking the composer's fallback with it for the
    // work streams whose run recorded no model of its own.
    expect(mapWorkstreamDetail({ ...detail, modelOverride: 'deepseek/deepseek-v4-pro' }))
      .toMatchObject({ modelOverride: 'deepseek/deepseek-v4-pro' });
    expect(mapWorkstreamDetail(detail).modelOverride).toBeUndefined();
  });

  it.each([
    ['healthy', 'healthy'], ['error', 'healthy'],
    ['needs_reconnect', 'reconnect_required'], ['disabled', 'disabled'],
  ] as const)('maps stored %s to renderer authorization %s', (status, expected) => {
    expect(mapWorkstreamDetail({ ...detail,
      connections: detail.connections.map((connection) => ({ ...connection, status })),
    }).connections).toMatchObject([{ status: expected }]);
  });

  it('maps representative channel and resource wire records into renderer models', () => {
    expect(mapWorkstreamDetail(detail)).toMatchObject({
      id: workstreamId,
      emailAddress: 'luminous-tidal-structured-curie@automation.rallywith.ai',
      harnessStatus: 'completed',
      participants: [{ id: userId, role: 'creator' }],
      viewers: [{ id: userId, viewing: true }],
      connections: [{ id: connectionId, scope: 'you', status: 'reconnect_required' }],
    });
    expect(mapResource(resource)).toMatchObject({
      id: resourceId,
      refreshSupported: true,
      watchEnabled: false,
      watchStatus: 'unsupported',
    });
    expect(mapResource({
      ...resource,
      relationshipType: 'suggested_activity',
      direction: 'source',
    })).toMatchObject({
      relationshipType: 'attachment',
      direction: 'source',
    });
  });

  it('preserves a stopped harness status instead of reporting completion', () => {
    expect(mapWorkstreamDetail({ ...detail, harnessStatus: 'stopped' }))
      .toMatchObject({ harnessStatus: 'stopped' });
  });

  it('sends the search request as given and returns the page as the server shaped it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input; void init; return json({ results: [], nextCursor: null });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);
    await expect(api.searchWorkspace({ query: 'document', category: 'all' })).resolves.toEqual({ results: [], nextCursor: null });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ query: 'document', category: 'all' });
  });

  it('lists searchable connector resources with an opaque pagination cursor', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return json({ items: [resource], nextCursor: 'cursor-2', complete: false });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.listResources({ query: 'Launch brief', cursor: 'cursor-1', limit: 20 })).resolves.toEqual({
      items: [expect.objectContaining({ id: resourceId, title: 'Launch brief', provider: 'google_drive' })],
      nextCursor: 'cursor-2',
      complete: false,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.rally.test/resources?limit=20&q=Launch+brief&cursor=cursor-1',
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${session.accessToken}`);
  });

  it('maps harness-run metadata for the contextual rail', () => {
    expect(mapWorkstreamDetail({
      ...detail,
      latestHarnessRunId: messageId,
      latestHarnessRun: {
        id: messageId,
        origin: 'human_message',
        status: 'completed' as const,
        model: 'google/gemini-2.5-flash-lite',
        startedAt: timestamp,
        completedAt: timestamp,
        createdAt: timestamp,
      },
    })).toMatchObject({
      latestHarnessRun: {
        id: messageId,
        origin: 'human_message',
        status: 'completed',
        model: 'google/gemini-2.5-flash-lite',
      },
    });
  });

  it('maps background activity into the durable rail model', () => {
    expect(mapWorkstreamDetail({
      ...detail,
      backgroundTasks: [{
        id: taskId,
        harnessRunId: messageId,
        title: 'Respond to message',
        taskType: 'agent',
        status: 'completed',
        startedAt: timestamp,
        completedAt: '2026-07-31T20:00:12.000Z',
        tokenCount: 1_250,
        toolUses: 3,
        transcriptTurnId: messageId,
      }],
    })).toMatchObject({
      backgroundTasks: [{ id: taskId, type: 'agent', durationMs: 12_000, tokenCount: 1_250, toolUses: 3 }],
    });
  });

  it('surfaces nested service errors with their code and details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      error: {
        code: 'region_mismatch',
        message: 'Use the selected regional service.',
        details: { expected: 'enterprise' },
      },
    }, { status: 409 })));
    const api = new RallyApi('https://api.rally.test', session);

    const expected: Partial<ApiError> = {
      status: 409,
      code: 'region_mismatch',
      message: 'Use the selected regional service.',
      details: { expected: 'enterprise' },
    };
    await expect(api.getWorkspace()).rejects.toMatchObject(expected);
  });

  it('accepts the empty success response from breakout cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const api = new RallyApi('https://api.rally.test', session);
    await expect(api.cancelSubstream(workstreamId, 'cancel-operation')).resolves.toBeUndefined();
  });

  it('answers a Channel audience that left this person out of a private Channel as null', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);
    await expect(api.updateSpaceAudience('space-1', { scope: 'personal', participantUserIds: ['user-2'] })).resolves.toBeNull();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://api.rally.test/spaces/space-1/audience');
  });

  it.each(['addSubstreamParticipant', 'removeSubstreamParticipant'] as const)('validates %s membership receipts', async (method) => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ outcome: 'unchanged', membershipVersion: 1 }))
      .mockResolvedValueOnce(Response.json({ outcome: 'unchanged' })));
    const api = new RallyApi('https://api.rally.test', session);
    await expect(api[method](workstreamId, runId, userId)).resolves.toBeUndefined();
    await expect(api[method](workstreamId, runId, userId)).rejects.toThrow();
  });

  it('uses the regional organization invitation contracts end to end', async () => {
    const invitation = {
      id: '00000000-0000-7000-8000-000000000009',
      email: 'teammate@example.com',
      role: 'member' as const,
      status: 'pending' as const,
      invitedByName: 'Adam',
      expiresAt: '2026-08-08T00:00:00.000Z',
      acceptedAt: null,
      createdAt: timestamp,
    };
    const preview = {
      workspaceId,
      workspaceName: 'Rally Studio',
      region: 'global' as const,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
    const inviteUrl = 'https://rallywith.ai/invite/#region=global&token=private-token-value-long-enough';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json({ invitation, inviteUrl, emailDelivery: 'sent' }, { status: 201 }))
      .mockResolvedValueOnce(json({ items: [invitation] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.getInvitationPreview('private-token-value-long-enough')).resolves.toEqual(preview);
    await expect(api.createWorkspaceInvitation(invitation.email, 'member')).resolves.toEqual({ invitation, inviteUrl, emailDelivery: 'sent' });
    await expect(api.getWorkspaceInvitations()).resolves.toEqual([invitation]);
    await expect(api.revokeWorkspaceInvitation(invitation.id)).resolves.toBeUndefined();

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/auth/invitations/preview?token=private-token-value-long-enough');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ email: invitation.email, role: 'member' });
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: 'DELETE' });

    const login = new URL(await api.beginGoogleLogin('global', 'rallywithai://auth/complete', {
      invitationToken: 'private-token-value-long-enough',
      authAttempt: { attemptId: 'a'.repeat(43), codeChallenge: 'c'.repeat(43) },
    }));
    expect(login.origin).toBe('https://accounts.google.com');
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({
      invitationToken: 'private-token-value-long-enough',
      region: 'global',
      returnUri: 'rallywithai://auth/complete',
      desktopAttemptId: 'a'.repeat(43),
      desktopCodeChallenge: 'c'.repeat(43),
    });
  });

  it('uses identity-level onboarding endpoints before an organization is selected', async () => {
    const identitySession: DesktopSession = { ...session, workspace: null };
    const pending = {
      id: '00000000-0000-7000-8000-000000000009',
      workspaceId,
      workspaceName: 'Rally Studio',
      region: 'global' as const,
      email: 'adam@example.com',
      role: 'member' as const,
      invitedByName: 'Sam',
      expiresAt: '2026-08-08T00:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ invitations: [pending] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', identitySession);

    await expect(api.getWorkspaceOnboarding()).resolves.toEqual({ invitations: [pending] });
    await expect(api.createWorkspace('Acme Research')).resolves.toBeUndefined();
    await expect(api.acceptPendingWorkspaceInvitation(pending.id)).resolves.toBeUndefined();
    await expect(api.declinePendingWorkspaceInvitation(pending.id)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.map((call) => [String(call[0]), call[1]?.method])).toEqual([
      ['https://api.rally.test/onboarding', 'GET'],
      ['https://api.rally.test/onboarding/workspace', 'POST'],
      [`https://api.rally.test/onboarding/invitations/${pending.id}/accept`, 'POST'],
      [`https://api.rally.test/onboarding/invitations/${pending.id}`, 'DELETE'],
    ]);
  });

  it('reuses the run-now idempotency key until the server confirms the run', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(json({ runId, reused: true }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.runAutomation('automation-1')).rejects.toMatchObject({ code: 'network_error' });
    expect(reportJavascriptError).toHaveBeenCalledOnce();
    expect(reportJavascriptError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'network_error', status: 0 }),
      'network_error',
    );
    await expect(api.runAutomation('automation-1')).resolves.toEqual({ runId, reused: true });

    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/u);
    expect(secondHeaders.get('Idempotency-Key')).toBe(firstHeaders.get('Idempotency-Key'));
  });

  it('archives a Sidekick through the archive endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.archiveAutomation(automationId)).resolves.toBeUndefined();

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.rally.test/sidekicks/${automationId}/archive`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('falls back to the legacy delete route only when the archive route is missing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'The requested API route does not exist' } }, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.archiveAutomation(automationId)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.map((call) => [String(call[0]), call[1]?.method])).toEqual([
      [`https://api.rally.test/sidekicks/${automationId}/archive`, 'POST'],
      [`https://api.rally.test/sidekicks/${automationId}`, 'DELETE'],
    ]);
  });

  it('does not retry a domain-level missing Sidekick response through delete', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      error: { code: 'sidekick_not_found', message: 'This Sidekick was archived' },
    }, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.archiveAutomation(automationId)).rejects.toMatchObject({
      code: 'sidekick_not_found',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('renames a channel through the typed update endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ ...detail, title: 'Launch planning' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.renameWorkstream(workstreamId, 'Launch planning')).resolves.toMatchObject({
      id: workstreamId,
      title: 'Launch planning',
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://api.rally.test/workstreams/${workstreamId}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ title: 'Launch planning' });
  });

  it('changes who may read a channel through the same update endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ ...detail, scope: 'personal' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.setWorkstreamScope(workstreamId, 'personal')).resolves.toMatchObject({
      id: workstreamId,
      scope: 'personal',
    });

    // Only the scope travels: a PATCH that also resubmitted the description
    // would be read as somebody having authored it.
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ scope: 'personal' });
  });

  it('archives a channel through the same update endpoint', async () => {
    const archivedAt = '2026-08-25T12:00:00.000Z';
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ ...detail, archivedAt }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.archiveWorkstream(workstreamId)).resolves.toMatchObject({
      id: workstreamId,
      archivedAt,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://api.rally.test/workstreams/${workstreamId}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
    // Only `archived` travels. Resending the title or the description would be
    // read as somebody having authored them at the moment they archived it.
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ archived: true });
  });

  it('previews and enqueues a generic filtered channel batch update', async () => {
    const operationId = '00000000-0000-7000-8000-000000000099';
    const filter = {
      lastActivityAt: {
        atOrAfter: '2026-08-01T00:00:00.000Z',
        before: '2026-08-08T00:00:00.000Z',
      },
      pinned: false,
      spaceId: asSpaceId('00000000-0000-7000-8000-0000000000f2'),
      includeSystem: false,
    } as const;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ matchedCount: 20, matchedNoteCount: 3 }))
      .mockResolvedValueOnce(json(
        { operationId, enqueuedCount: 20, archivedNoteCount: 3 },
        { status: 202 },
      ));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    // Both halves of the grouping travel: the work streams the Queue will
    // carry, and the notes the workspace object archived before answering.
    await expect(api.previewWorkstreamBatch(filter))
      .resolves.toEqual({ matchedCount: 20, matchedNoteCount: 3 });
    await expect(api.applyWorkstreamBatch(operationId, filter, { kind: 'archive' }))
      .resolves.toEqual({ enqueuedCount: 20, archivedNoteCount: 3 });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.rally.test/workstreams/batch/preview');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ filter });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://api.rally.test/workstreams/batch');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      operationId,
      filter,
      update: { kind: 'archive' },
    });
  });

  it('creates an attachment-only channel with its draft resource IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      workstream: detail,
      turnId: messageId,
      harnessRunId: null,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.createWorkstream({
      openingMessage: '',
      participantIds: [],
      attachmentIds: [resourceId],
    })).resolves.toMatchObject({ turnId: messageId, workstream: { id: workstreamId } });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      openingMessage: '',
      participantUserIds: [],
      clientMessageId: expect.any(String),
      attachmentIds: [resourceId],
    });
  });

  it('given a space launcher, when a channel is created, then the space is sent to the authorization gate', async () => {
    const spaceIds = ['00000000-0000-7000-8000-0000000000a7'];
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      workstream: detail,
      turnId: messageId,
      harnessRunId: null,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await api.createWorkstream({ openingMessage: 'Start', participantIds: [], spaceIds, title: 'Launch' });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ spaceIds, title: 'Launch' });
  });

  it('given the top-level composer, when a channel is created, then it names no space and the server places it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      workstream: detail,
      turnId: messageId,
      harnessRunId: null,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await api.createWorkstream({ openingMessage: 'Start', participantIds: [] });

    // Absent rather than empty: every Channel has a home, and a creation that
    // names no Space is placed in General by the server rather than by asking
    // the person at the composer to choose one.
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty('spaceIds');
  });

  it('encodes an opening mention with the normal message resolver and seats its identity', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        items: [{ user, role: 'owner', status: 'active', joinedAt: timestamp }],
      }))
      .mockResolvedValueOnce(json({
        workstream: detail,
        turnId: messageId,
        harnessRunId: null,
      }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await api.createWorkstream({
      openingMessage: 'Ask @Adam to review',
      participantIds: [],
      mentions: [{ type: 'person', label: 'Adam', userId, connectorType: null }],
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/workspace/members');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      openingMessage: 'Ask @Adam to review',
      participantUserIds: [userId],
      clientMessageId: expect.any(String),
      attachmentIds: [],
      mentions: [{
        type: 'person',
        userId,
        connectorType: null,
        startOffset: 4,
        endOffset: 9,
      }],
    });
  });

  it('acknowledges visible messages and marks a channel unread through durable read-state endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        ...detail,
        readThroughSequenceNumber: 4,
        hasUnread: false,
        firstUnreadSequenceNumber: null,
      }))
      .mockResolvedValueOnce(json({
        ...detail,
        readThroughSequenceNumber: 4,
        manualUnreadFromSequenceNumber: 4,
        manualUnreadGeneration: 1,
        hasUnread: true,
        firstUnreadSequenceNumber: 4,
      }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.acknowledgeConversationRead(workstreamId, '0', 4, 0)).resolves.toMatchObject({
      readThroughSequenceNumber: 4,
      hasUnread: false,
    });
    await expect(api.markWorkstreamUnread(workstreamId)).resolves.toMatchObject({
      manualUnreadFromSequenceNumber: 4,
      manualUnreadGeneration: 1,
      hasUnread: true,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.rally.test/conversations/${workstreamId}/substreams/0/read-state`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      readThroughSequenceNumber: 4,
      observedManualUnreadGeneration: 0,
    });
    // Marking unread stays on the work stream: the sidebar takes that action
    // with no conversation open, and the row's dot is Main's.
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `https://api.rally.test/workstreams/${workstreamId}/read-state/mark-unread`,
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('acknowledges a read in a private breakout against that breakout, not its parent', async () => {
    // The waterline being moved belongs to the child object. Addressed to the
    // work stream, this read landed on Main and the child's own unread divider
    // had nothing that could clear it.
    const substreamId = '00000000-0000-7000-8000-0000000000c1';
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      ...detail,
      id: workstreamId,
      readThroughSequenceNumber: 9,
      hasUnread: false,
      firstUnreadSequenceNumber: null,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.acknowledgeConversationRead(workstreamId, substreamId, 9, 2))
      .resolves.toMatchObject({ readThroughSequenceNumber: 9, hasUnread: false });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.rally.test/conversations/${workstreamId}/substreams/${substreamId}/read-state`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      readThroughSequenceNumber: 9,
      observedManualUnreadGeneration: 2,
    });
  });

  it('uses the watch, attach, and detach service contracts without inventing response fields', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ watchEnabled: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ ...resource, relationshipType: 'attachment', direction: 'source' }, { status: 201 }))
      .mockResolvedValueOnce(json(detail))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.setResourceWatch(workstreamId, resourceId, true)).resolves.toEqual({ enabled: true });
    await expect(api.setResourceWatch(workstreamId, resourceId, false)).resolves.toEqual({ enabled: false });
    await expect(api.attachResource(workstreamId, resourceId)).resolves.toMatchObject({ id: workstreamId });
    await expect(api.detachResource(workstreamId, resourceId)).resolves.toBeUndefined();

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://api.rally.test/resources/${resourceId}/watch`);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`workstreamId=${workstreamId}`);
    // Resources hang off the conversation, whichever kind of parent it has,
    // and the attach re-reads the boot from the same place.
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe(`https://api.rally.test/conversations/${workstreamId}/resources`);
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe(`https://api.rally.test/conversations/${workstreamId}`);
    expect(String(fetchMock.mock.calls[4]?.[0])).toBe(`https://api.rally.test/conversations/${workstreamId}/resources/${resourceId}`);
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('starts and reconciles a durable connector OAuth attempt', async () => {
    const attemptId = 'a'.repeat(43);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        url: 'https://linear.app/oauth/authorize?state=opaque',
        attemptId,
      }))
      .mockResolvedValueOnce(json({
        attemptId,
        provider: 'linear',
        status: 'succeeded',
        connectionId,
        errorCode: null,
        expiresAt: timestamp,
      }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.startProviderConnection('linear', 'you', ['linear.read'])).resolves.toEqual({
      url: 'https://linear.app/oauth/authorize?state=opaque',
      attemptId,
    });
    const startHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.rally.test/connections/linear/start?telemetryVersion=2&desktopHandoffVersion=2',
    );
    expect(startHeaders.get('X-Rally-Operation-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(startHeaders.has('X-Rally-Telemetry-Version')).toBe(false);
    expect(reportTelemetryProductIntent).toHaveBeenCalledOnce();
    expect(reportTelemetryProductIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'connector_setup_requested_v2', connector: 'linear', scope: 'personal',
      method: 'oauth', capabilityCount: 'one', operationId: startHeaders.get('X-Rally-Operation-Id'),
    }));
    await expect(api.getConnectorOAuthAttempt(attemptId)).resolves.toMatchObject({
      status: 'succeeded',
      connectionId,
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `https://api.rally.test/connections/oauth-attempts/${attemptId}`,
    );
  });

});

describe('message mention resolution', () => {
  function stubRoster(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/workspace/members')) {
        return json({ items: [{ user, role: 'owner', status: 'active', joinedAt: timestamp }] });
      }
      // Deliberately unstubbed beyond the roster: resolution reads workspace
      // members and nothing else, so a request for the work stream — which is
      // what used to carry the connections — fails this test loudly.
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('does not fetch the organization roster for plain message text', async () => {
    const fetchMock = stubRoster();
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.messageMentionPayload('Send the finished brief')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves selected guest mentions without organization-directory discovery', async () => {
    const fetchMock = stubRoster();
    const guestSession: CookieClientSession = { authentication: 'cookie', expiresAt: session.expiresAt,
      apiBaseUrl: '/regional/global/browser/api/' + workspaceId, user: session.user,
      workspace: { id: workspaceId, name: 'Shared', region: 'global', role: null, accessClass: 'guest' } };
    const api = new RallyApi(guestSession.apiBaseUrl, guestSession);
    await expect(api.messageMentionPayload('Ask @Adam', [{ type: 'person', label: 'Adam', userId, connectorType: null }]))
      .resolves.toEqual([{ type: 'person', userId, connectorType: null, startOffset: 4, endOffset: 9 }]);
    await expect(api.messageMentionPayload('Ask @Adam')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the organization roster for durable person mention Markdown', async () => {
    const fetchMock = stubRoster();
    const api = new RallyApi('https://api.rally.test', session);

    await api.messageMentionPayload(`Ask Adam (person://${userId})`);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/workspace/members');
  });

  it('reuses a supplied organization roster instead of fetching it again', async () => {
    const fetchMock = stubRoster();
    const api = new RallyApi('https://api.rally.test', session);
    const roster = [{
      id: user.id,
      name: user.name,
      email: user.email,
      timezone: user.timezone,
      role: 'owner',
      status: 'active' as const,
    }];

    await expect(api.messageMentionPayload('Ask @Adam', [], roster)).resolves.toEqual([
      { type: 'person', userId, connectorType: null, startOffset: 4, endOffset: 9 },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes a supplied roster once when it cannot resolve a typed person', async () => {
    const fetchMock = stubRoster();
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.messageMentionPayload('Ask @Adam', [], [])).resolves.toEqual([
      { type: 'person', userId, connectorType: null, startOffset: 4, endOffset: 9 },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/workspace/members');
  });

  it('resolves a typed member name and leaves a typed connection name alone', async () => {
    stubRoster();
    const api = new RallyApi('https://api.rally.test', session);

    const mentions = await api.messageMentionPayload('ask @Adam about @Google Drive');

    // The composer offers people and highlights people; a connection typed by
    // hand has to reach the transcript as the plain text it looks like.
    expect(mentions).toEqual([
      { type: 'person', userId, connectorType: null, startOffset: 4, endOffset: 9 },
    ]);
  });

  it('still carries a connector mention a caller selected deliberately', async () => {
    stubRoster();
    const api = new RallyApi('https://api.rally.test', session);

    const mentions = await api.messageMentionPayload(
      'ask @Google Drive for the brief',
      [{ type: 'connector', label: 'Google Drive', userId: null, connectorType: 'google' }],
    );

    expect(mentions).toEqual([
      { type: 'connector', userId: null, connectorType: 'google', startOffset: 4, endOffset: 17 },
    ]);
  });

  it('preserves which same-name person was selected for each occurrence', async () => {
    const secondUserId = '00000000-0000-7000-8000-000000000012';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/workspace/members')) {
        return json({
          items: [
            { user: { ...user, name: 'Alex' }, role: 'owner', status: 'active', joinedAt: timestamp },
            { user: { ...user, id: secondUserId, email: 'other@example.com', name: 'Alex' }, role: 'member', status: 'active', joinedAt: timestamp },
          ],
        });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    }));
    const api = new RallyApi('https://api.rally.test', session);

    const mentions = await api.messageMentionPayload('Ask @Alex then @Alex', [
      { type: 'person', label: 'Alex', userId, connectorType: null, startOffset: 4, endOffset: 9 },
      { type: 'person', label: 'Alex', userId: secondUserId, connectorType: null, startOffset: 15, endOffset: 20 },
    ]);

    expect(mentions).toEqual([
      { type: 'person', userId, connectorType: null, startOffset: 4, endOffset: 9 },
      { type: 'person', userId: secondUserId, connectorType: null, startOffset: 15, endOffset: 20 },
    ]);
  });
});

describe('socket ticket transport', () => {
  it('bounds every persistent-socket ticket even when fetch ignores cancellation', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    }));
    const api = new RallyApi('https://api.rally.test', session);
    const tickets = [
      api.getWorkspaceSocketTicket(),
      api.getSocketTicket(workstreamId),
    ];
    const rejections = tickets.map((ticket) => expect(ticket).rejects.toMatchObject({
      code: 'socket_ticket_timeout',
      name: 'SocketTicketRequestTimeoutError',
    }));

    await vi.advanceTimersByTimeAsync(SOCKET_TICKET_REQUEST_TIMEOUT_MS);

    await Promise.all(rejections);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(signals.every((signal) => signal.reason instanceof DOMException
      && signal.reason.name === 'AbortError')).toBe(true);
  });

  it('does not report a bounded ticket cancellation as a network failure', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })
    )));
    const api = new RallyApi('https://api.rally.test', session);
    const ticket = api.getWorkspaceSocketTicket();
    const rejection = expect(ticket).rejects.toMatchObject({
      code: 'socket_ticket_timeout',
    });

    await vi.advanceTimersByTimeAsync(SOCKET_TICKET_REQUEST_TIMEOUT_MS);

    await rejection;
    expect(reportJavascriptError).not.toHaveBeenCalled();
  });

  it('drops the query ticket the endpoint still returns and offers it as a subprotocol', async () => {
    // The server keeps `?ticket=` in the URL for desktop builds released before
    // the subprotocol scheme. Nothing here may open a socket with it, because
    // Cloudflare records request URLs into stores this app cannot redact.
    vi.stubGlobal('fetch', vi.fn(async () => json({
      url: `wss://api.rally.test/socket/workstreams/${workstreamId}?ticket=socket-ticket`,
      ticket: 'socket-ticket',
    })));
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.getSocketTicket(workstreamId)).resolves.toEqual({
      url: `wss://api.rally.test/socket/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
    });
  });

  it('requests a signed subscription bootstrap at the current feed cursor', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return json({
        url: `wss://api.rally.test/socket/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        subscriptionBootstrap: true,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.getSocketTicket(workstreamId, '0', undefined, 42)).resolves.toMatchObject({
      subscriptionBootstrap: true,
    });
    // The ticket is issued under the conversation, not the work stream: the
    // same route serves an automation's feed.
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.rally.test/conversations/${workstreamId}/substreams/0/socket?afterSequence=42`,
    );
  });

  it('labels a hover feed ticket as speculative', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return json({
        url: `wss://api.rally.test/socket/workstreams/${workstreamId}`,
        ticket: 'socket-ticket',
        subscriptionBootstrap: true,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await api.getSocketTicket(workstreamId, '0', undefined, 0, true);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('afterSequence=0&speculative=true');
  });

  it('requests the one organization-scoped sync and command socket ticket', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return json({
        url: 'wss://api.rally.test/socket/workspaces/workspace-1?ticket=workspace-ticket',
        ticket: 'workspace-ticket',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.getWorkspaceSocketTicket()).resolves.toEqual({
      url: 'wss://api.rally.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/workspace/socket');
  });
});

describe('request correlation', () => {
  it('stamps every call with an x-request-id the regional service will honour', async () => {
    const sent: Array<RequestInit | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(init);
      return json(detail);
    }));
    const api = new RallyApi('https://api.rally.test', session);

    await api.getConversation(workstreamId);
    await api.getConversation(workstreamId);

    const ids = sent.map((init) => new Headers(init?.headers).get('x-request-id'));
    // Without one the service mints its own, which no client-side trace line
    // names — a slow call would then be findable only by timestamp.
    expect(ids[0]).toMatch(/^[A-Za-z0-9._:-]{1,100}$/u);
    // Per call, not per client: two requests sharing an id would collapse into
    // one row's worth of phases in Workers Logs.
    expect(ids[0]).not.toEqual(ids[1]);
  });

  it('sends the id a flow is already being traced under', async () => {
    const sent: Array<RequestInit | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(init);
      return json({ workstream: detail, turnId: messageId, harnessRunId: null });
    }));
    const api = new RallyApi('https://api.rally.test', session);

    await api.createWorkstream({
      openingMessage: 'Prepare the launch brief',
      participantIds: [],
      requestId: 'trace-from-the-screen',
    });

    expect(new Headers(sent[0]?.headers).get('x-request-id')).toBe('trace-from-the-screen');
  });

  it('correlates channel detail attempts separately from each request and socket start', async () => {
    const sent: Array<RequestInit | undefined> = [];
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(init);
      urls.push(String(input));
      return String(input).endsWith('/socket')
        ? json({ url: `wss://api.rally.test/socket/conversations/${workstreamId}/0`, ticket: 'ticket' })
        : json(detail);
    }));
    const api = new RallyApi('https://api.rally.test', session);

    await api.getConversation(workstreamId, undefined, 'feed-visible-operation');
    await api.getSocketTicket(workstreamId, '0', 'feed-start-operation');

    const requestIds = sent.map((init) => new Headers(init?.headers).get('x-request-id'));
    expect(requestIds[0]).toMatch(/^[A-Za-z0-9._:-]{1,100}$/u);
    expect(requestIds[0]).not.toBe('feed-visible-operation');
    expect(requestIds[1]).toBe('feed-start-operation');
    expect(sent.map((init) => new Headers(init?.headers).get('x-rally-operation-id'))).toEqual([
      'feed-visible-operation',
      null,
    ]);
    expect(urls).toEqual([
      `https://api.rally.test/conversations/${workstreamId}`,
      `https://api.rally.test/conversations/${workstreamId}/substreams/0/socket`,
    ]);
  });
});

describe('expired access-token recovery', () => {
  const renewed: DesktopSession = { ...session, accessToken: 'renewed-access-token-longer-than-twenty' };
  // What the endpoint sends, and what the client hands back after stripping the
  // query ticket and attaching the handshake subprotocols. Keeping them
  // separate stops the fixture from implying the server sends `protocols`.
  const wireTicket = { url: 'wss://api.rally.test/socket', ticket: 'socket-ticket' };
  const parsedTicket = { ...wireTicket, protocols: socketTicketProtocols('socket-ticket') };

  function unauthorizedUntilRenewed() {
    return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(
      new Headers(init?.headers).get('Authorization') === `Bearer ${renewed.accessToken}`
        ? json(wireTicket)
        : json({ error: { code: 'invalid_session', message: 'The session is invalid or expired' } }, { status: 401 }),
    ));
  }

  it('renews the credential and replays the rejected request', async () => {
    const fetchMock = unauthorizedUntilRenewed();
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);
    const renew = vi.fn().mockResolvedValue(renewed);
    api.setCredentialRenewal(renew);

    await expect(api.getSocketTicket(workstreamId)).resolves.toEqual(parsedTicket);
    expect(renew).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization'))
      .toBe(`Bearer ${renewed.accessToken}`);
  });

  it('renews once for a burst of concurrent rejections', async () => {
    vi.stubGlobal('fetch', unauthorizedUntilRenewed());
    const api = new RallyApi('https://api.rally.test', session);
    let release!: (value: DesktopSession) => void;
    const renew = vi.fn(() => new Promise<DesktopSession>((resolve) => {
      release = resolve;
    }));
    api.setCredentialRenewal(renew);

    const pending = Promise.all([
      api.getSocketTicket(workstreamId),
      api.getSocketTicket(workstreamId),
      api.getSocketTicket(workstreamId),
    ]);
    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
    release(renewed);

    await expect(pending).resolves.toEqual([parsedTicket, parsedTicket, parsedTicket]);
    expect(renew).toHaveBeenCalledOnce();
  });

  it('surfaces the original rejection when no renewal is registered', async () => {
    const fetchMock = unauthorizedUntilRenewed();
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.getSocketTicket(workstreamId)).rejects.toMatchObject({
      status: 401,
      code: 'invalid_session',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('leaves a 401 that is not a rejected bearer alone', async () => {
    // A replayed socket ticket shares the status but renewing would burn a
    // refresh-token rotation and silently repeat the request.
    const fetchMock = vi.fn().mockResolvedValue(json(
      { error: { code: 'socket_ticket_replayed', message: 'The socket ticket was already used' } },
      { status: 401 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);
    const renew = vi.fn().mockResolvedValue(renewed);
    api.setCredentialRenewal(renew);

    await expect(api.getSocketTicket(workstreamId)).rejects.toMatchObject({
      status: 401,
      code: 'socket_ticket_replayed',
      message: 'The socket ticket was already used',
    });
    expect(renew).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('renews for every code that means the session credential was rejected', async () => {
    for (const code of ['invalid_session', 'authentication_required', 'session_revoked']) {
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(
        new Headers(init?.headers).get('Authorization') === `Bearer ${renewed.accessToken}`
          ? json(wireTicket)
          : json({ error: { code } }, { status: 401 }),
      ));
      vi.stubGlobal('fetch', fetchMock);
      const api = new RallyApi('https://api.rally.test', session);
      api.setCredentialRenewal(vi.fn().mockResolvedValue(renewed));

      await expect(api.getSocketTicket(workstreamId)).resolves.toEqual(parsedTicket);
      expect(fetchMock, code).toHaveBeenCalledTimes(2);
    }
  });

  it('keeps the rejection readable for the caller when renewal is declined', async () => {
    // The body is peeked through a clone, so nothing consumes it out from
    // under the error the caller ultimately sees.
    const fetchMock = unauthorizedUntilRenewed();
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);
    api.setCredentialRenewal(vi.fn().mockResolvedValue(session));

    await expect(api.getSocketTicket(workstreamId)).rejects.toMatchObject({
      status: 401,
      code: 'invalid_session',
      message: 'The session is invalid or expired',
    });
  });

  it('does not replay unauthenticated when signing out clears the session mid-flight', async () => {
    const fetchMock = unauthorizedUntilRenewed();
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);
    api.setCredentialRenewal(vi.fn().mockResolvedValue(renewed));
    // Sign-out lands between the request and its rejection.
    void Promise.resolve().then(() => api.setSession(null));

    await expect(api.getSocketTicket(workstreamId)).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry when renewal fails', async () => {
    const fetchMock = unauthorizedUntilRenewed();
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);
    api.setCredentialRenewal(vi.fn().mockRejectedValue(new Error('offline')));

    await expect(api.getSocketTicket(workstreamId)).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not restore a bearer when sign-out completes during renewal', async () => {
    const fetchMock = unauthorizedUntilRenewed();
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);
    let release!: (value: DesktopSession) => void;
    const renew = vi.fn(() => new Promise<DesktopSession>((resolve) => { release = resolve; }));
    api.setCredentialRenewal(renew);
    const pending = api.getSocketTicket(workstreamId);
    const rejection = expect(pending).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
    api.setSession(null);
    release(renewed);
    await rejection;
    expect(api.viewerUserId).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('allows the session provider to publish the renewed credential before renewal resolves', async () => {
    const fetchMock = unauthorizedUntilRenewed();
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);
    api.setCredentialRenewal(async () => {
      api.setSession(renewed);
      return renewed;
    });
    await expect(api.getSocketTicket(workstreamId)).resolves.toEqual(parsedTicket);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('replays an unauthorized upload under the renewed credential', async () => {
    class StubUpload {
      static instances: StubUpload[] = [];
      readonly headers = new Map<string, string>();
      readonly upload = { addEventListener: (): void => undefined };
      private readonly listeners = new Map<string, () => void>();
      responseType = '';
      status = 401;
      response: unknown = { error: { code: 'invalid_session' } };
      open(): void { StubUpload.instances.push(this); }
      setRequestHeader(name: string, value: string): void { this.headers.set(name, value); }
      addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
      send(): void {
        if (this.headers.get('Authorization') === `Bearer ${renewed.accessToken}`) {
          this.status = 200;
          this.response = resource;
        }
        queueMicrotask(() => this.listeners.get('load')?.());
      }
    }
    vi.stubGlobal('XMLHttpRequest', StubUpload);
    const api = new RallyApi('https://api.rally.test', session);
    api.setCredentialRenewal(vi.fn().mockResolvedValue(renewed));

    await expect(api.uploadResource(new File(['body'], 'note.txt'), 'draft-1'))
      .resolves.toMatchObject({ id: resourceId });
    expect(StubUpload.instances).toHaveLength(2);
  });

  it('reports a caught upload transport failure through exception telemetry', async () => {
    class FailedUpload {
      readonly upload = { addEventListener: (): void => undefined };
      private readonly listeners = new Map<string, () => void>();
      responseType = '';
      open(): void { /* Test transport does not open a real connection. */ }
      setRequestHeader(): void { /* Headers are irrelevant to the failure. */ }
      addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
      send(): void { queueMicrotask(() => this.listeners.get('error')?.()); }
    }
    vi.stubGlobal('XMLHttpRequest', FailedUpload);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.uploadResource(new File(['body'], 'note.txt'), 'draft-1'))
      .rejects.toMatchObject({ status: 0, code: 'network_error' });
    expect(reportJavascriptError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'network_error', status: 0 }),
      'network_error',
    );
  });

  it('does not report a late upload error after cancellation', async () => {
    class CancelledUpload {
      readonly upload = { addEventListener: (): void => undefined };
      private readonly listeners = new Map<string, () => void>();
      responseType = '';
      open(): void { /* Test transport does not open a real connection. */ }
      setRequestHeader(): void { /* Headers are irrelevant to cancellation. */ }
      addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
      send(): void { /* Cancellation drives the events. */ }
      abort(): void {
        this.listeners.get('abort')?.();
        this.listeners.get('error')?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', CancelledUpload);
    const api = new RallyApi('https://api.rally.test', session);
    const controller = new AbortController();
    const upload = api.uploadResource(new File(['body'], 'note.txt'), 'draft-1', undefined, controller.signal);

    controller.abort();

    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
    expect(reportJavascriptError).not.toHaveBeenCalled();
  });

  it("keeps query parameter names out of the log but never their values", async () => {
    // `/auth/invitations/preview?token=…` carries a live invitation credential
    // and `/resources?q=…` carries whatever someone typed into a search box.
    // Neither belongs in the renderer's console or log file.
    expect(redactQuery('/auth/invitations/preview?token=secret-invitation-token'))
      .toBe('/auth/invitations/preview?token');
    expect(redactQuery('/resources?limit=50&q=quarterly%20revenue'))
      .toBe('/resources?limit,q');
    expect(redactQuery('/workstreams/abc/participants')).toBe('/workstreams/abc/participants');
  });

  it('returns the authenticated speech body without buffering it', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Uint8Array.of(0x00, 0x40));
      controller.close();
    } });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(body, {
      headers: { 'Content-Type': 'audio/pcm;rate=24000;channels=1;bits=16;endian=little' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    const stream = await api.streamMessageSpeech('## Complete response', new AbortController().signal);

    expect(await stream.getReader().read()).toEqual({ done: false, value: Uint8Array.of(0x00, 0x40) });
    expect(fetchMock).toHaveBeenCalledWith('https://api.rally.test/speech', expect.objectContaining({
      body: JSON.stringify({ markdown: '## Complete response' }),
      method: 'POST',
    }));
    const headers = new Headers(fetchMock.mock.calls[0]![1]!.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${session.accessToken}`);
  });
});

describe('browser cookie collaboration transport', () => {
  const cookie: CookieClientSession = { authentication: 'cookie', apiBaseUrl: `/regional/global/browser/api/${workspaceId}`,
    user: session.user, workspace: session.workspace, expiresAt: session.expiresAt };

  it('asks a connector authorization to return to the browser completion page', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => json({ url: 'https://linear.app/oauth/authorize?state=opaque', attemptId: 'a'.repeat(43) }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi(cookie.apiBaseUrl, cookie);
    await api.startProviderConnection('linear', 'you', ['linear.read']).catch(() => undefined);
    await api.reconnectConnection('connection-1', 'linear').catch(() => undefined);
    await api.startConnectorResourceAuthorization({ connectionId: 'connection-1', parentKind: 'workstream', parentId: workstreamId,
      substreamId: '0', failedToolInvocationId: 'tool-1' } as Parameters<RallyApi['startConnectorResourceAuthorization']>[0]).catch(() => undefined);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${cookie.apiBaseUrl}/connections/linear/start?telemetryVersion=2&handoff=browser`,
      `${cookie.apiBaseUrl}/connections/connection-1/reconnect?telemetryVersion=2&handoff=browser`,
      `${cookie.apiBaseUrl}/connections/connection-1/resource-authorizations/start?handoff=browser`,
    ]);
  });

  it('reuses reads and scoped mutations with same-origin cookies and no bearer', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'PATCH'
      ? new Response(null, { status: 204 }) : json(detail));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi(cookie.apiBaseUrl, cookie);
    expect(api.viewerUserId).toBe(userId);
    await expect(api.getConversation(workstreamId)).resolves.toMatchObject({ id: workstreamId });
    await api.renameSubstream(workstreamId, '0', 'Shared main');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${cookie.apiBaseUrl}/conversations/${workstreamId}`,
      `${cookie.apiBaseUrl}/conversations/${workstreamId}/substreams/0`,
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.credentials).toBe('same-origin');
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    }
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ title: 'Shared main' }));
  });

  it('resolves either a Thread or Breakout through its parent-owned registry mutation', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi(cookie.apiBaseUrl, cookie);
    await api.resolveConversation(workstreamId, '0');
    await api.resolveConversation(workstreamId, 'breakout-1');
    expect(fetchMock.mock.calls.map(([url, init]) => ({ url, method: init?.method, body: init?.body }))).toEqual([
      { url: `${cookie.apiBaseUrl}/conversations/${workstreamId}/substreams/0`, method: 'PATCH', body: '{"resolved":true}' },
      { url: `${cookie.apiBaseUrl}/conversations/${workstreamId}/substreams/breakout-1`, method: 'PATCH', body: '{"resolved":true}' },
    ]);
  });

  it('does not attempt native credential renewal for a rejected cookie', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: { code: 'invalid_session' } }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi(cookie.apiBaseUrl, cookie);
    const renew = vi.fn().mockResolvedValue(session);
    api.setCredentialRenewal(renew);
    await expect(api.getConversation(workstreamId)).rejects.toMatchObject({ status: 401 });
    expect(renew).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps tickets in handshake protocols and routes sockets through the browser origin', async () => {
    const ticket = 'test-ticket-longer-than-twenty';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ url: `wss://api.rally.test/socket/conversations/${workstreamId}/0?ticket=${ticket}`, ticket })));
    const api = new RallyApi(cookie.apiBaseUrl, cookie);
    const result = await api.getSocketTicket(workstreamId);
    const expected = new URL(`/regional/global/socket/conversations/${workstreamId}/0`, location.origin);
    expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
    expect(result.url).toBe(expected.toString());
    expect(result.url).not.toContain(ticket);
    expect(result.protocols).toEqual(socketTicketProtocols(ticket));
  });

  it('reports an invalid browser socket path as an API schema error', async () => {
    const ticket = 'test-ticket-longer-than-twenty';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ url: 'wss://api.rally.test/unexpected', ticket })));
    const api = new RallyApi(cookie.apiBaseUrl, cookie);
    await expect(api.getSocketTicket(workstreamId)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('uploads using the same scoped resource path without a bearer header', async () => {
    class CookieUpload {
      static current: CookieUpload;
      readonly headers = new Headers();
      readonly upload = { addEventListener: (): void => undefined };
      private readonly listeners = new Map<string, () => void>();
      responseType = '';
      status = 200;
      response: unknown = resource;
      url = '';
      open(_method: string, url: string): void { this.url = url; CookieUpload.current = this; }
      setRequestHeader(name: string, value: string): void { this.headers.set(name, value); }
      addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
      send(): void { queueMicrotask(() => this.listeners.get('load')?.()); }
    }
    vi.stubGlobal('XMLHttpRequest', CookieUpload);
    const api = new RallyApi(cookie.apiBaseUrl, cookie);
    await expect(api.uploadResource(new File(['body'], 'note.txt'), 'draft-1')).resolves.toMatchObject({ id: resourceId });
    expect(CookieUpload.current.url).toBe(`${cookie.apiBaseUrl}/resources/upload`);
    expect(CookieUpload.current.headers.has('Authorization')).toBe(false);
    expect(CookieUpload.current.headers.get('X-Rally-Draft-Id')).toBe('draft-1');
  });
});

it('reports the signup view through its narrow endpoint and accepts the no-content receipt', async () => {
  const flowId = '00000000-0000-7000-8000-000000000019';
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  const api = new RallyApi('https://api.rally.test', session);
  await expect(api.observeSignupView(flowId)).resolves.toBeUndefined();
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.rally.test/auth/signup/view');
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ flowId }) });
});
