import { socketTicketProtocols } from '@avalon/contracts/socket-tickets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvalonApi, mapMessage, mapResource, mapWorkstreamDetail, messagesWithTransientBlocks, redactQuery } from './api';
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
  emailAddress: 'luminous-tidal-structured-curie@automation.with-avalon.com',
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

afterEach(() => {
  vi.unstubAllGlobals();
  reportJavascriptError.mockReset();
  reportTelemetryProductIntent.mockReset();
});

describe('Avalon API wire adapter', () => {
  it.each([
    [['email'], true, false],
    [['slack_agent_dm'], false, true],
    [['email', 'slack_agent_dm'], true, true],
    [[], false, false],
  ])('carries the compiler\'s own %j through to the destination choices', async (requested, email, slack) => {
    const draft = {
      name: 'Morning briefing',
      description: 'Summarizes the morning.',
      overview: 'Runs every morning.',
      instructions: 'Write the briefing.',
      triggers: [{ type: 'interval' as const, intervalSeconds: 86_400, summary: 'Every 24 hours' }],
      requiredCapabilities: [],
      // Deliberately prose that a regex would read as a delivery request: the
      // point of the structured field is that this no longer decides anything.
      expectedOutputs: ['A ranked list of your five most important emails'],
      requestedDelivery: requested,
      defaultBehavior: {},
      recommendedPlugins: [],
      suggestedScope: 'personal' as const,
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    };
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      { type: 'completed', draftId: '00000000-0000-7000-8000-000000000042', draft, assistantMessage: 'Ready.' },
    ], 47)));
    const api = new AvalonApi('https://api.avalon.test', session);

    const result = await api.compileAutomation({ message: 'Brief me.' });

    expect(result.summary?.requiresEmailDelivery).toBe(email);
    expect(result.summary?.requiresSlackDelivery).toBe(slack);
  });

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
      {
        type: 'thinking',
        inferenceRequestId: 'inference-1',
        status: 'started',
        durationMs: 0,
      },
      {
        type: 'thinking',
        inferenceRequestId: 'inference-1',
        status: 'completed',
        durationMs: 1_234,
      },
      {
        type: 'tool',
        toolCallId: 'tool-1',
        name: 'Reviewing connected tools',
        summary: 'Checking the authorized plugin catalog…',
        status: 'started',
        plugin: { pluginId: 'plugin_github', displayName: 'GitHub', icon: 'brand-github' },
      },
      {
        type: 'tool',
        toolCallId: 'tool-1',
        name: 'Reviewing connected tools',
        summary: 'Reviewed the authorized plugin catalog',
        status: 'completed',
        plugin: { pluginId: 'plugin_github', displayName: 'GitHub', icon: 'brand-github' },
        durationMs: 42,
      },
      { type: 'delta', delta: 'Which blog ', reset: false },
      { type: 'delta', delta: 'should I monitor?', reset: false },
      { type: 'completed', draftId: '00000000-0000-7000-8000-000000000042', draft, assistantMessage: 'Which blog should I monitor?' },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return sse(events, 47);
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);
    const streamed: unknown[] = [];

    const result = await api.compileAutomation(
      { message: 'Check this blog every 24 hours.', attachmentIds: [resourceId] },
      (event) => streamed.push(event),
    );
    // The draft's identity comes back from the API, which is what makes it the
    // id of the draft automation now sitting in the sidebar.
    expect(result).toMatchObject({
      draftId: '00000000-0000-7000-8000-000000000042',
      assistantMessage: 'Which blog should I monitor?',
      question: {
        prompt: 'Paste the full blog URL.',
        placeholder: 'https://example.com/blog',
      },
    });

    expect(streamed).toEqual(events.slice(0, -1));
    const request = fetchMock.mock.calls[0]!;
    expect(String(request[0])).toBe('https://api.avalon.test/automations/draft/stream');
    expect(new Headers(request[1]?.headers).get('Accept')).toBe('text/event-stream');
    const opening = JSON.parse(String(request[1]?.body));
    expect(opening).toMatchObject({
      messages: [{ role: 'user', content: 'Check this blog every 24 hours.' }],
      currentDraft: null,
      attachmentIds: [resourceId],
    });
    expect(opening).not.toHaveProperty('draftId');

    await api.compileAutomation({ message: 'Only report meaningful changes.', draftId: result.draftId });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      draftId: '00000000-0000-7000-8000-000000000042',
      attachmentIds: [resourceId],
      messages: [
        { role: 'user', content: 'Check this blog every 24 hours.' },
        { role: 'assistant', content: 'Which blog should I monitor?' },
        { role: 'user', content: 'Only report meaningful changes.' },
      ],
    });
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

  it('preserves a stopped harness status instead of reporting completion', () => {
    expect(mapWorkstreamDetail({ ...detail, harnessStatus: 'stopped' }))
      .toMatchObject({ harnessStatus: 'stopped' });
  });

  it('preserves externally attributed Slack actors in renderer messages', () => {
    expect(mapMessage({
      ...message,
      author: {
        type: 'external' as const,
        actor: {
          provider: 'slack',
          providerAccountId: 'T123',
          providerUserId: 'U456',
          displayName: 'Taylor',
          avatarUrl: 'https://example.com/taylor.png',
        },
      },
      textContent: 'Investigate this incident',
    })).toMatchObject({
      authorType: 'external',
      externalActor: {
        provider: 'slack',
        providerAccountId: 'T123',
        providerUserId: 'U456',
        displayName: 'Taylor',
      },
      text: 'Investigate this incident',
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

  it('carries the owning connector onto a work-stream tool row', () => {
    const mapped = mapMessage({
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
          toolName: 'google_2_drive_search',
          activityName: 'Reviewed Google Drive · Work',
          connectionId,
          plugin: { pluginId: 'plugin_google_2', displayName: 'Google Drive · Work', icon: 'brand-google-drive' },
          status: 'completed',
          inputSummary: '{"query":"avalon"}',
          outputSummary: 'Found the authorized Drive folder.',
          startedAt: '2026-08-01T12:00:01.000Z',
          completedAt: '2026-08-01T12:00:04.000Z',
          error: null,
        },
      },
      sequenceNumber: 6,
    });

    expect(mapped.toolEvent?.plugin).toEqual({
      pluginId: 'plugin_google_2',
      displayName: 'Google Drive · Work',
      icon: 'brand-google-drive',
    });
    expect(mapped.toolEvent?.name).toBe('Reviewed Google Drive · Work');
  });

  it('leaves a work-stream tool row from an Avalon-owned tool unattributed', () => {
    const mapped = mapMessage({
      ...message,
      id: taskId,
      author: { type: 'agent' as const },
      messageType: 'tool' as const,
      textContent: '',
      structuredContent: {
        invocation: {
          id: taskId,
          harnessRunId: messageId,
          toolCallId: 'turn-1-tool-2',
          toolName: 'web_search',
          activityName: 'Searched the public web',
          connectionId: null,
          plugin: null,
          status: 'completed',
          inputSummary: '{"query":"azure models"}',
          outputSummary: 'Found eight results.',
          startedAt: '2026-08-01T12:00:01.000Z',
          completedAt: '2026-08-01T12:00:04.000Z',
          error: null,
        },
      },
      sequenceNumber: 7,
    });

    expect(mapped.toolEvent?.plugin).toBeUndefined();
    expect(mapped.toolEvent?.name).toBe('Searched the public web');
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

  it('replaces a durable open elicitation message with its answered response regardless of order', () => {
    const elicitation = {
      id: taskId,
      workstreamId,
      harnessRunId: messageId,
      prompt: 'Choose one',
      responseType: 'single_select' as const,
      options: [{ label: 'Foo', value: 'foo', description: null }],
      minimumSelections: 1,
      maximumSelections: 1,
      targetUserId: null,
      answeredByUserId: null,
      createdAt: timestamp,
      answeredAt: null,
    };
    const openQuestion = mapMessage({
      ...message,
      id: taskId,
      clientMessageId: `elicitation:${taskId}`,
      author: { type: 'agent' as const },
      messageType: 'elicitation' as const,
      textContent: '',
      structuredContent: {
        kind: 'elicitation',
        elicitation: { ...elicitation, status: 'open' as const, answer: null },
      },
      mentions: [],
      sequenceNumber: 4,
    });
    const answeredResponse = mapMessage({
      ...message,
      id: 'durable-elicitation-answer-message',
      clientMessageId: `elicitation-response:${taskId}`,
      author: { type: 'human' as const, user },
      messageType: 'elicitation' as const,
      textContent: '',
      structuredContent: {
        kind: 'elicitation_response',
        elicitation: {
          ...elicitation,
          status: 'answered' as const,
          answer: 'foo',
          answeredByUserId: userId,
          answeredAt: timestamp,
        },
      },
      mentions: [],
      sequenceNumber: 5,
    });

    expect(messagesWithTransientBlocks(
      [openQuestion, answeredResponse],
      mapWorkstreamDetail(detail),
    )).toEqual([answeredResponse]);
    expect(messagesWithTransientBlocks(
      [answeredResponse, openQuestion],
      mapWorkstreamDetail(detail),
    )).toEqual([answeredResponse]);
  });

  it('omits activity suggestions from rebuilt transcripts while the surface is paused', () => {
    const suggestion = {
      id: taskId,
      activityId: resourceId,
      workstreamId,
      title: 'A noisy context suggestion',
      summary: 'This should not be shown in the work stream.',
      confidence: 0.95,
      reason: 'The classifier guessed this belonged here.',
      status: 'pending' as const,
      createdAt: timestamp,
      resolvedAt: null,
    };
    const mappedDetail = mapWorkstreamDetail({ ...detail, suggestions: [suggestion] });
    const legacySuggestion = mapMessage({
      ...message,
      id: taskId,
      author: { type: 'system' as const },
      messageType: 'suggestion' as const,
      textContent: '',
      structuredContent: { suggestion },
      mentions: [],
      sequenceNumber: 5,
    });

    expect(messagesWithTransientBlocks([legacySuggestion], mappedDetail)).toEqual([]);
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
        transcriptMessageId: messageId,
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
    const api = new AvalonApi('https://api.avalon.test', session);

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

    await expect(api.archiveNote(noteId)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenLastCalledWith(
      `https://api.avalon.test/notes/${noteId}/archive`,
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
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.renameWorkstream(workstreamId, 'Launch planning')).resolves.toMatchObject({
      id: workstreamId,
      title: 'Launch planning',
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://api.avalon.test/workstreams/${workstreamId}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ title: 'Launch planning' });
  });

  it('changes who may read a work stream through the same update endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ ...detail, scope: 'personal' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.setWorkstreamScope(workstreamId, 'personal')).resolves.toMatchObject({
      id: workstreamId,
      scope: 'personal',
    });

    // Only the scope travels: a PATCH that also resubmitted the description
    // would be read as somebody having authored it.
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ scope: 'personal' });
  });

  it('creates an attachment-only work stream with its draft resource IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      workstream: detail,
      messageId,
      harnessRunId: null,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.createWorkstream({
      openingMessage: '',
      participantIds: [],
      attachmentIds: [resourceId],
    })).resolves.toMatchObject({ messageId, workstream: { id: workstreamId } });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      openingMessage: '',
      participantUserIds: [],
      clientMessageId: expect.any(String),
      attachmentIds: [resourceId],
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
    const api = new AvalonApi('https://api.avalon.test', session);

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
      `https://api.avalon.test/workstreams/${workstreamId}/read-state`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      readThroughSequenceNumber: 4,
      observedManualUnreadGeneration: 0,
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `https://api.avalon.test/workstreams/${workstreamId}/read-state/mark-unread`,
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('updates the personal HyperSight visibility preference', async () => {
    // Reading it has no endpoint any more: the work-stream detail and the
    // control socket's boot frame both carry it. Writing still does.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ visible: true, updatedAt: timestamp }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.updateBlockDashboardPreference(workstreamId, true)).resolves.toEqual({
      visible: true,
      updatedAt: timestamp,
    });

    const preferenceUrl = `https://api.avalon.test/workstreams/${workstreamId}/block-dashboard/preference`;
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

  it('loads transcript pages before, after, and around a sequence cursor', async () => {
    const older = {
      ...message,
      id: '00000000-0000-7000-8000-000000000009',
      sequenceNumber: 3,
      textContent: 'Earlier context.',
    };
    const dismissedSuggestion = {
      ...message,
      id: noteId,
      author: { type: 'system' as const },
      messageType: 'suggestion' as const,
      textContent: '',
      structuredContent: {
        suggestion: {
          id: taskId,
          activityId: resourceId,
          workstreamId,
          title: 'Review the launch plan',
          summary: 'The launch plan changed.',
          confidence: 0.93,
          reason: 'It matches the work stream objective.',
          status: 'dismissed' as const,
          createdAt: timestamp,
          resolvedAt: timestamp,
        },
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/messages?') && url.includes('before=4')) {
        return json({ items: [older, dismissedSuggestion], nextCursor: null });
      }
      if (url.includes('/messages?') && url.includes('around=4')) {
        return json({ items: [older, message], nextCursor: '3', newerCursor: '4' });
      }
      if (url.includes('/messages?') && url.includes('after=4')) {
        return json({ items: [], nextCursor: null, newerCursor: null });
      }
      if (url.includes('/messages?')) return json({ items: [message], nextCursor: '4' });
      return json({ error: { message: 'Unexpected request' } }, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);

    const newest = await api.getMessagePage(workstreamId);
    const earlier = await api.getMessagePage(workstreamId, { before: newest.nextCursor ?? undefined });
    const anchored = await api.getMessagePage(workstreamId, { around: 4 });
    const newer = await api.getMessagePage(workstreamId, { after: anchored.newerCursor ?? undefined });

    expect(newest.items.map((item) => item.sequenceNumber)).toEqual([4]);
    expect(newest.nextCursor).toBe('4');
    expect(earlier.items.map((item) => item.sequenceNumber)).toEqual([3]);
    expect(earlier.nextCursor).toBeNull();
    expect(anchored.items.map((item) => item.sequenceNumber)).toEqual([3, 4]);
    expect(anchored.newerCursor).toBe('4');
    expect(newer.items).toEqual([]);
    expect(newer.newerCursor).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('before=4'))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('around=4'))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('after=4'))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(`/workstreams/${workstreamId}`))).toBe(false);
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
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.startProviderConnection('linear', 'you', ['linear.read'])).resolves.toEqual({
      url: 'https://linear.app/oauth/authorize?state=opaque',
      attemptId,
    });
    const startHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.avalon.test/connections/linear/start?telemetryVersion=2',
    );
    expect(startHeaders.get('X-Avalon-Operation-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(startHeaders.has('X-Avalon-Telemetry-Version')).toBe(false);
    expect(reportTelemetryProductIntent).toHaveBeenCalledOnce();
    expect(reportTelemetryProductIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'connector_setup_requested_v2', connector: 'linear', scope: 'personal',
      method: 'oauth', capabilityCount: 'one', operationId: startHeaders.get('X-Avalon-Operation-Id'),
    }));
    await expect(api.getConnectorOAuthAttempt(attemptId)).resolves.toMatchObject({
      status: 'succeeded',
      connectionId,
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `https://api.avalon.test/connections/oauth-attempts/${attemptId}`,
    );
  });

});

