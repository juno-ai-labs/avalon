import { AutomationAgentSnapshotSchema, type AutomationAgentSnapshot } from '@rally/contracts';
import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RallyApi, mapResource, mapWorkstreamDetail, redactQuery } from './api';
import type { ApiError } from './api';
import type { DesktopSession } from '../../common/desktop';

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
const templateId = '00000000-0000-7000-8000-000000000009';
const currentVersionId = '00000000-0000-7000-8000-000000000010';
const nextVersionId = '00000000-0000-7000-8000-000000000011';
const taskId = '00000000-0000-7000-8000-000000000013';
const noteId = '00000000-0000-7000-8000-000000000014';

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
  originType: 'ad_hoc' as const,
  originLabel: null,
  createdByUserId: userId,
  automationSubscriptionId: null,
  automationRunId: null,
  plannedFor: null,
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
  participantUserIds: [],
  participantExtraCount: 0,
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

const turnId = '00000000-0000-7000-8000-000000000015';
const assistantTurnId = '00000000-0000-7000-8000-000000000016';
const clientMessageId = '00000000-0000-7000-8000-000000000017';
const elicitationId = '00000000-0000-7000-8000-000000000018';

/** A finished definition, as AutomationAgent stores it. */
const readyDraft = {
  name: 'Blog monitor',
  description: 'Check a blog for new posts.',
  overview: 'Checks the configured blog every day.',
  instructions: 'Check the configured blog and report new posts.',
  triggers: [{ type: 'interval' as const, intervalSeconds: 86_400, summary: 'Every 24 hours' }],
  requiredCapabilities: [],
  expectedOutputs: ['New post summary'],
  requestedDelivery: [] as string[],
  defaultBehavior: {},
  recommendedPlugins: [],
  memoryTables: [],
  suggestedScope: 'personal' as const,
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

/**
 * The durable frame the draft socket and `GET .../agent/draft` both
 * carry, parsed through the shared schema so a fixture cannot drift
 * into a shape the wire could never deliver.
 */
function agentSnapshot(overrides: Record<string, unknown>): AutomationAgentSnapshot {
  return AutomationAgentSnapshotSchema.parse({
    schemaVersion: 1,
    automationId,
    workspaceId,
    authorUserId: userId,
    region: 'global',
    lifecycle: 'draft',
    authorityGeneration: 1,
    title: 'Blog monitor',
    definitionRevision: 2,
    definition: readyDraft,
    messages: [
      {
        turnId,
        transcriptSequence: 1,
        role: 'user',
        authorUserId: userId,
        clientMessageId,
        content: 'Check this blog every 24 hours.',
        attachmentIds: [resourceId],
        createdAt: 1_760_000_000_000,
      },
      {
        turnId: assistantTurnId,
        transcriptSequence: 2,
        role: 'assistant',
        authorUserId: null,
        clientMessageId: null,
        content: 'Which blog should I monitor?',
        attachmentIds: [],
        createdAt: 1_760_000_000_001,
      },
    ],
    activeCompilerRun: null,
    compilerCheckpoint: null,
    pendingElicitation: null,
    eventSequence: 7,
    ...overrides,
  });
}

const wireAutomationDetail = {
  id: automationId,
  name: 'Blog monitor',
  description: 'Check a blog for new posts.',
  emailAddress: null,
  scope: 'personal' as const,
  status: 'active' as const,
  nextRunAt: null,
  lastRunAt: null,
  updatedAt: timestamp,
  updateAvailable: false,
  templateId,
  templateVersionId: currentVersionId,
  versionNumber: 1,
  instructions: 'Check the configured blog and report new posts.',
  overview: 'Checks the configured blog every day.',
  triggers: [{ type: 'interval' as const, intervalSeconds: 86_400, summary: 'Every 24 hours' }],
  requiredCapabilities: [],
  expectedOutputs: ['New post summary'],
  executionPrincipal: { type: 'user', userId },
  recommendedPlugins: [],
  memoryTables: [],
  defaultPluginIds: [],
  activitySourcePluginIds: {},
  deliveryTargets: [],
  templateUpdate: null,
  nextPlannedWorkstream: null,
  recentRuns: [],
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  reportJavascriptError.mockReset();
  reportTelemetryProductIntent.mockReset();
});

