import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvalonApi, mapMessage, mapResource, mapWorkstreamDetail } from './api';
import type { ApiError } from './api';
import type { DesktopSession } from '../../common/desktop';

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
const artifactId = '00000000-0000-7000-8000-000000000012';
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
  objective: 'Find the cause.',
  emailAddress: 'luminous-tidal-structured-curie@automation.with-avalon.com',
  originType: 'ad_hoc' as const,
  originLabel: null,
  createdByUserId: userId,
  automationSubscriptionId: null,
  automationRunId: null,
  plannedFor: null,
  harnessStatus: 'idle' as const,
  lastActivityAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
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
    lastSyncAt: null,
    createdAt: timestamp,
  }],
  artifacts: [],
  backgroundTasks: [],
  openElicitations: [],
  suggestions: [],
  latestHarnessRunId: null,
};

const message = {
  id: messageId,
  clientMessageId: 'client-message-one',
  workspaceId,
  workstreamId,
  author: { type: 'human' as const, user },
  messageType: 'text' as const,
  textContent: `Please ask [@Adam](person:${userId}).`,
  structuredContent: null,
  mentions: [{
    type: 'person' as const,
    userId,
    connectorType: null,
    displayName: 'Adam',
    avatarUrl: 'https://example.com/adam.png',
    startOffset: 11,
    endOffset: 31,
  }],
  attachments: [],
  sequenceNumber: 4,
  createdAt: timestamp,
  editedAt: null,
};

const resource = {
  id: resourceId,
  workspaceId,
  connectionId,
  resourceType: 'document',
  provider: 'google_drive',
  providerResourceId: 'drive-1',
  title: 'Launch brief',
  mimeType: 'application/pdf',
  canonicalUrl: 'https://drive.google.com/file/d/drive-1',
  watchEnabled: false,
  watchStatus: 'unsupported' as const,
  lastHydratedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  contentAvailable: false,
  sizeBytes: 0,
};