describe('socket ticket transport', () => {
  it('drops the query ticket the endpoint still returns and offers it as a subprotocol', async () => {
    // The server keeps `?ticket=` in the URL for desktop builds released before
    // the subprotocol scheme. Nothing here may open a socket with it, because
    // Cloudflare records request URLs into stores this app cannot redact.
    vi.stubGlobal('fetch', vi.fn(async () => json({
      url: `wss://api.avalon.test/socket/workstreams/${workstreamId}?ticket=socket-ticket`,
      ticket: 'socket-ticket',
    })));
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.getSocketTicket(workstreamId)).resolves.toEqual({
      url: `wss://api.avalon.test/socket/workstreams/${workstreamId}`,
      ticket: 'socket-ticket',
      protocols: socketTicketProtocols('socket-ticket'),
    });
  });

  it('requests the one workspace-scoped sync and command socket ticket', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return json({
        url: 'wss://api.avalon.test/socket/workspaces/workspace-1?ticket=workspace-ticket',
        ticket: 'workspace-ticket',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.getWorkspaceSocketTicket()).resolves.toEqual({
      url: 'wss://api.avalon.test/socket/workspaces/workspace-1',
      ticket: 'workspace-ticket',
      protocols: socketTicketProtocols('workspace-ticket'),
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/workspace/socket');
  });

  it('requests a WorkstreamDO control socket ticket separately from its substream feed', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return json({
        url: `wss://api.avalon.test/socket/workstreams/${workstreamId}?ticket=control-ticket`,
        ticket: 'control-ticket',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);

    await expect(api.getWorkstreamControlSocketTicket(workstreamId)).resolves.toEqual({
      url: `wss://api.avalon.test/socket/workstreams/${workstreamId}`,
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
    const api = new AvalonApi('https://api.avalon.test', session);

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
      return json({ workstream: detail, messageId, harnessRunId: null });
    }));
    const api = new AvalonApi('https://api.avalon.test', session);

    await api.createWorkstream({
      openingMessage: 'Prepare the launch brief',
      participantIds: [],
      requestId: 'trace-from-the-screen',
    });

    expect(new Headers(sent[0]?.headers).get('x-request-id')).toBe('trace-from-the-screen');
  });
});