describe('Rally API wire adapter', () => {
  it.each([
    [['email'], true, false],
    [['slack_agent_dm'], false, true],
    [['email', 'slack_agent_dm'], true, true],
    [[], false, false],
  ])('carries the compiler\'s own %j through to the destination choices', (requested, email, slack) => {
    const api = new RallyApi('https://api.rally.test', session);

    const result = api.automationDraftFromAgentSnapshot(agentSnapshot({
      definition: {
        ...readyDraft,
        requestedDelivery: requested,
        // Deliberately prose that a regex would read as a delivery
        // request: the point of the structured field is that this no
        // longer decides anything.
        expectedOutputs: ['A ranked list of your five most important emails'],
      },
    }));

    expect(result.draft?.summary?.requiresEmailDelivery).toBe(email);
    expect(result.draft?.summary?.requiresSlackDelivery).toBe(slack);
  });

  it('turns an agent snapshot into the conversation the builder renders', () => {
    const api = new RallyApi('https://api.rally.test', session);

    const result = api.automationDraftFromAgentSnapshot(agentSnapshot({
      definition: {
        ...readyDraft,
        ready: false,
        followUpQuestion: 'Which blog should I monitor?',
        elicitation: {
          responseType: 'free_text',
          prompt: 'Paste the full blog URL.',
          placeholder: 'https://example.com/blog',
          options: [],
          minimumSelections: 1,
          maximumSelections: null,
          allowOther: false,
        },
      },
      pendingElicitation: {
        id: elicitationId,
        definitionRevision: 2,
        payload: {},
      },
    }));

    // The draft's identity is the automation's own id, which is what
    // makes it the row already sitting in the sidebar.
    expect(result.draft).toMatchObject({
      draftId: automationId,
      assistantMessage: 'Which blog should I monitor?',
      question: {
        id: elicitationId,
        prompt: 'Paste the full blog URL.',
        placeholder: 'https://example.com/blog',
        responseType: 'free_text',
      },
    });
    // A draft still asking a question is not offerable for creation.
    expect(result.draft?.summary).toBeUndefined();
    expect(result.messages).toEqual([
      {
        turnId: turnId,
        transcriptSequence: 1,
        clientMessageId: clientMessageId,
        role: 'user',
        content: 'Check this blog every 24 hours.',
        attachmentIds: [resourceId],
        createdAt: 1_760_000_000_000,
      },
      {
        turnId: assistantTurnId,
        transcriptSequence: 2,
        clientMessageId: null,
        role: 'assistant',
        content: 'Which blog should I monitor?',
        attachmentIds: [],
        createdAt: 1_760_000_000_001,
      },
    ]);
  });

  it('records the snapshot definition so creation can send it back', async () => {
    const api = new RallyApi('https://api.rally.test', session);
    api.automationDraftFromAgentSnapshot(agentSnapshot({}));
    const fetchMock = vi.fn(async () => json(wireAutomationDetail));
    vi.stubGlobal('fetch', fetchMock);

    await api.createAutomation(automationId, [], {}, { scope: 'you' });

    // The agent compares the posted definition against its own and
    // refuses the creation when they differ, so the snapshot read is
    // the only thing that can supply it.
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({
      draftId: automationId,
      draft: readyDraft,
    });
  });

  it('tells the person to restart Rally when a snapshot definition does not match its schema', () => {
    const api = new RallyApi('https://api.rally.test', session);

    // Thrown as an ApiError rather than a raw ZodError: this runs
    // inside the builder's render effect, where an unhandled throw
    // takes the screen down instead of showing the failure.
    expect(() => api.automationDraftFromAgentSnapshot(agentSnapshot({
      definition: { name: 'Missing every other field' },
    }))).toThrowError(expect.objectContaining({
      code: 'invalid_response',
      message: expect.stringContaining('Restarting Rally'),
    }));
  });

  it('carries an automation’s attention reason from the wire to the screen', async () => {
    // The reason is what the screen turns into a sentence. Dropped here it is a
    // status dot with nothing behind it, which is the state this fixed.
    vi.stubGlobal('fetch', vi.fn(async () => json({
      ...wireAutomationDetail,
      status: 'paused',
      attention: 'unsupported_trigger',
    })));
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.getAutomation(automationId)).resolves.toMatchObject({
      status: 'paused',
      attention: 'unsupported_trigger',
    });
  });

  it('tells the person to restart Rally when a plain response does not match its schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [{ notAnAutomation: true }] })));
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.getAutomations()).rejects.toMatchObject({
      code: 'invalid_response',
      message: expect.stringContaining('Restarting Rally'),
    } satisfies Partial<ApiError>);
  });

  it('carries a work stream’s model pin through to the renderer detail', () => {
    // Every realtime snapshot replaces the cached detail through this mapper, so
    // a pin dropped here is a pin that survives the first load and disappears on
    // the next socket update — taking the composer's fallback with it for the
    // work streams whose run recorded no model of its own.
    expect(mapWorkstreamDetail({ ...detail, modelOverride: 'deepseek/deepseek-v4-pro' }))
      .toMatchObject({ modelOverride: 'deepseek/deepseek-v4-pro' });
    expect(mapWorkstreamDetail(detail).modelOverride).toBeUndefined();
  });

  it('maps representative work-stream and resource wire records into renderer models', () => {
    expect(mapWorkstreamDetail(detail)).toMatchObject({
      id: workstreamId,
      origin: 'ad_hoc',
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
  });

  it('preserves a stopped harness status instead of reporting completion', () => {
    expect(mapWorkstreamDetail({ ...detail, harnessStatus: 'stopped' }))
      .toMatchObject({ harnessStatus: 'stopped' });
  });

  it('lists searchable connector resources with an opaque pagination cursor', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return json({ items: [resource], nextCursor: 'cursor-2' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.listResources({ query: 'Launch brief', cursor: 'cursor-1', limit: 20 })).resolves.toEqual({
      items: [expect.objectContaining({ id: resourceId, title: 'Launch brief', provider: 'google_drive' })],
      nextCursor: 'cursor-2',
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

  it('asks for nothing when a work stream has no automation behind it', async () => {
    // `/context` is gone. Its only field was `backgroundTasks`, which rides on
    // the work-stream detail, so the deferred rail now makes no request at all
    // unless there is an automation to describe — and that is a different
    // resource with its own endpoint.
    const workstreamId = '00000000-0000-7000-8000-000000000012';
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.getWorkstreamContext(workstreamId)).resolves.toEqual({
      backgroundTasks: [],
      automationRuns: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces nested service errors with their code and details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      error: {
        code: 'region_mismatch',
        message: 'Use the selected regional service.',
        details: { expected: 'eu' },
      },
    }, { status: 409 })));
    const api = new RallyApi('https://api.rally.test', session);

    const expected: Partial<ApiError> = {
      status: 409,
      code: 'region_mismatch',
      message: 'Use the selected regional service.',
      details: { expected: 'eu' },
    };
    await expect(api.getWorkspace()).rejects.toMatchObject(expected);
  });

  it('accepts successful 204 responses for command endpoints', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.stopHarness(workstreamId)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.rally.test/workstreams/${workstreamId}/stop`,
      expect.objectContaining({ method: 'POST' }),
    );

    await expect(api.archiveNote(noteId)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenLastCalledWith(
      `https://api.rally.test/notes/${noteId}/archive`,
      expect.objectContaining({ method: 'POST' }),
    );
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

  it('uses identity-level onboarding endpoints before a workspace is selected', async () => {
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
      .mockResolvedValueOnce(json({
        runId: '00000000-0000-7000-8000-000000000006',
        workstreamId,
        harnessRunId: '00000000-0000-7000-8000-000000000007',
        reused: true,
      }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.runAutomation('automation-1')).rejects.toMatchObject({ code: 'network_error' });
    expect(reportJavascriptError).toHaveBeenCalledOnce();
    expect(reportJavascriptError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'network_error', status: 0 }),
      'network_error',
    );
    await expect(api.runAutomation('automation-1')).resolves.toMatchObject({ id: workstreamId });

    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/u);
    expect(secondHeaders.get('Idempotency-Key')).toBe(firstHeaders.get('Idempotency-Key'));
  });

  it('renames a work stream through the typed update endpoint', async () => {
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

  it('changes who may read a work stream through the same update endpoint', async () => {
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

  it('archives a work stream through the same update endpoint', async () => {
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

  it('previews and enqueues a generic filtered work-stream batch update', async () => {
    const operationId = '00000000-0000-7000-8000-000000000099';
    const filter = {
      lastActivityAt: {
        atOrAfter: '2026-08-01T00:00:00.000Z',
        before: '2026-08-08T00:00:00.000Z',
      },
      pinned: false,
      includeSystem: false,
    } as const;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ matchedCount: 20 }))
      .mockResolvedValueOnce(json({ operationId, enqueuedCount: 20 }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.previewWorkstreamBatch(filter)).resolves.toBe(20);
    await expect(api.applyWorkstreamBatch(operationId, filter, { kind: 'archive' })).resolves.toBe(20);

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

  it('creates an attachment-only work stream with its draft resource IDs', async () => {
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

  it('given a project launcher, when a work stream is created, then the project is sent to the authorization gate', async () => {
    const projectId = '00000000-0000-7000-8000-0000000000a7';
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      workstream: detail,
      turnId: messageId,
      harnessRunId: null,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await api.createWorkstream({ openingMessage: 'Start', participantIds: [], projectId });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ projectId });
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

  it('acknowledges visible messages and marks a work stream unread through durable read-state endpoints', async () => {
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

    await expect(api.acknowledgeWorkstreamRead(workstreamId, 4, 0)).resolves.toMatchObject({
      readThroughSequenceNumber: 4,
      hasUnread: false,
    });
    await expect(api.markWorkstreamUnread(workstreamId)).resolves.toMatchObject({
      manualUnreadFromSequenceNumber: 4,
      manualUnreadGeneration: 1,
      hasUnread: true,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.rally.test/workstreams/${workstreamId}/read-state`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      readThroughSequenceNumber: 4,
      observedManualUnreadGeneration: 0,
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `https://api.rally.test/workstreams/${workstreamId}/read-state/mark-unread`,
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('updates the personal HyperSight visibility preference', async () => {
    // Reading it has no endpoint any more: the work-stream detail and the
    // control socket's boot frame both carry it. Writing still does.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ visible: true, updatedAt: timestamp }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.updateBlockDashboardPreference(workstreamId, true)).resolves.toEqual({
      visible: true,
      updatedAt: timestamp,
    });

    const preferenceUrl = `https://api.rally.test/workstreams/${workstreamId}/block-dashboard/preference`;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(preferenceUrl);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ visible: true });
  });

  it('uses the template, watch, and detach service contracts without inventing response fields', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ templateId: '00000000-0000-7000-8000-000000000007' }, { status: 201 }))
      .mockResolvedValueOnce(json({ watchEnabled: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.shareAutomation('00000000-0000-7000-8000-000000000008')).resolves.toEqual({
      templateId: '00000000-0000-7000-8000-000000000007',
    });
    await expect(api.setResourceWatch(workstreamId, resourceId, true)).resolves.toEqual({ enabled: true });
    await expect(api.setResourceWatch(workstreamId, resourceId, false)).resolves.toEqual({ enabled: false });
    await expect(api.detachResource(workstreamId, resourceId)).resolves.toBeUndefined();

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.rally.test/automation-templates');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      automationSubscriptionId: '00000000-0000-7000-8000-000000000008',
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`https://api.rally.test/resources/${resourceId}/watch`);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(`workstreamId=${workstreamId}`);
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe(`https://api.rally.test/workstreams/${workstreamId}/resources/${resourceId}`);
  });

  it('previews a template update and adopts only the selected immutable version', async () => {
    const current = {
      id: automationId,
      name: 'Weekly brief',
      emailAddress: 'luminous-tidal-structured-curie@automation.rallywith.ai',
      description: 'A concise weekly status brief.',
      scope: 'personal' as const,
      status: 'active' as const,
      nextRunAt: null,
      lastRunAt: null,
      updatedAt: '2026-08-01T09:00:00.000Z',
      updateAvailable: true,
      templateId,
      templateVersionId: currentVersionId,
      versionNumber: 1,
      overview: 'A concise weekly status brief.',
      instructions: 'Summarize changes.',
      triggers: [{
        type: 'calendar' as const,
        rrule: 'FREQ=WEEKLY;BYDAY=FR',
        timezone: 'America/Los_Angeles',
        summary: 'Every Friday',
      }],
      requiredCapabilities: ['gmail.read'],
      expectedOutputs: ['A concise weekly brief'],
      executionPrincipal: { type: 'user', userId },
      recommendedPlugins: [],
      defaultPluginIds: [],
      templateUpdate: {
        versionId: nextVersionId,
        versionNumber: 2,
        overview: 'A concise weekly brief of changes and decisions.',
        instructions: 'Summarize changes and decisions.',
        triggers: [{
          type: 'calendar' as const,
          rrule: 'FREQ=WEEKLY;BYDAY=MO',
          timezone: 'America/Los_Angeles',
          summary: 'Every Monday',
        }],
        requiredCapabilities: ['gmail.read'],
        expectedOutputs: ['A concise weekly brief'],
        recommendedPlugins: [],
      },
      nextPlannedWorkstream: null,
      recentRuns: [{
        id: '00000000-0000-7000-8000-000000000012',
        automationSubscriptionId: automationId,
        workstreamId,
        triggerType: 'calendar',
        plannedFor: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        status: 'completed' as const,
        resultSummary: null,
        createdAt: timestamp,
      }],
    };
    const adopted = {
      ...current,
      updateAvailable: false,
      templateVersionId: nextVersionId,
      versionNumber: 2,
      instructions: current.templateUpdate.instructions,
      triggers: current.templateUpdate.triggers,
      templateUpdate: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(current))
      .mockResolvedValueOnce(json(adopted));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.getAutomation(automationId)).resolves.toMatchObject({
      emailAddress: 'luminous-tidal-structured-curie@automation.rallywith.ai',
      versionNumber: 1,
      statusMessage: 'Update available',
      templateUpdate: {
        versionId: nextVersionId,
        versionNumber: 2,
        overview: 'A concise weekly brief of changes and decisions.',
        instructions: 'Summarize changes and decisions.',
        triggerSummary: 'Every Monday',
        capabilities: ['gmail.read'],
        expectedOutputs: ['A concise weekly brief'],
        recommendedPlugins: [],
      },
      runs: [expect.objectContaining({ triggerType: 'scheduled' })],
    });
    await expect(api.adoptAutomationUpdate(automationId, nextVersionId)).resolves.toMatchObject({
      versionNumber: 2,
      instructions: 'Summarize changes and decisions.',
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `https://api.rally.test/automation-subscriptions/${automationId}/adopt-version`,
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ versionId: nextVersionId });
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
      'https://api.rally.test/connections/linear/start?telemetryVersion=2',
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
  function stubRoster(): void {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/workspace/members')) {
        return json({ items: [{ user, role: 'owner', status: 'active', joinedAt: timestamp }] });
      }
      // Deliberately unstubbed beyond the roster: resolution reads workspace
      // members and nothing else, so a request for the work stream — which is
      // what used to carry the connections — fails this test loudly.
      throw new Error(`unexpected request: ${url}`);
    }));
  }

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

  it('requests the one workspace-scoped sync and command socket ticket', async () => {
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

  it('requests a WorkstreamDO control socket ticket separately from its substream feed', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return json({
        url: `wss://api.rally.test/socket/workstreams/${workstreamId}?ticket=control-ticket`,
        ticket: 'control-ticket',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://api.rally.test', session);

    await expect(api.getWorkstreamControlSocketTicket(workstreamId)).resolves.toEqual({
      url: `wss://api.rally.test/socket/workstreams/${workstreamId}`,
      ticket: 'control-ticket',
      protocols: socketTicketProtocols('control-ticket'),
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/workstreams/${workstreamId}/control-socket`);
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

    await api.getWorkstream(workstreamId);
    await api.getWorkstream(workstreamId);

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

  it('correlates work-stream detail attempts separately from each request and socket start', async () => {
    const sent: Array<RequestInit | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(init);
      return String(input).endsWith('/control-socket')
        ? json({ url: 'wss://api.rally.test/control', ticket: 'ticket' })
        : json(detail);
    }));
    const api = new RallyApi('https://api.rally.test', session);

    await api.getWorkstream(workstreamId, undefined, 'feed-visible-operation');
    await api.getWorkstreamControlSocketTicket(workstreamId, 'control-start-operation');

    const requestIds = sent.map((init) => new Headers(init?.headers).get('x-request-id'));
    expect(requestIds[0]).toMatch(/^[A-Za-z0-9._:-]{1,100}$/u);
    expect(requestIds[0]).not.toBe('feed-visible-operation');
    expect(requestIds[1]).toBe('control-start-operation');
    expect(sent.map((init) => new Headers(init?.headers).get('x-rally-operation-id'))).toEqual([
      'feed-visible-operation',
      null,
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
    expect(redactQuery('/workstreams/abc/messages')).toBe('/workstreams/abc/messages');
  });
});
