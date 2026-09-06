/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { asWorkspaceId, type WorkspaceId } from '@rally/contracts';
import { createExecutionContext, createMessageBatch, getQueueResult, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Tokenizer } from '@huggingface/tokenizers';
import { workspaceDOName, conversationObjectName } from '../src/durable-objects/names';
import { consumeActivityQueue } from '../src/queues/activity-consumer';
import { seedWorkstreamRoot, seedParticipantMessage } from './helpers/substream-fixture';
import { searchDocumentId } from '../src/services/text-search';
import type { Env } from '../src/env';

let workspaceId: WorkspaceId;
let parentId: string;
let resourceId: string;
const resourceMessage = () => ({ type: 'resource_search_projection_v1', region: 'global', workspaceId, resourceId });
const pipelineEnv: Env = { ...env, TURBO_PUFFER_DEV_API_KEY: 'test-only', OPENROUTER_API_KEY: 'test-only',
  LOG_LEVEL: 'warn' };
const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
const embeddingInputs: string[] = [];
let onEmbed: (() => Promise<void>) | undefined;
let tokenizerReads = 0;
// Sized above 512 tokens for the actual pinned Qwen tokenizer.
const documentBody = 'beta\n\ngamma delta'.repeat(180);

// External API responses are the only doubles. The bundled Qwen tokenizer,
// Queue consumer, source RPC, SQLite migrations, and R2 contents run in workerd.
beforeEach(() => {
  workspaceId = asWorkspaceId(crypto.randomUUID());
  parentId = crypto.randomUUID();
  resourceId = crypto.randomUUID();
  writes.length = 0;
  embeddingInputs.length = 0;
  tokenizerReads = 0;
  onEmbed = undefined;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === 'huggingface.co') {
      tokenizerReads += 1;
      return new Response('asset host unavailable', { status: 503 });
    }
    if (url.hostname === 'openrouter.ai') {
      const body = z.object({ input: z.string() }).parse(await request.json());
      if (!body.input.trim()) return Response.json({ error: { message: "Input must not be empty", code: 400 } }, { status: 400 });
      embeddingInputs.push(body.input);
      const callback = onEmbed;
      onEmbed = undefined;
      await callback?.();
      return Response.json({ object: 'list', model: 'Qwen/Qwen3-Embedding-8B',
        data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: 1024 }, () => 1) }],
        usage: { prompt_tokens: 1, total_tokens: 1 } });
    }
    if (url.hostname.endsWith('.turbopuffer.com')) {
      writes.push({ path: url.pathname, body: z.record(z.string(), z.unknown()).parse(await request.json()) });
      return Response.json({ rows_affected: 1 });
    }
    throw new Error('unexpected_external_request');
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function seedResource(provider = 'avalon_upload') {
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO workspace_identity
      (id, workspace_id, region, placement_affinity, created_at, updated_at)
      VALUES (1, ?, 'global', 'wnam', 0, 0)`, workspaceId);
    state.storage.sql.exec(`INSERT INTO resources
      (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
       content_ref, metadata_json, attachment_status, model_content_status, created_at, updated_at)
      VALUES (?, ?, 'file', ?, 'pipeline-fixture', 'alpha', 'text/plain',
        'pipeline/body', '{}', 'attached', 'ready', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z')`, resourceId, workspaceId, provider);
  });
  await env.PAYLOADS.put('pipeline/body', documentBody);
  return stub;
}

async function consume(bodies: unknown[], overrides: Partial<Env> = {}) {
  const batch = createMessageBatch('avalon-do-runtime-test-activity', bodies.map((body, index) => ({
    id: `search-${index}`, timestamp: new Date(), body, attempts: 1,
  })));
  await consumeActivityQueue(batch, { ...pipelineEnv, ...overrides });
  return getQueueResult(batch, createExecutionContext());
}

const RowsSchema = z.array(z.object({ source: z.string(), text: z.string(), record_type: z.string(),
  chunk_start: z.number().nullable(), chunk_end: z.number().nullable() }));
function liveRows() {
  return writes.flatMap(({ body }) => {
    const rows = RowsSchema.safeParse(body.upsert_rows);
    return rows.success ? rows.data : [];
  });
}