describe('expired access-token recovery', () => {
  const renewed: DesktopSession = { ...session, accessToken: 'renewed-access-token-longer-than-twenty' };
  // What the endpoint sends, and what the client hands back after stripping the
  // query ticket and attaching the handshake subprotocols. Keeping them
  // separate stops the fixture from implying the server sends `protocols`.
  const wireTicket = { url: 'wss://api.avalon.test/socket', ticket: 'socket-ticket' };
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
    const api = new AvalonApi('https://api.avalon.test', session);
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
    const api = new AvalonApi('https://api.avalon.test', session);
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
    const api = new AvalonApi('https://api.avalon.test', session);

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
    const api = new AvalonApi('https://api.avalon.test', session);
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
      const api = new AvalonApi('https://api.avalon.test', session);
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
    const api = new AvalonApi('https://api.avalon.test', session);
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
    const api = new AvalonApi('https://api.avalon.test', session);
    api.setCredentialRenewal(vi.fn().mockResolvedValue(renewed));
    // Sign-out lands between the request and its rejection.
    void Promise.resolve().then(() => api.setSession(null));

    await expect(api.getSocketTicket(workstreamId)).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry when renewal fails', async () => {
    const fetchMock = unauthorizedUntilRenewed();
    vi.stubGlobal('fetch', fetchMock);
    const api = new AvalonApi('https://api.avalon.test', session);
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
    const api = new AvalonApi('https://api.avalon.test', session);
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
    const api = new AvalonApi('https://api.avalon.test', session);

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
    const api = new AvalonApi('https://api.avalon.test', session);
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
