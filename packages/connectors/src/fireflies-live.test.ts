/**
 * Fireflies against a real account. Inert without a key.
 *
 *   FIREFLIES_API_KEY=… pnpm --filter @rally/connectors exec vitest run src/fireflies-live.test.ts
 *
 * This drives the shipped adapter rather than curl, so what it exercises is
 * Rally's own path: the checked-in GraphQL documents against the live schema,
 * the error mapping, the output caps and their truncation flags.
 *
 * It prints shapes, codes and counts — never a meeting title, a sentence, an
 * attendee, or the key. Somebody's real calls are on the other end of this.
 */
import { asWorkspaceId } from '@rally/contracts';
import { describe, expect, it } from 'vitest';

import { createFirefliesConnector, FirefliesCapabilities } from './fireflies';
import { authorizedConnection, type ConnectorConnectionContext } from './types';

const apiKey = process.env.FIREFLIES_API_KEY ?? '';
const workspaceId = asWorkspaceId('44444444-4444-4444-8444-444444444444');
const principal = { type: 'workspace' as const, workspaceId };

function connection() {
  return authorizedConnection({
    id: '55555555-5555-4555-8555-555555555555',
    workspaceId,
    scope: 'workspace',
    ownerUserId: null,
    grantedScopes: [FirefliesCapabilities.workspaceRead],
    credentials: { apiKey },
    config: { region: 'global' },
    cursor: {},
  } satisfies ConnectorConnectionContext);
}

/** A value's shape, without what it says. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return { array: value.length, of: value.length ? shape(value[0]) : null };
  if (value === null) return null;
  if (typeof value === 'string') return `string(${value.length})`;
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, shape(item)]));
  }
  return typeof value;
}

async function report(label: string, run: () => Promise<unknown>): Promise<unknown> {
  try {
    const output = await run();
    console.log(`\n=== ${label} — OK\n${JSON.stringify(shape(output), null, 2)}`);
    return output;
  } catch (error) {
    const failure = error as { code?: string; details?: unknown; message?: string };
    console.log(`\n=== ${label} — FAILED\n${JSON.stringify({ code: failure.code, details: failure.details, message: failure.message }, null, 2)}`);
    return null;
  }
}

describe.skipIf(!apiKey)('Fireflies, against a live account', () => {
  const adapter = createFirefliesConnector({ redirectUri: 'https://api.example.test/connections/fireflies/callback' });
  const context = () => ({ connection: connection(), principal, signal: AbortSignal.timeout(30_000) });

  it('accepts the key and names the account', async () => {
    const health = await adapter.healthCheck!(connection(), AbortSignal.timeout(30_000));
    console.log(`\n=== healthCheck ${JSON.stringify({ ok: health.ok, namesAnAccount: /@/u.test(health.message) })}`);
    expect(health.ok).toBe(true);
  });

  it('validates the search document against the live schema', async () => {
    // This is the check that earns the file. A wrong variable *type* invalidates
    // the whole document — the first run of this failed both searches with
    // `GRAPHQL_VALIDATION_FAILED` because the checked-in query declared
    // `$scope: TranscriptsQueryScope`, a type Fireflies documents and does not
    // have, and `[String]` where the schema wants `[String!]`. Eight thousand
    // hand-fixtured tests had nothing to say about either.
    const keyworded = await report('search_meetings(keyword) — sends scope: all', () =>
      adapter.executeTool('search_meetings', { keyword: 'the', limit: 3 }, context()));
    // No keyword means no scope is sent: the control that separates a rejected
    // argument from a search that simply matches nothing.
    const unscoped = await report('search_meetings(fromDate only) — sends no scope', () =>
      adapter.executeTool('search_meetings', { fromDate: '2020-01-01T00:00:00.000Z', limit: 3 }, context()));
    expect(keyworded, 'the keyword search was rejected — read the logged code').not.toBeNull();
    expect(unscoped, 'the unscoped search was rejected — read the logged code').not.toBeNull();
  });

  it('reads a summary and a transcript for a real meeting', async () => {
    const found = await adapter.executeTool('search_meetings', { fromDate: '2020-01-01T00:00:00.000Z', limit: 1 }, context())
      .catch(() => null) as { output?: { meetings?: { meetingId?: string }[] } } | null;
    const meetingId = found?.output?.meetings?.[0]?.meetingId;
    if (!meetingId) { console.log('\n=== this account has no meetings; summary and transcript skipped'); return; }
    await report('get_meeting_summary', () => adapter.executeTool('get_meeting_summary', { meetingId }, context()));
    await report('get_transcript', () => adapter.executeTool('get_transcript', { meetingId, limit: 5 }, context()));
  });

  it('reports a bad meeting id the way the error table claims', async () => {
    await report('get_meeting_summary(nonexistent)', () =>
      adapter.executeTool('get_meeting_summary', { meetingId: 'definitely-not-a-meeting' }, context()));
  });
});
