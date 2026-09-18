import { asWorkspaceId } from '@rally/contracts';
import { describe, expect, it } from 'vitest';
import {
  createFirefliesConnector,
  FirefliesCapabilities,
  FirefliesEventTypes,
  verifyFirefliesSignature,
} from './fireflies';
import { ConnectorRegistry } from './index';
import { authorizedConnection, connectorConnectableScopes, connectorScopeIsConnectable, ConnectorError, type ConnectorConnectionContext } from './types';
import { neverAborts } from './test-signals';

const workspaceId = asWorkspaceId('44444444-4444-4444-8444-444444444444');
const redirectUri = 'https://api.example.test/connections/fireflies/callback';
// Low entropy on purpose: the repository's secret scan reads every branch, and a
// realistic-looking fixture fails that gate for every open pull request.
const signingSecret = 'ssssssssssssssssssssssssssssssss';
const apiKey = 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk';

function connection(scope: 'personal' | 'workspace' = 'workspace') {
  return authorizedConnection({
    id: '55555555-5555-4555-8555-555555555555',
    workspaceId,
    scope,
    ownerUserId: scope === 'personal' ? '66666666-6666-4666-8666-666666666666' : null,
    grantedScopes: [scope === 'personal' ? FirefliesCapabilities.personalRead : FirefliesCapabilities.workspaceRead],
    credentials: scope === 'personal' ? { accessToken: 'test-access-token' } : { apiKey },
    config: { region: 'global' },
    cursor: {},
  } satisfies ConnectorConnectionContext);
}

const principal = { type: 'workspace' as const, workspaceId };