describe('shared Queue indexing pipeline', () => {
  it('indexes overlapping Queue deliveries with the real shared tokenizer', async () => {
    await seedResource();
    const firstMessage = resourceMessage();
    workspaceId = asWorkspaceId(crypto.randomUUID());
    resourceId = crypto.randomUUID();
    await seedResource();
    const tokenize = vi.spyOn(Tokenizer.prototype, 'tokenize');
    const results = await Promise.all([consume([firstMessage]), consume([resourceMessage()])]);
    for (const result of results) {
      expect(result.explicitAcks).toEqual(['search-0']);
      expect(result.retryMessages).toEqual([]);
    }
    expect(liveRows().filter((row) => row.record_type === 'chunk').length).toBeGreaterThan(2);
    expect(tokenize).toHaveBeenCalled();
    expect(new Set(tokenize.mock.contexts).size).toBe(1);
    expect(tokenizerReads).toBe(0);
  });

  it('uses the same canonical text, chunks, and embedding inputs for attachments and messages', async () => {
    await seedResource();
    const stub = env.SUBSTREAM_AGENTS.getByName(conversationObjectName('global', workspaceId, parentId, '0'));
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
      await seedParticipantMessage(state, { id: 'message', sequence: 1, text: `alpha\n${documentBody}` });
    });
    const result = await consume([resourceMessage(), { type: 'search_projection_v1', region: 'global', workspaceId,
      parentId, substreamId: '0', turnId: 'message', revision: 1 }]);
    expect(result.explicitAcks).toEqual(['search-0', 'search-1']);
    expect(result.retryMessages).toEqual([]);
    const files = liveRows().filter((row) => row.source === 'files');
    const messages = liveRows().filter((row) => row.source === 'messages');
    expect(files).toEqual(messages.map((row) => ({ ...row, source: 'files' })));
    expect(files.filter((row) => row.record_type === 'chunk').length).toBeGreaterThan(1);
    const chunks = files.filter((row) => row.record_type === 'chunk');
    expect(embeddingInputs).toEqual([...chunks, ...chunks].map((row) => row.text));
    expect(tokenizerReads).toBe(0); // The asset host can be unavailable throughout indexing.
  });

  it('uses identical passages for generated artifacts and captured web pages', async () => {
    const workspace = await seedResource('avalon_generated');
    const url = 'https://example.com/';
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec('UPDATE resources SET canonical_url = ? WHERE id = ?', url, resourceId);
    });
    const stub = env.SUBSTREAM_AGENTS.getByName(conversationObjectName('global', workspaceId, parentId, '0'));
    const linkId = await searchDocumentId('conversation_links', `${parentId}/0/link-message`, url);
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
      await seedParticipantMessage(state, { id: 'link-message', sequence: 1, text: `[alpha](${url})` });
      state.storage.sql.exec(`INSERT INTO conversation_search_links
        (id, turn_id, url, label, markdown, captured, deleted, revision)
        VALUES (?, 'link-message', ?, 'alpha', ?, 1, 0, 1)`, linkId, url, documentBody);
    });
    const result = await consume([resourceMessage(), { type: 'search_projection_v1', region: 'global', workspaceId,
      parentId, substreamId: '0', turnId: 'link-message', revision: 1 }]);
    expect(result.explicitAcks).toEqual(['search-0', 'search-1']);
    const artifacts = liveRows().filter((row) => row.source === 'artifacts');
    const pages = liveRows().filter((row) => row.source === 'conversation_links');
    expect(artifacts).toEqual(pages.map((row) => ({ ...row, source: 'artifacts' })));
    expect(pages.filter((row) => row.record_type === 'chunk').length).toBeGreaterThan(1);
  });

  it('reclaims a generation and retries when deletion commits during embedding', async () => {
    const stub = await seedResource('avalon_generated');
    const revision = await stub.resourceSearchRevision({ workspaceId, resourceId });
    expect(revision).not.toBeNull();
    onEmbed = () => runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DELETE FROM resources WHERE id = ?', resourceId);
    });
    const result = await consume([resourceMessage()]);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'search-0' }]);
    expect(writes.some(({ body }) => JSON.stringify(body.delete_by_filter ?? null).includes(JSON.stringify(['revision', 'Eq', revision])))).toBe(true);
    const retried = await consume([resourceMessage()]);
    expect(retried.explicitAcks).toEqual(['search-0']);
    expect(writes.some(({ body }) => JSON.stringify(body.delete_by_filter ?? null).includes(JSON.stringify(['revision', 'Lte', revision! + 1])))).toBe(true);
  });

  it('does not tombstone a live same-revision extraction change', async () => {
    await seedResource();
    onEmbed = async () => { await env.PAYLOADS.put('pipeline/body', 'updated body'); };
    const result = await consume([resourceMessage()]);
    expect(result.retryMessages).toEqual([{ msgId: 'search-0' }]);
    const id = await searchDocumentId('files', workspaceId, resourceId);
    const tombstones = writes.flatMap(({ body }) => z.array(z.object({ id: z.string(), deleted: z.boolean().optional() }))
      .safeParse(body.upsert_rows).data ?? []).filter((row) => row.id === id && row.deleted);
    expect(tombstones).toEqual([]);
    expect((await consume([resourceMessage()])).explicitAcks).toEqual(['search-0']);
    expect(liveRows().some((row) => row.text.includes('updated body'))).toBe(true);
  });

  it('rejects wrong-region references before reading or writing any source', async () => {
    const result = await consume([{ ...resourceMessage(), region: 'eu' }]);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'search-0' }]);
    expect(writes).toEqual([]);
    expect(embeddingInputs).toEqual([]);
  });

  it('keeps lexical text available but retries rather than silently skipping an unconfigured vector pipeline', async () => {
    await seedResource();
    const result = await consume([resourceMessage()], { OPENROUTER_API_KEY: '' });
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'search-0' }]);
    expect(liveRows().some((row) => row.text.includes('gamma delta'))).toBe(true);
    expect(embeddingInputs).toEqual([]);
  });
});