const session: DesktopSession = {
  accessToken: 'access-token-longer-than-twenty-characters',
  expiresAt: timestamp,
  apiBaseUrl: 'https://api.example.com',
  user: { id: user.id, email: user.email, name: user.name },
  workspace: { id: workspaceId, name: 'Avalon Studio', region: 'global', role: 'owner' },
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function sse(events: unknown[], splitAt?: number): Response {
  const encoded = new TextEncoder();
  const body = events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (splitAt === undefined) {
        controller.enqueue(encoded.encode(body));
      } else {
        controller.enqueue(encoded.encode(body.slice(0, splitAt)));
        controller.enqueue(encoded.encode(body.slice(splitAt)));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('Avalon API wire adapter', () => {
  it('streams automation assistant tokens and returns the final typed draft', async () => {
    const draft = {
      name: 'Blog monitor',
      description: 'Check a blog for new posts.',
      overview: 'Checks the configured blog every day.',
      instructions: 'Check the configured blog and report new posts.',
      triggers: [{ type: 'interval' as const, intervalSeconds: 86_400, summary: 'Every 24 hours' }],
      requiredCapabilities: [],
      expectedOutputs: ['New post summary'],
      defaultBehavior: {},
      recommendedPlugins: [],
      suggestedScope: 'personal' as const,
      followUpQuestion: 'Which blog should I monitor?',
      elicitation: {
        responseType: 'free_text' as const,
        prompt: 'Paste the full blog URL.',
        placeholder: 'https://example.com/blog',
        options: [],
        minimumSelections: 1,
        maximumSelections: null,
        allowOther: false,
      },
      ready: false,
    };
    const events = [
      { type: 'started' },
      { type: 'delta', delta: 'Which blog ', reset: false },
      { type: 'delta', delta: 'should I monitor?', reset: false },
      { type: 'completed', draft, assistantMessage: 'Which blog should I monitor?' },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return sse(events, 47);
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);
    const streamed: unknown[] = [];

    await expect(api.compileAutomation(
      { message: 'Check this blog every 24 hours.' },
      (event) => streamed.push(event),
    )).resolves.toMatchObject({
      assistantMessage: 'Which blog should I monitor?',
      question: {
        prompt: 'Paste the full blog URL.',
        placeholder: 'https://example.com/blog',
      },
    });

    expect(streamed).toEqual(events.slice(0, 3));
    const request = fetchMock.mock.calls[0]!;
    expect(String(request[0])).toBe('https://api.avalon.test/automations/draft/stream');
    expect(new Headers(request[1]?.headers).get('Accept')).toBe('text/event-stream');
  });

  it('maps representative work-stream and message wire records into renderer models', () => {
    expect(mapWorkstreamDetail(detail)).toMatchObject({
      id: workstreamId,
      origin: 'ad_hoc',
      emailAddress: 'luminous-tidal-structured-curie@automation.with-avalon.com',
      harnessStatus: 'completed',
      participants: [{ id: userId, role: 'creator' }],
      viewers: [{ id: userId, viewing: true }],
      connections: [{ id: connectionId, scope: 'you', status: 'reconnect_required' }],
    });
    expect(mapMessage(message)).toMatchObject({
      id: messageId,
      clientMessageId: 'client-message-one',
      authorType: 'human',
      author: { id: userId, name: 'Adam' },
      text: `Please ask [@Adam](person:${userId}).`,
      mentions: [{
        type: 'person',
        personId: userId,
        displayName: 'Adam',
        avatarUrl: 'https://example.com/adam.png',
        startOffset: 11,
        endOffset: 31,
      }],
      sequenceNumber: 4,
    });
    expect(mapResource(resource)).toMatchObject({
      id: resourceId,
      watchEnabled: false,
      watchStatus: 'unsupported',
    });
  });

  it('lists searchable connector resources with an opaque pagination cursor', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return json({ items: [resource], nextCursor: 'cursor-2' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.listResources({ query: 'Launch brief', cursor: 'cursor-1', limit: 20 })).resolves.toEqual({
      items: [expect.objectContaining({ id: resourceId, title: 'Launch brief', provider: 'google_drive' })],
      nextCursor: 'cursor-2',
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.avalon.test/resources?limit=20&q=Launch+brief&cursor=cursor-1',
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

  it('maps a persisted tool message back into the same inline block used by realtime', () => {
    expect(mapMessage({
      ...message,
      id: taskId,
      author: { type: 'agent' as const },
      messageType: 'tool' as const,
      textContent: '',
      structuredContent: {
        invocation: {
          id: taskId,
          harnessRunId: messageId,
          toolCallId: 'turn-1-tool-1',
          toolName: 'Search evidence',
          connectionId: null,
          status: 'completed',
          inputSummary: '{"query":"invoice failures"}',
          outputSummary: 'Found the relevant failures.',
          startedAt: '2026-08-01T12:00:01.000Z',
          completedAt: '2026-08-01T12:00:04.000Z',
          error: null,
        },
      },
      sequenceNumber: 5,
    })).toMatchObject({
      id: taskId,
      authorType: 'agent',
      messageType: 'tool_event',
      sequenceNumber: 5,
      toolEvent: {
        id: taskId,
        name: 'Search evidence',
        status: 'completed',
        summary: 'Found the relevant failures.',
        durationMs: 3_000,
      },
    });
  });

  it('gives the durable elicitation answer the same identity as its realtime question', () => {
    expect(mapMessage({
      ...message,
      id: 'durable-elicitation-answer-message',
      clientMessageId: `elicitation-response:${taskId}`,
      author: { type: 'human' as const, user },
      messageType: 'elicitation' as const,
      textContent: '',
      structuredContent: {
        kind: 'elicitation_response',
        elicitation: {
          id: taskId,
          workstreamId,
          harnessRunId: messageId,
          prompt: 'Choose one',
          responseType: 'single_select',
          options: [{ label: 'Foo', value: 'foo', description: null }],
          minimumSelections: 1,
          maximumSelections: 1,
          targetUserId: null,
          status: 'answered',
          answer: 'foo',
          answeredByUserId: userId,
          createdAt: timestamp,
          answeredAt: timestamp,
        },
      },
    })).toMatchObject({
      id: `elicitation-${taskId}`,
      messageType: 'elicitation',
      elicitation: { id: taskId, status: 'answered', answer: 'foo' },
    });
  });

  it('maps persisted artifacts and background activity into the durable rail model', () => {
    expect(mapWorkstreamDetail({
      ...detail,
      artifacts: [{
        id: artifactId,
        workspaceId,
        workstreamId,
        harnessRunId: messageId,
        artifactType: 'markdown',
        title: 'Launch brief.md',
        previewText: '# Launch brief',
        status: 'complete',
        mimeType: 'text/markdown; charset=utf-8',
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
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
        transcriptMessageId: messageId,
      }],
    })).toMatchObject({
      artifacts: [{ id: artifactId, title: 'Launch brief.md', status: 'complete' }],
      backgroundTasks: [{ id: taskId, type: 'agent', durationMs: 12_000, tokenCount: 1_250, toolUses: 3 }],
    });
  });

  it('loads durable rail context from the deferred work-stream endpoint', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return json({
        artifacts: [{
          id: artifactId,
          workspaceId,
          workstreamId,
          harnessRunId: messageId,
          artifactType: 'markdown',
          title: 'Launch brief.md',
          previewText: '# Launch brief',
          status: 'complete',
          mimeType: 'text/markdown; charset=utf-8',
          createdAt: timestamp,
          updatedAt: timestamp,
        }],
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
          transcriptMessageId: messageId,
        }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.getWorkstreamContext(workstreamId)).resolves.toMatchObject({
      artifacts: [{ id: artifactId, title: 'Launch brief.md' }],
      backgroundTasks: [{ id: taskId, type: 'agent', durationMs: 12_000 }],
      automationRuns: [],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://api.avalon.test/workstreams/${workstreamId}/context`);
  });

  it('surfaces nested service errors with their code and details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      error: {
        code: 'region_mismatch',
        message: 'Use the selected regional service.',
        details: { expected: 'eu' },
      },
    }, { status: 409 })));
    const api = new AvalonApi('https://api.avalon.test', session);

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
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.stopHarness(workstreamId)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.avalon.test/workstreams/${workstreamId}/stop`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('downloads an authenticated persisted artifact with its safe server filename', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response('# Launch brief', {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="Launch brief.md"; filename*=UTF-8''Launch%20brief.md`,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);

    const result = await api.downloadArtifact(workstreamId, artifactId);

    expect(result.fileName).toBe('Launch brief.md');
    await expect(result.blob.text()).resolves.toBe('# Launch brief');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.avalon.test/workstreams/${workstreamId}/artifacts/${artifactId}/content`,
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${session.accessToken}`);
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
      workspaceName: 'Avalon Studio',
      region: 'global' as const,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
    const inviteUrl = 'https://with-avalon.com/invite/#region=global&token=private-token-value-long-enough';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json({ invitation, inviteUrl, emailDelivery: 'sent' }, { status: 201 }))
      .mockResolvedValueOnce(json({ items: [invitation] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.getInvitationPreview('private-token-value-long-enough')).resolves.toEqual(preview);
    await expect(api.createWorkspaceInvitation(invitation.email, 'member')).resolves.toEqual({ invitation, inviteUrl, emailDelivery: 'sent' });
    await expect(api.getWorkspaceInvitations()).resolves.toEqual([invitation]);
    await expect(api.revokeWorkspaceInvitation(invitation.id)).resolves.toBeUndefined();

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/auth/invitations/preview?token=private-token-value-long-enough');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ email: invitation.email, role: 'member' });
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: 'DELETE' });

    const login = new URL(await api.beginGoogleLogin('global', 'avalon://auth/complete', {
      invitationToken: 'private-token-value-long-enough',
      authAttempt: { attemptId: 'a'.repeat(43), codeChallenge: 'c'.repeat(43) },
    }));
    expect(login.origin).toBe('https://accounts.google.com');
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({
      invitationToken: 'private-token-value-long-enough',
      region: 'global',
      returnUri: 'avalon://auth/complete',
      desktopAttemptId: 'a'.repeat(43),
      desktopCodeChallenge: 'c'.repeat(43),
    });
  });

  it('uses identity-level onboarding endpoints before a workspace is selected', async () => {
    const identitySession: DesktopSession = { ...session, workspace: null };
    const pending = {
      id: '00000000-0000-7000-8000-000000000009',
      workspaceId,
      workspaceName: 'Avalon Studio',
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
    const api = new AvalonApi('https://api.avalon.test', identitySession);

    await expect(api.getWorkspaceOnboarding()).resolves.toEqual({ invitations: [pending] });
    await expect(api.createWorkspace('Acme Research')).resolves.toBeUndefined();
    await expect(api.acceptPendingWorkspaceInvitation(pending.id)).resolves.toBeUndefined();
    await expect(api.declinePendingWorkspaceInvitation(pending.id)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.map((call) => [String(call[0]), call[1]?.method])).toEqual([
      ['https://api.avalon.test/onboarding', 'GET'],
      ['https://api.avalon.test/onboarding/workspace', 'POST'],
      [`https://api.avalon.test/onboarding/invitations/${pending.id}/accept`, 'POST'],
      [`https://api.avalon.test/onboarding/invitations/${pending.id}`, 'DELETE'],
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
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.runAutomation('automation-1')).rejects.toMatchObject({ code: 'network_error' });
    await expect(api.runAutomation('automation-1')).resolves.toMatchObject({ id: workstreamId });

    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/u);
    expect(secondHeaders.get('Idempotency-Key')).toBe(firstHeaders.get('Idempotency-Key'));
  });

  it('uses the template, watch, and detach service contracts without inventing response fields', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ templateId: '00000000-0000-7000-8000-000000000007' }, { status: 201 }))
      .mockResolvedValueOnce(json({ watchEnabled: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.shareAutomation('00000000-0000-7000-8000-000000000008')).resolves.toEqual({
      templateId: '00000000-0000-7000-8000-000000000007',
    });
    await expect(api.setResourceWatch(workstreamId, resourceId, true)).resolves.toEqual({ enabled: true });
    await expect(api.setResourceWatch(workstreamId, resourceId, false)).resolves.toEqual({ enabled: false });
    await expect(api.detachResource(workstreamId, resourceId)).resolves.toBeUndefined();

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.avalon.test/automation-templates');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      automationSubscriptionId: '00000000-0000-7000-8000-000000000008',
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`https://api.avalon.test/resources/${resourceId}/watch`);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(`workstreamId=${workstreamId}`);
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe(`https://api.avalon.test/workstreams/${workstreamId}/resources/${resourceId}`);
  });

  it('previews a template update and adopts only the selected immutable version', async () => {
    const current = {
      id: automationId,
      name: 'Weekly brief',
      emailAddress: 'luminous-tidal-structured-curie@automation.with-avalon.com',
      description: 'A concise weekly status brief.',
      scope: 'personal' as const,
      status: 'active' as const,
      nextRunAt: null,
      lastRunAt: null,
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
      recentRuns: [],
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
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.getAutomation(automationId)).resolves.toMatchObject({
      emailAddress: 'luminous-tidal-structured-curie@automation.with-avalon.com',
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
    });
    await expect(api.adoptAutomationUpdate(automationId, nextVersionId)).resolves.toMatchObject({
      versionNumber: 2,
      instructions: 'Summarize changes and decisions.',
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `https://api.avalon.test/automation-subscriptions/${automationId}/adopt-version`,
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ versionId: nextVersionId });
  });

  it('loads one transcript page at a time and exposes the earlier-page cursor', async () => {
    const older = {
      ...message,
      id: '00000000-0000-7000-8000-000000000009',
      sequenceNumber: 3,
      textContent: 'Earlier context.',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/messages?') && url.includes('before=4')) return json({ items: [older], nextCursor: null });
      if (url.includes('/messages?')) return json({ items: [message], nextCursor: '4' });
      return json({ error: { message: 'Unexpected request' } }, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);

    const newest = await api.getMessagePage(workstreamId);
    const earlier = await api.getMessagePage(workstreamId, newest.nextCursor ?? undefined);

    expect(newest.items.map((item) => item.sequenceNumber)).toEqual([4]);
    expect(newest.nextCursor).toBe('4');
    expect(earlier.items.map((item) => item.sequenceNumber)).toEqual([3]);
    expect(earlier.nextCursor).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('before=4'))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(`/workstreams/${workstreamId}`))).toBe(false);
  });
});