async function signature(body: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function graphqlFetch(reply: (variables: Record<string, unknown>, document: string) => unknown) {
  const documents: string[] = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url instanceof Request ? url.url : url)).toBe('https://api.fireflies.ai/graphql');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${apiKey}`);
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    documents.push(body.query);
    return Response.json(reply(body.variables, body.query));
  };
  return { fetcher, documents };
}

function meetingFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'meeting-1',
    title: 'Acme renewal call',
    dateString: '2026-08-12T15:00:00.000Z',
    date: 1_786_000_000_000,
    duration: 42,
    host_email: 'bob@acme.test',
    organizer_email: 'bob@acme.test',
    participants: ['bob@acme.test', 'dana@customer.test'],
    transcript_url: 'https://app.fireflies.ai/view/meeting-1',
    meeting_info: { summary_status: 'processed', silent_meeting: false },
    ...overrides,
  };
}

describe('Fireflies protocol', () => {
  it('declares two scopes, three read tools, and every registration operation as manual or unsupported', () => {
    const adapter = new ConnectorRegistry([createFirefliesConnector({ redirectUri })]).get('fireflies');
    expect(adapter.manifest.supportedScopes).toEqual(['personal', 'workspace']);
    expect(adapter.manifest.tools.map((tool) => tool.name)).toEqual(['search_meetings', 'get_meeting_summary', 'get_transcript']);
    expect(adapter.manifest.tools.every((tool) => tool.mode === 'read' && tool.idempotency === 'safe' && tool.timeoutMs === 30_000)).toBe(true);
    expect(adapter.manifest.supportsPolling).toBe(false);
    expect(adapter.manifest.supportsWatches).toBe(false);
    expect(adapter.manifest.supportsWebhooks).toBe(true);
    expect(adapter.manifest.activityTypes).toEqual([...FirefliesEventTypes].reverse());
    expect(adapter.installationManagement?.support).toEqual({
      create: 'manual', inspect: 'unsupported', update: 'manual',
      remove: 'manual', rotate: 'manual', reconcileCreate: 'unsupported',
    });
    expect(adapter.installationManagement?.grouping).toBe('grouped');
    expect(adapter.installationManagement?.signingSecretSource).toBe('host');
    expect(adapter.installationManagement?.canUpdateDestination).toBe(false);
    expect(adapter.dynamicAgentTools?.connectionScopes).toEqual(['personal']);
    expect(adapter.capabilityConnectionScopes).toEqual({
      'fireflies.workspace.read': ['workspace'],
      'fireflies.personal.read': ['personal'],
    });
  });

  it('still serves a workspace connection but connects no new one', () => {
    const adapter = new ConnectorRegistry([createFirefliesConnector({ redirectUri })]).get('fireflies');
    // The two answer different questions on purpose. One administrator's key
    // is every member's read of every meeting it can see, so no new workspace
    // connection is made; the connections a workspace already made keep their
    // tools and their webhook ingress rather than failing closed.
    expect(connectorConnectableScopes(adapter)).toEqual(['personal']);
    expect(connectorScopeIsConnectable(adapter, 'workspace')).toBe(false);
    expect(connectorScopeIsConnectable(adapter, 'personal')).toBe(true);
    expect(adapter.manifest.supportedScopes).toContain('workspace');
  });

  it('digests the summary and keeps the transcript event operational', () => {
    const adapter = new ConnectorRegistry([createFirefliesConnector({ redirectUri })]).get('fireflies');
    const triggers = Object.fromEntries(adapter.manifest.activityTriggers.map((trigger) => [trigger.eventType, trigger.digestible]));
    expect(triggers).toEqual({ 'meeting.summarized': true, 'meeting.transcribed': false });
  });

  it('refuses every registration operation with the instruction the administrator has to follow', async () => {
    const management = createFirefliesConnector({ redirectUri }).installationManagement!;
    await expect(management.create(connection(), {
      key: 'k', providerId: null, events: [...FirefliesEventTypes],
      destination: 'https://api.example.test/ingest/fireflies/1', enabled: null,
    }, signingSecret, neverAborts())).rejects.toMatchObject({ code: 'unsupported_capability' });
    await expect(management.inspect(connection(), {
      key: 'k', providerId: null, events: [...FirefliesEventTypes],
      destination: 'https://api.example.test/ingest/fireflies/1', enabled: null,
    }, neverAborts())).rejects.toMatchObject({ code: 'unsupported_capability' });
    await expect(management.remove(connection(), 'anything', neverAborts())).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(management.manualInstructions).toContain('https://app.fireflies.ai/integrations/api/webhook');
    expect(management.manualInstructions).toContain('test event');
    // The labels Fireflies puts on its own form, not the wire names: an
    // administrator is matching words to a screen, and `meeting.transcribed`
    // appears nowhere on it.
    expect(management.manualInstructions).toContain('Meeting Transcribed');
    expect(management.manualInstructions).toContain('Meeting Summarized');
    expect(management.manualInstructions).toContain('Meeting Bot Joined');
    // The trap worth failing a test over: Fireflies marks the signing secret
    // optional and Rally rejects every unsigned delivery, so instructions that
    // do not say so send somebody away with a webhook that silently sends
    // nothing Rally will accept.
    expect(management.manualInstructions).toContain('Fireflies labels that field optional');
    expect(management.manualInstructions).toContain('Rally requires it');
    // The wire names this string keeps for the other surface it reaches: it is
    // the registration error Settings shows while an installation is
    // action_required, which is the moment somebody is reading Fireflies'
    // delivery History and seeing `meeting.transcribed` rather than a label.
    expect(management.manualInstructions).toContain('meeting.transcribed');
    expect(management.manualInstructions).toContain('meeting.summarized');
  });

  it('records the connected account from validate so Settings can name it', async () => {
    const { fetcher } = graphqlFetch(() => ({ data: { user: { user_id: 'u-1', email: 'bob@acme.test', name: 'Bob', is_admin: true } } }));
    const management = createFirefliesConnector({ redirectUri, fetch: fetcher }).installationManagement!;
    const authorized = connection();
    await management.validate(authorized, neverAborts());
    expect(authorized.credentials.providerAccountName).toBe('bob@acme.test');
    expect(authorized.credentials.userEmail).toBe('bob@acme.test');
  });
});

describe('Fireflies workspace tools', () => {
  const adapterWith = (reply: (variables: Record<string, unknown>, document: string) => unknown) => {
    const { fetcher, documents } = graphqlFetch(reply);
    return { adapter: createFirefliesConnector({ redirectUri, fetch: fetcher }), documents };
  };

  it('searches with the pinned scope, maps a participant email into the provider array, and pages', async () => {
    let seen: Record<string, unknown> = {};
    const { adapter } = adapterWith((variables) => {
      seen = variables;
      return { data: { transcripts: [meetingFixture(), meetingFixture({ id: 'meeting-2' })] } };
    });
    const result = await adapter.executeTool('search_meetings', {
      keyword: 'renewal', participantEmail: 'dana@customer.test', limit: 2,
    }, { connection: connection(), principal, signal: neverAborts() });
    expect(seen).toMatchObject({ keyword: 'renewal', scope: 'all', participants: ['dana@customer.test'], limit: 2, skip: 0 });
    expect(seen).not.toHaveProperty('fromDate');
    expect(result.output).toMatchObject({
      meetings: [
        {
          meetingId: 'meeting-1', title: 'Acme renewal call', date: '2026-08-12T15:00:00.000Z',
          durationMinutes: 42, hostEmail: 'bob@acme.test',
          participants: ['bob@acme.test', 'dana@customer.test'], hasSummary: true,
          meetingUrl: 'https://app.fireflies.ai/view/meeting-1',
        },
        { meetingId: 'meeting-2' },
      ],
      nextOffset: 2,
    });
  });

  it('omits the provider scope when no keyword is given, because the provider then requires one', async () => {
    let seen: Record<string, unknown> = {};
    const { adapter } = adapterWith((variables) => { seen = variables; return { data: { transcripts: [] } }; });
    const result = await adapter.executeTool('search_meetings', {
      fromDate: '2026-08-01T00:00:00.000Z',
    }, { connection: connection(), principal, signal: neverAborts() });
    expect(seen).not.toHaveProperty('scope');
    expect(seen).toMatchObject({ fromDate: '2026-08-01T00:00:00.000Z' });
    // An empty result is a domain outcome, not a failure.
    expect(result.output).toEqual({ meetings: [], nextOffset: null });
  });

  it('advertises and enforces the same strict shape for all three tools', async () => {
    const adapter = createFirefliesConnector({ redirectUri, fetch: async () => Response.json({ data: {} }) });
    const schemas = new Map(adapter.manifest.tools.map((tool) => [tool.name, tool.inputSchema as {
      additionalProperties: boolean; required?: string[]; properties: Record<string, unknown>;
    }]));
    // Declared for the model...
    expect([...schemas.values()].every((schema) => schema.additionalProperties === false)).toBe(true);
    expect(schemas.get('search_meetings')?.required).toBeUndefined();
    expect(schemas.get('get_meeting_summary')?.required).toEqual(['meetingId']);
    expect(schemas.get('get_transcript')?.required).toEqual(['meetingId']);
    // ...and enforced by the executor, which is what actually refuses. A
    // declaration the parse does not repeat validates nothing.
    const call = (name: string, args: unknown) => adapter.executeTool(name, args, { connection: connection(), principal, signal: neverAborts() });
    await expect(call('search_meetings', { keyword: 'x', unexpected: true })).rejects.toBeDefined();
    await expect(call('get_meeting_summary', {})).rejects.toBeDefined();
    await expect(call('get_meeting_summary', { meetingId: 'm', unexpected: true })).rejects.toBeDefined();
    await expect(call('get_transcript', { meetingId: 'm', limit: 501 })).rejects.toBeDefined();
    await expect(call('search_meetings', { keyword: 'x', participantEmail: 'Dana' })).rejects.toBeDefined();
    await expect(call('search_meetings', { keyword: 'x', limit: 26 })).rejects.toBeDefined();
    await expect(call('unknown_tool', {})).rejects.toMatchObject({ code: 'unsupported_capability' });
  });

  it('refuses a filterless search before spending a provider request', async () => {
    let called = false;
    const { adapter } = adapterWith(() => { called = true; return { data: { transcripts: [] } }; });
    await expect(adapter.executeTool('search_meetings', {}, { connection: connection(), principal, signal: neverAborts() }))
      .rejects.toMatchObject({ code: 'invalid_payload', details: { reason: 'missing_filter', field: 'keyword' } });
    expect(called).toBe(false);
    expect(adapter.validateToolInput?.('search_meetings', {})).not.toBeNull();
    expect(adapter.validateToolInput?.('search_meetings', { keyword: 'renewal' })).toBeNull();
  });

  it('caps a search row participant list and flags it', async () => {
    const participants = Array.from({ length: 120 }, (_, index) => `person-${index}@acme.test`);
    const { adapter } = adapterWith(() => ({ data: { transcripts: [meetingFixture({ participants })] } }));
    const result = await adapter.executeTool('search_meetings', { keyword: 'all hands' }, { connection: connection(), principal, signal: neverAborts() });
    const [row] = (result.output as { meetings: { participants: string[]; participantsTruncated?: boolean }[] }).meetings;
    expect(row?.participants).toHaveLength(100);
    expect(row?.participantsTruncated).toBe(true);
  });

  it('accepts either keywords shape, because the summary app on an account decides which it gets', async () => {
    // Live returns a list; https://docs.fireflies.ai/schema/summary declares
    // `String`. Both are real — the page says summary fields come from "AI apps"
    // an account can customize — so rejecting either fails a real workspace.
    for (const keywords of [['renewal', 'pricing'], 'renewal, pricing']) {
      const { adapter } = adapterWith(() => ({
        data: { transcript: meetingFixture({ summary: { keywords } }) },
      }));
      const result = await adapter.executeTool('get_meeting_summary', { meetingId: 'meeting-1' }, { connection: connection(), principal, signal: neverAborts() });
      expect((result.output as { summary: { keywords: string } }).summary.keywords).toBe('renewal, pricing');
    }
  });

  it('reads a summary with bounded fields, named attendees, and whether a transcript exists', async () => {
    const { adapter } = adapterWith(() => ({
      data: {
        transcript: meetingFixture({
          meeting_attendees: [{ name: 'Bob Vance', email: 'bob@acme.test' }, { displayName: 'Dana', email: 'dana@customer.test' }],
          sentences: [{ index: 0 }, { index: 1 }],
          summary: {
            overview: 'o'.repeat(5_000),
            action_items: 'Bob to send pricing',
            // The shape a real workspace key returns, read live on 2026-09-15.
            // Fireflies' published schema says `String`; this fixture said the
            // same, so the suite was green while every live call was rejected.
            keywords: ['renewal', 'pricing'],
            outline: 'Intro, pricing, next steps',
            topics_discussed: ['renewal', 'pricing'],
          },
        }),
      },
    }));
    const result = await adapter.executeTool('get_meeting_summary', { meetingId: 'meeting-1' }, { connection: connection(), principal, signal: neverAborts() });
    expect(result.output).toMatchObject({
      meetingId: 'meeting-1',
      attendees: [{ name: 'Bob Vance', email: 'bob@acme.test' }, { name: 'Dana', email: 'dana@customer.test' }],
      summary: {
        actionItems: 'Bob to send pricing',
        keywords: 'renewal, pricing',
        topicsDiscussed: ['renewal', 'pricing'],
        outline: 'Intro, pricing, next steps',
      },
      truncated: true,
      transcriptAvailable: true,
    });
    expect((result.output as { summary: { overview: string } }).summary.overview).toHaveLength(4_000);
    expect(result.output).not.toHaveProperty('participants');
  });

  it('pages a transcript to a null next offset', async () => {
    const sentences = Array.from({ length: 5 }, (_, index) => ({
      index, speaker_name: 'Bob', start_time: index * 10, text: `Sentence ${index}`,
    }));
    const { adapter } = adapterWith(() => ({ data: { transcript: meetingFixture({ sentences }) } }));
    const first = await adapter.executeTool('get_transcript', { meetingId: 'meeting-1', limit: 3 }, { connection: connection(), principal, signal: neverAborts() });
    expect(first.output).toMatchObject({
      meetingId: 'meeting-1',
      sentences: [
        { index: 0, speakerName: 'Bob', startSeconds: 0, text: 'Sentence 0' },
        { index: 1 }, { index: 2 },
      ],
      nextOffset: 3,
      truncated: false,
    });
    const second = await adapter.executeTool('get_transcript', { meetingId: 'meeting-1', offset: 3, limit: 3 }, { connection: connection(), principal, signal: neverAborts() });
    expect(second.output).toMatchObject({ nextOffset: null });
    expect((second.output as { sentences: unknown[] }).sentences).toHaveLength(2);
  });

  it('reports a transcript over the response cap as payload_too_large with the summary as the way out', async () => {
    const adapter = createFirefliesConnector({
      redirectUri,
      fetch: async () => new Response('{}', { headers: { 'content-length': String(3_000_000), 'content-type': 'application/json' } }),
    });
    await expect(adapter.executeTool('get_transcript', { meetingId: 'meeting-1' }, { connection: connection(), principal, signal: neverAborts() }))
      .rejects.toMatchObject({ code: 'payload_too_large', details: { reason: 'transcript_too_large' } });
  });

  it('refuses a workspace tool the connection has not been granted', async () => {
    const adapter = createFirefliesConnector({ redirectUri });
    const ungranted = authorizedConnection({
      ...connection(), grantedScopes: [],
    } as ConnectorConnectionContext);
    await expect(adapter.executeTool('search_meetings', { keyword: 'x' }, { connection: ungranted, principal, signal: neverAborts() }))
      .rejects.toMatchObject({ code: 'unsupported_capability', details: { reason: 'capability_not_granted' } });
  });

  it('hydrates an admitted activity through the summary document rather than the transcript', async () => {
    const { adapter, documents } = adapterWith(() => ({ data: { transcript: meetingFixture({ summary: { overview: 'Renewal agreed' } }) } }));
    const hydrated = await adapter.hydrateResource!(connection(), { providerResourceId: 'meeting-1' }, neverAborts());
    expect(hydrated).toMatchObject({ meetingId: 'meeting-1', summary: { overview: 'Renewal agreed' } });
    expect(documents[0]).toContain('summary { overview action_items keywords outline topics_discussed }');
    await expect(adapter.hydrateResource!(connection('personal'), { providerResourceId: 'meeting-1' }, neverAborts()))
      .rejects.toMatchObject({ code: 'unsupported_capability' });
  });
});

describe('Fireflies provider failures', () => {
  // HTTP 500, not 200. Fireflies' documentation describes the `errors` array and
  // says nothing about the status; the live endpoint answers a rejected key with
  // 500 and that array, checked before the query is even parsed (observed
  // 2026-09-13). These fixtures returned 200, which is why the mapper looked
  // correct while production never reached it. The status is a parameter here so
  // a future provider change is a one-line edit rather than a rewrite.
  const withError = (error: Record<string, unknown>, status = 500) => createFirefliesConnector({
    redirectUri,
    fetch: async () => Response.json({ errors: [error] }, { status }),
  });

  it('reports a rejected key from the exact response Fireflies sends, status and all', async () => {
    // Captured verbatim from https://api.fireflies.ai/graphql on 2026-09-13 with
    // no valid key. Recorded rather than paraphrased because the status is the
    // part a hand-written fixture gets wrong, and getting it wrong here means a
    // revoked key reads as "Fireflies did not respond, retry" and the connection
    // never asks to be reconnected.
    const live = {
      errors: [{
        friendly: true,
        code: 'auth_failed',
        message: 'An error occurred while authenticating your request. Please recheck your API key and try again. If this persists, please contact Fireflies support.',
        extensions: { code: 'auth_failed' },
      }],
    };
    const adapter = createFirefliesConnector({ redirectUri, fetch: async () => Response.json(live, { status: 500 }) });
    await expect(adapter.executeTool('get_meeting_summary', { meetingId: 'meeting-1' }, { connection: connection(), principal, signal: neverAborts() }))
      .rejects.toMatchObject({ code: 'unauthorized', details: { reason: 'auth_failed', reconnectRequired: true } });
  });

  it.each([
    ['auth_failed', 'unauthorized', 'auth_failed'],
    ['account_cancelled', 'unauthorized', 'auth_failed'],
    ['invalid_arguments', 'invalid_payload', 'invalid_arguments'],
    ['args_required', 'invalid_payload', 'invalid_arguments'],
    ['object_not_found', 'provider_error', 'not_found'],
    ['forbidden', 'provider_error', 'forbidden'],
    ['not_in_team', 'provider_error', 'forbidden'],
    ['require_elevated_privilege', 'provider_error', 'forbidden'],
    ['paid_required', 'provider_error', 'forbidden'],
    ['request_timeout', 'provider_error', 'unavailable'],
    ['something_new', 'provider_error', 'unavailable'],
  ])('maps the %s body code onto %s / %s', async (providerCode, code, reason) => {
    const adapter = withError({ code: providerCode, extensions: { code: providerCode } });
    await expect(adapter.executeTool('get_meeting_summary', { meetingId: 'meeting-1' }, { connection: connection(), principal, signal: neverAborts() }))
      .rejects.toMatchObject({ code, details: { reason } });
  });

  it('names the fields the provider rejected so the model can correct them', async () => {
    const adapter = withError({
      code: 'invalid_arguments',
      extensions: { code: 'invalid_arguments', metadata: { fields: [{ name: 'fromDate', message: 'fromDate must be a Date instance' }] } },
    });
    await expect(adapter.executeTool('search_meetings', { keyword: 'x' }, { connection: connection(), principal, signal: neverAborts() }))
      .rejects.toMatchObject({ details: { reason: 'invalid_arguments', field: 'fromDate' } });
  });

  it('turns the rate-limit reset time into a wait the model can compare against', async () => {
    const retryAfter = Date.now() + 45_000;
    const adapter = withError({ code: 'too_many_requests', extensions: { code: 'too_many_requests', metadata: { retryAfter } } });
    const failure: unknown = await adapter.executeTool('search_meetings', { keyword: 'x' }, { connection: connection(), principal, signal: neverAborts() })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectorError);
    const raised = failure as ConnectorError;
    expect(raised.code).toBe('provider_error');
    const details = raised.details as { reason: string; retryAfterMs: number };
    expect(details.reason).toBe('rate_limited');
    expect(details.retryAfterMs).toBeGreaterThan(40_000);
    expect(details.retryAfterMs).toBeLessThanOrEqual(45_000);
  });

  it('reads a missing transcript as a wrong id rather than an empty meeting', async () => {
    const adapter = createFirefliesConnector({ redirectUri, fetch: async () => Response.json({ data: { transcript: null } }) });
    await expect(adapter.executeTool('get_meeting_summary', { meetingId: 'not-a-fireflies-id' }, { connection: connection(), principal, signal: neverAborts() }))
      .rejects.toMatchObject({ code: 'provider_error', details: { reason: 'not_found', field: 'meetingId' } });
  });

  it('reports an unreachable provider as unavailable and a rejected key as needing reconnection', async () => {
    const unreachable = createFirefliesConnector({ redirectUri, fetch: async () => { throw new TypeError('network down'); } });
    await expect(unreachable.executeTool('search_meetings', { keyword: 'x' }, { connection: connection(), principal, signal: neverAborts() }))
      .rejects.toMatchObject({ code: 'provider_error', details: { reason: 'unavailable' } });
    const rejected = createFirefliesConnector({ redirectUri, fetch: async () => new Response('{}', { status: 401 }) });
    await expect(rejected.executeTool('search_meetings', { keyword: 'x' }, { connection: connection(), principal, signal: neverAborts() }))
      .rejects.toMatchObject({ code: 'unauthorized', details: { reason: 'auth_failed', reconnectRequired: true } });
  });

  it('flips the workspace health check to reconnect-required on a rejected key, and warns while delivery is unverified', async () => {
    const healthy = createFirefliesConnector({ redirectUri, fetch: async () => Response.json({ data: { user: { email: 'bob@acme.test' } } }) });
    await expect(healthy.healthCheck(connection(), neverAborts())).resolves.toMatchObject({
      ok: true, message: 'Fireflies API key is valid for bob@acme.test',
      warning: 'Check the workspace installation for verified webhook delivery status',
    });
    const revoked = createFirefliesConnector({ redirectUri, fetch: async () => Response.json({ errors: [{ code: 'auth_failed' }] }, { status: 500 }) });
    await expect(revoked.healthCheck(connection(), neverAborts())).resolves.toMatchObject({ ok: false, reconnectRequired: true });
  });
});

describe('Fireflies webhook ingestion', () => {
  const adapter = createFirefliesConnector({ redirectUri });
  const body = JSON.stringify({ event: 'meeting.summarized', timestamp: 1_786_000_000_000, meeting_id: 'meeting-1' });

  const verify = async (raw: string, secret: string, header: string | null, now = 1_786_000_000_000) => {
    const headers = new Headers();
    if (header) headers.set('X-Hub-Signature', header);
    return adapter.webhookActivity!.verify({
      rawBody: raw, rawBodyBytes: new TextEncoder().encode(raw), headers,
      receivedAt: new Date(now).toISOString(), maxBytes: 2_000_000, now,
      verificationSecret: secret, replayWindowMs: 300_000,
    });
  };

  it('accepts a correctly signed delivery and keys its receipt on the exact bytes signed', async () => {
    const envelope = await verify(body, signingSecret, await signature(body, signingSecret));
    expect(envelope.eventType).toBe('meeting.summarized');
    expect(envelope.deliveryId).toBe('meeting-1:meeting.summarized');
    expect(envelope.receiptKey).toBe(envelope.bodyHash);
    const replay = await verify(body, signingSecret, await signature(body, signingSecret));
    expect(replay.receiptKey).toBe(envelope.receiptKey);
    const other = JSON.stringify({ event: 'meeting.summarized', timestamp: 1_786_000_000_001, meeting_id: 'meeting-1' });
    const next = await verify(other, signingSecret, await signature(other, signingSecret), 1_786_000_000_001);
    expect(next.receiptKey).not.toBe(envelope.receiptKey);
  });

  it.each([
    ['unsigned', null],
    ['mis-signed', 'sha256=0000000000000000000000000000000000000000000000000000000000000000'],
    ['downgraded', 'sha1=0000000000000000000000000000000000000000'],
  ])('rejects a %s delivery', async (_name, header) => {
    await expect(verify(body, signingSecret, header)).rejects.toMatchObject({ code: 'invalid_signature' });
  });

  it('rejects a delivery whose in-body timestamp is outside the replay window', async () => {
    await expect(verify(body, signingSecret, await signature(body, signingSecret), 1_786_000_000_000 + 600_000))
      .rejects.toMatchObject({ code: 'invalid_signature' });
  });

  it('rejects a body over the configured limit before parsing it', async () => {
    const headers = new Headers();
    headers.set('X-Hub-Signature', await signature(body, signingSecret));
    await expect(adapter.webhookActivity!.verify({
      rawBody: body, rawBodyBytes: new TextEncoder().encode(body), headers,
      receivedAt: new Date().toISOString(), maxBytes: 4, now: 1_786_000_000_000, verificationSecret: signingSecret,
    })).rejects.toMatchObject({ code: 'payload_too_large' });
  });

  it('normalizes a summary delivery into one hydratable workspace activity', async () => {
    const envelope = await verify(body, signingSecret, await signature(body, signingSecret));
    const normalized = adapter.webhookActivity!.normalize(connection(), envelope, 'global/ws/activities/fireflies/x.json');
    expect(normalized).toMatchObject({
      provider: 'fireflies',
      providerEventId: 'meeting-1',
      eventType: 'meeting.summarized',
      resourceType: 'fireflies_meeting',
      providerResourceId: 'meeting-1',
      title: 'Fireflies meeting summarized',
      summary: '',
      textSnippet: '',
      entityKeys: ['fireflies:meeting:meeting-1'],
      dedupeKey: 'fireflies:meeting-1:meeting.summarized',
      visibility: { scope: 'workspace' },
      occurredAt: '2026-08-06T07:06:40.000Z',
    });
  });

  it('gives the two handled events distinct dedupe keys so neither swallows the other', async () => {
    const transcribed = JSON.stringify({ event: 'meeting.transcribed', timestamp: 1_786_000_000_000, meeting_id: 'meeting-1' });
    const summarized = adapter.webhookActivity!.normalize(connection(), await verify(body, signingSecret, await signature(body, signingSecret)), null);
    const earlier = adapter.webhookActivity!.normalize(
      connection(),
      await verify(transcribed, signingSecret, await signature(transcribed, signingSecret)),
      null,
    );
    expect(earlier?.dedupeKey).toBe('fireflies:meeting-1:meeting.transcribed');
    expect(summarized?.dedupeKey).not.toBe(earlier?.dedupeKey);
    expect(earlier?.providerEventId).toBe(summarized?.providerEventId);
  });

  it('rejects a verified delivery of an event this connector does not handle', async () => {
    const botJoined = JSON.stringify({ event: 'meeting.bot_joined', timestamp: 1_786_000_000_000, meeting_id: 'meeting-1' });
    const envelope = await verify(botJoined, signingSecret, await signature(botJoined, signingSecret));
    expect(envelope.eventType).toBe('meeting.bot_joined');
    expect(() => adapter.webhookActivity!.normalize(connection(), envelope, null))
      .toThrow(expect.objectContaining({ code: 'unsupported_capability' }) as Error);
  });

  it('verifies the dashboard test event like any delivery and leaves nothing to normalize', async () => {
    // The shape Fireflies' "Send test event" button was observed to deliver:
    // signed, timestamped, and naming a placeholder meeting.
    const test = JSON.stringify({ event: 'test', timestamp: 1_786_000_000_000, meeting_id: 'test_00000000' });
    await expect(verify(test, signingSecret, null)).rejects.toMatchObject({ code: 'invalid_signature' });
    const envelope = await verify(test, signingSecret, await signature(test, signingSecret));
    expect(envelope.eventType).toBe('test');
    expect(adapter.webhookActivity!.normalize(connection(), envelope, null)).toBeNull();
  });

  it('refuses to normalize a delivery against a personal connection', async () => {
    const envelope = await verify(body, signingSecret, await signature(body, signingSecret));
    expect(() => adapter.webhookActivity!.normalize(connection('personal'), envelope, null))
      .toThrow(expect.objectContaining({ code: 'unauthorized' }) as Error);
  });

  it('verifies a raw body exactly, with no algorithm downgrade', async () => {
    const bytes = new TextEncoder().encode(body);
    const valid = await signature(body, signingSecret);
    await expect(verifyFirefliesSignature(signingSecret, bytes, valid)).resolves.toBeUndefined();
    // Fireflies documents no hex casing, so both spellings of the same digest
    // are the same signature. What must not be accepted is a different digest.
    await expect(verifyFirefliesSignature(signingSecret, bytes, `sha256=${valid.slice('sha256='.length).toUpperCase()}`))
      .resolves.toBeUndefined();
    await expect(verifyFirefliesSignature(signingSecret, bytes, valid.replace(/^sha256=/u, 'SHA1=')))
      .rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(verifyFirefliesSignature(signingSecret, bytes, await signature(`${body} `, signingSecret)))
      .rejects.toMatchObject({ code: 'invalid_signature' });
    // The facet refuses a missing secret earlier, with `invalid_configuration`;
    // reaching this helper without one is a signature that cannot be checked.
    await expect(verifyFirefliesSignature('', bytes, valid)).rejects.toMatchObject({ code: 'invalid_signature' });
  });
});

describe('Fireflies personal scope', () => {
  it('pins OAuth to the provider origin and refuses a workspace authorization', async () => {
    const origins: string[] = [];
    const adapter = createFirefliesConnector({ redirectUri, fetch: async (input) => {
      const url = new URL(String(input));
      origins.push(url.origin);
      if (url.pathname.includes('oauth-protected-resource')) {
        return Response.json({ resource: 'https://api.fireflies.ai/mcp', authorization_servers: ['https://evil.example.test/'], scopes_supported: ['profile', 'email'] });
      }
      throw new Error(`unexpected ${url.toString()}`);
    } });
    await expect(adapter.beginAuthorization!({ connectionScope: 'workspace', state: 's', codeChallenge: 'c' }))
      .rejects.toMatchObject({ code: 'invalid_configuration' });
    await expect(adapter.beginAuthorization!({ connectionScope: 'personal', state: 's', codeChallenge: 'c' }))
      .rejects.toMatchObject({ code: 'invalid_configuration' });
    // The code is what separates the pin from an ordinary transport failure —
    // without it this passes whether or not the pin exists, because a throwing
    // fetch also surfaces as a ConnectorError. The origins are the proof that
    // Rally's client registration never left for whoever answered discovery.
    expect([...new Set(origins)]).toEqual(['https://api.fireflies.ai']);
  });

  it('asks for no scope Fireflies does not publish, and reports a missing refresh token as reconnect-required', async () => {
    const requests: URL[] = [];
    const adapter = createFirefliesConnector({ redirectUri, fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname.includes('oauth-protected-resource')) {
        return Response.json({ resource: 'https://api.fireflies.ai/mcp', authorization_servers: ['https://api.fireflies.ai/'], scopes_supported: ['profile', 'email'] });
      }
      if (url.pathname.includes('oauth-authorization-server')) {
        return Response.json({
          issuer: 'https://api.fireflies.ai/',
          authorization_endpoint: 'https://api.fireflies.ai/authorize',
          token_endpoint: 'https://api.fireflies.ai/token',
          registration_endpoint: 'https://api.fireflies.ai/register',
          scopes_supported: ['profile', 'email'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        });
      }
      if (url.pathname === '/register') return Response.json({ client_id: 'client-1', token_endpoint_auth_method: 'none' });
      throw new Error(`unexpected ${url.toString()} ${String(init?.method)}`);
    } });
    const begun = await adapter.beginAuthorization!({ connectionScope: 'personal', state: 'state-1', codeChallenge: 'challenge-1' });
    const authorizeUrl = new URL(begun.url);
    expect(authorizeUrl.origin).toBe('https://api.fireflies.ai');
    expect(authorizeUrl.searchParams.get('scope') ?? '').not.toContain('offline_access');
    await expect(adapter.refreshCredentials!({
      id: '55555555-5555-4555-8555-555555555555', workspaceId, scope: 'personal',
      ownerUserId: '66666666-6666-4666-8666-666666666666',
      grantedScopes: [FirefliesCapabilities.personalRead], credentials: { accessToken: 'a' }, config: {}, cursor: {},
    }, neverAborts())).rejects.toMatchObject({ code: 'unauthorized', details: { reason: 'missing_refresh_token', reconnectRequired: true } });
  });
});
