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
import { SearchDocumentJobSchema, SearchEmbeddingBatchSchema, SearchSourceReferenceSchema, publishSearchIndexingJobs } from '../src/services/search-indexing-jobs';

let workspaceId: WorkspaceId;
let parentId: string;
let resourceId: string;
const resourceMessage = () => ({ type: 'resource_search_projection_v1', region: 'global', workspaceId, resourceId });
const pipelineEnv: Env = { ...env, TURBO_PUFFER_DEV_API_KEY: 'test-only', OPENROUTER_API_KEY: 'test-only',
  LOG_LEVEL: 'warn' };
const writes: Array<{ path: string; body: Record<string, unknown>; semanticCount: number }> = [];
const embeddingInputs: string[] = [];
const embeddingBatches: string[][] = [];
let onEmbed: (() => Promise<void>) | undefined;
let onWrite: (() => Promise<void>) | undefined;
let tokenizerReads = 0;
let responseModel = 'Qwen/Qwen3-Embedding-8B';
const trackPublishedBatches = () => vi.spyOn(env.ACTIVITY_QUEUE, 'sendBatch');
let publish: ReturnType<typeof trackPublishedBatches>;
const indexed = new Map<string, Record<string, unknown>>();
// Model only the external provider's filters; canonical stores and Queue are real.
function matchesFilter(row: Record<string, unknown>, filter: unknown): boolean {
  const parts = z.array(z.unknown()).parse(filter);
  if (parts[0] === 'And' || parts[0] === 'Or') {
    const children = z.array(z.unknown()).parse(parts[1]);
    return parts[0] === 'And' ? children.every((child) => matchesFilter(row, child))
      : children.some((child) => matchesFilter(row, child));
  }
  const value = row[z.string().parse(parts[0])] ?? null;
  if (parts[1] === 'Eq') return value === parts[2];
  if (parts[1] === 'In') return z.array(z.unknown()).parse(parts[2]).includes(value);
  if (parts[1] === 'Lt') return z.number().parse(value) < z.number().parse(parts[2]);
  if (parts[1] === 'Lte') return z.number().parse(value) <= z.number().parse(parts[2]);
  throw new Error('unsupported_provider_filter');
}
// Sized above 512 tokens for the actual pinned Qwen tokenizer.
const documentBody = 'beta\n\ngamma delta'.repeat(180);

// External API responses are the only doubles. The bundled Qwen tokenizer,
// Queue consumer, source RPC, SQLite migrations, and R2 contents run in workerd.
beforeEach(() => {
  workspaceId = asWorkspaceId(crypto.randomUUID());
  parentId = crypto.randomUUID();
  resourceId = crypto.randomUUID();
  writes.length = 0;
  indexed.clear();
  publish = trackPublishedBatches();
  embeddingInputs.length = 0;
  embeddingBatches.length = 0;
  tokenizerReads = 0;
  responseModel = 'Qwen/Qwen3-Embedding-8B';
  onEmbed = undefined;
  onWrite = undefined;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === 'huggingface.co') {
      tokenizerReads += 1;
      return new Response('asset host unavailable', { status: 503 });
    }
    if (url.hostname === 'openrouter.ai') {
      const body = z.object({ input: z.array(z.string()) }).parse(await request.json());
      if (body.input.some((text) => !text.trim())) return Response.json({ error: { message: "Input must not be empty", code: 400 } }, { status: 400 });
      embeddingInputs.push(...body.input);
      embeddingBatches.push(body.input);
      const callback = onEmbed;
      onEmbed = undefined;
      await callback?.();
      return Response.json({ object: 'list', model: responseModel,
        data: body.input.map((_text, index) => ({ object: 'embedding', index, embedding: Array.from({ length: 1024 }, () => 1) })),
        usage: { prompt_tokens: 1, total_tokens: 1 } });
    }
    if (url.hostname.endsWith('.turbopuffer.com')) {
      const body = z.record(z.string(), z.unknown()).parse(await request.json());
      const namespace = url.pathname.replace(/\/query$/, '');
      if (url.pathname.endsWith('/query')) {
        const rows = [...indexed].filter(([key, row]) => key.startsWith(`${namespace}\0`)
          && matchesFilter(row, body.filters));
        return Response.json({ aggregations: { count: rows.length } });
      }
      writes.push({ path: url.pathname, body, semanticCount: [...indexed.values()].filter((row) => row.record_type === 'chunk').length });
      if (body.delete_by_filter) {
        for (const [key, row] of indexed) {
          if (key.startsWith(`${namespace}\0`) && matchesFilter(row, body.delete_by_filter)) indexed.delete(key);
        }
      }
      for (const row of z.array(z.record(z.string(), z.unknown())).parse(body.upsert_rows ?? [])) {
        if (typeof row.id === 'string') indexed.set(`${namespace}\0${row.id}`, row);
      }
      if (z.array(z.object({ record_type: z.string().optional() })).parse(body.upsert_rows ?? [])
        .some((row) => row.record_type === 'chunk')) {
        const callback = onWrite; onWrite = undefined; await callback?.();
      }
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

async function consume(bodies: unknown[], overrides: Partial<Env> = {}, drainJobs = true, drainDocuments = true) {
  const firstSend = publish.mock.calls.length;
  const batch = createMessageBatch('avalon-do-runtime-test-activity', bodies.map((body, index) => ({
    id: `search-${index}`, timestamp: new Date(), body, attempts: 1,
  })));
  await consumeActivityQueue(batch, { ...pipelineEnv, ...overrides });
  const result = await getQueueResult(batch, createExecutionContext());

  const references = bodies.map((body) => SearchSourceReferenceSchema.safeParse(body)).filter((value) => value.success)
    .map((value) => JSON.stringify(value.data));
  const documents = publish.mock.calls.slice(firstSend).flatMap(([messages]) => [...messages])
    .map((message) => SearchDocumentJobSchema.safeParse(message.body)).filter((value) => value.success)
    .map((value) => value.data).filter((job) => references.includes(JSON.stringify(job.reference)));
  if (drainDocuments) for (const job of documents) {
    const child = await consume([job], overrides, drainJobs);
    expect(child.retryMessages).toEqual([]);
    expect(child.explicitAcks).toEqual(['search-0']);
  }
  if (!drainJobs) return result;
  const jobReference = bodies.map((body) => SearchDocumentJobSchema.safeParse(body)).filter((value) => value.success)
    .map((value) => JSON.stringify(value.data.reference));
  const jobs = publish.mock.calls.slice(firstSend).flatMap(([messages]) => [...messages])
    .map((message) => SearchEmbeddingBatchSchema.safeParse(message.body)).filter((value) => value.success)
    .map((value) => value.data).filter((job) => jobReference.includes(JSON.stringify(job.reference)));
  for (const job of jobs) {
    if (overrides.OPENROUTER_API_KEY === '') continue;
    const child = await consume([job], overrides);
    expect(child.retryMessages).toEqual([]);
    expect(child.explicitAcks).toEqual(['search-0']);
  }
  return result;
}


function publishedEmbeddingJobs() {
  return publish.mock.calls.flatMap(([messages]) => [...messages])
    .flatMap((message) => {
      const parsed = SearchEmbeddingBatchSchema.safeParse(message.body);
      return parsed.success ? [parsed.data] : [];
    });
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
  it('discovers a multi-page turn without tokenizing and plans only the selected page per delivery', async () => {
    const stub = env.SUBSTREAM_AGENTS.getByName(conversationObjectName('global', workspaceId, parentId, '0'));
    const urls = ['https://example.com/first', 'https://example.com/second'];
    const ids = await Promise.all(urls.map((url) => searchDocumentId('conversation_links', `${parentId}/0/pages`, url)));
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
      await seedParticipantMessage(state, { id: 'pages', sequence: 1, text: urls.join('\n') });
      for (const [offset, url] of urls.entries()) state.storage.sql.exec(`INSERT INTO conversation_search_links
        (id, turn_id, url, label, markdown, captured, deleted, revision)
        VALUES (?, 'pages', ?, ?, ?, 1, 0, 1)`, ids[offset]!, url, url, `${offset} ${documentBody}`);
    });
    const reference = { type: 'search_projection_v1', region: 'global', workspaceId,
      parentId, substreamId: '0', turnId: 'pages', revision: 1 };
    const tokenize = vi.spyOn(Tokenizer.prototype, 'tokenize');
    const discovery = await consume([reference], {}, false, false);
    expect(discovery.explicitAcks).toEqual(['search-0']);
    expect(tokenize).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    const jobs = publish.mock.calls.flatMap(([messages]) => [...messages])
      .map((message) => SearchDocumentJobSchema.parse(message.body));
    expect(jobs).toHaveLength(3);
    const pageJob = jobs.find((job) => job.documentId === ids[0])!;
    const loaded = await stub.prepareSearchTurn(reference, false, pageJob.documentId);
    expect(loaded.documents.map((document) => document.id)).toEqual([ids[0]]);
    const plan = await consume([pageJob], {}, false);
    expect(plan.explicitAcks).toEqual(['search-0']);
    expect(tokenize).toHaveBeenCalled();
    expect(embeddingInputs).toEqual([]);
    expect(liveRows().filter((row) => row.record_type === 'document').map((row) => row.text))
      .toEqual(loaded.documents.map((document) => document.text));
    expect(publishedEmbeddingJobs().every((job) => job.document.id === ids[0])).toBe(true);
  });

  it('retries malformed and wrong-region document jobs without touching providers', async () => {
    const result = await consume([{ type: 'search_document_v1' }, {
      type: 'search_document_v1', reference: { ...resourceMessage(), region: 'eu' }, documentId: 'document',
    }]);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'search-0' }, { msgId: 'search-1' }]);
    expect(writes).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

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
    expect(embeddingBatches).toEqual([chunks, chunks].map((rows) => rows.map((row) => row.text)));
    expect(tokenizerReads).toBe(0); // The asset host can be unavailable throughout indexing.
  });

  it('fans out a large document through real Queue sends and skips completed batches on redelivery', async () => {
    await seedResource();
    await env.PAYLOADS.put('pipeline/body', documentBody.repeat(40));
    const result = await consume([resourceMessage()]);
    expect(result.explicitAcks).toEqual(['search-0']);
    const jobs = publishedEmbeddingJobs();
    expect(jobs.length).toBeGreaterThan(1);
    expect(jobs.every((job) => job.spans.length <= 64)).toBe(true);
    expect(embeddingBatches.map((batch) => batch.length)).toEqual(jobs.map((job) => job.spans.length));
    expect(liveRows().filter((row) => row.record_type === 'chunk')).toHaveLength(jobs.flatMap((job) => job.spans).length);
    const previousCalls = embeddingInputs.length;
    expect((await consume([jobs[0]])).explicitAcks).toEqual(['search-0']);
    expect(embeddingInputs).toHaveLength(previousCalls);
    const cleanup = writes.filter(({ body }) => JSON.stringify(body.delete_by_filter ?? null).includes('"Lt"'));
    expect(cleanup.length).toBeGreaterThan(0);
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]!.semanticCount).toBe(0);
    await consume([resourceMessage()]);
    expect([...indexed.values()].filter((row) => row.record_type === 'chunk')).toHaveLength(jobs.flatMap((job) => job.spans).length);
    expect(embeddingInputs).toHaveLength(previousCalls);
  });

  it('splits fan-out publication within the real Queue byte and message limits', async () => {
    await seedResource();
    await env.PAYLOADS.put('pipeline/body', documentBody.repeat(40));
    await consume([resourceMessage()], {}, false);
    const job = publishedEmbeddingJobs()[0]!;
    publish.mockClear();
    await publishSearchIndexingJobs(env.ACTIVITY_QUEUE, Array.from({ length: 101 }, () => ({ ...job, spans: job.spans.slice(0, 1) })));
    expect(publish.mock.calls.length).toBeGreaterThan(1);
    expect(publish.mock.calls.flatMap(([messages]) => [...messages])).toHaveLength(101);
  });

  it('splits below 100 messages when the serialized byte budget is reached', async () => {
    await seedResource();
    await env.PAYLOADS.put('pipeline/body', documentBody.repeat(40));
    await consume([resourceMessage()], {}, false);
    const job = publishedEmbeddingJobs()[0]!;
    const bytes = new TextEncoder().encode(JSON.stringify({ body: job, contentType: 'json' })).byteLength + 100;
    const count = Math.floor(256_000 / bytes) + 1;
    expect(count).toBeLessThan(100);
    publish.mockClear();
    await publishSearchIndexingJobs(env.ACTIVITY_QUEUE, Array.from({ length: count }, () => job));
    expect(publish.mock.calls.length).toBeGreaterThan(1);
    for (const [messages] of publish.mock.calls) {
      const total = [...messages].reduce((sum, message) => sum + new TextEncoder().encode(JSON.stringify(message)).byteLength + 100, 0);
      expect(total).toBeLessThanOrEqual(256_000);
    }
    expect(publish.mock.calls.flatMap(([messages]) => [...messages])).toHaveLength(count);
  });

  it('reclaims only the written generation when canonical text changes during the upsert', async () => {
    await seedResource();
    await consume([resourceMessage()], {}, false);
    const job = publishedEmbeddingJobs()[0]!;
    onWrite = async () => { await env.PAYLOADS.put('pipeline/body', 'changed after write'); };
    expect((await consume([job])).explicitAcks).toEqual(['search-0']);
    expect(liveRows().some((row) => row.record_type === 'chunk')).toBe(true);
    expect([...indexed.values()].filter((row) => row.record_type === 'chunk')).toEqual([]);
    expect(writes.some(({ body }) => JSON.stringify(body.delete_by_filter ?? null)
      .includes(JSON.stringify(['generation', 'Eq', job.generation])))).toBe(true);
  });

  it('retries only a failed child and preserves completed chunks out of order', async () => {
    await seedResource();
    await env.PAYLOADS.put('pipeline/body', documentBody.repeat(40));
    expect((await consume([resourceMessage()], {}, false)).explicitAcks).toEqual(['search-0']);
    const jobs = publishedEmbeddingJobs();
    expect(jobs.length).toBeGreaterThan(1);
    writes.length = 0;
    responseModel = 'different-model';
    expect((await consume([jobs[0]])).retryMessages).toEqual([{ msgId: 'search-0' }]);
    expect(liveRows().filter((row) => row.record_type === 'chunk')).toEqual([]);
    responseModel = 'Qwen/Qwen3-Embedding-8B';
    for (const job of jobs.slice(1).reverse()) expect((await consume([job])).explicitAcks).toEqual(['search-0']);
    expect(writes.some(({ body }) => JSON.stringify(body.delete_by_filter ?? null).includes('"Lt"'))).toBe(false);
    expect((await consume([jobs[0]])).explicitAcks).toEqual(['search-0']);
    expect(writes.some(({ body }) => JSON.stringify(body.delete_by_filter ?? null).includes('"Lt"'))).toBe(false);
    expect([...indexed.values()].filter((row) => row.record_type === 'chunk')).toHaveLength(jobs.flatMap((job) => job.spans).length);
  });

  it('retries malformed embedding jobs instead of acknowledging them as legacy messages', async () => {
    const result = await consume([{ type: 'search_embedding_batch_v1', spans: [] }]);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'search-0' }]);
    expect(writes).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('discards obsolete policies without multiplying source backfills and rejects wrong-region children', async () => {
    await seedResource();
    await consume([resourceMessage()], {}, false);
    const job = publishedEmbeddingJobs()[0]!;
    const send = vi.spyOn(env.ACTIVITY_QUEUE, 'send');
    writes.length = 0;
    expect((await consume([{ ...job, chunkPolicy: 'old-policy' }])).explicitAcks).toEqual(['search-0']);
    expect(send).not.toHaveBeenCalled();
    expect((await consume([{ ...job, reference: { ...job.reference, region: 'eu' } }])).retryMessages)
      .toEqual([{ msgId: 'search-0' }]);
    expect(writes).toEqual([]);
    expect(embeddingInputs).toEqual([]);
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

  it('discards a stale batch when deletion commits during embedding', async () => {
    const stub = await seedResource('avalon_generated');
    const revision = await stub.resourceSearchRevision({ workspaceId, resourceId });
    expect(revision).not.toBeNull();
    onEmbed = () => runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DELETE FROM resources WHERE id = ?', resourceId);
    });
    const result = await consume([resourceMessage()]);
    expect(result.explicitAcks).toEqual(['search-0']);
    expect(result.retryMessages).toEqual([]);
    expect([...indexed.values()].filter((row) => row.record_type === 'chunk')).toEqual([]);
    expect(writes.some(({ body }) => JSON.stringify(body.delete_by_filter ?? null).includes(JSON.stringify(['revision', 'Eq', revision])))).toBe(true);
    const retried = await consume([resourceMessage()]);
    expect(retried.explicitAcks).toEqual(['search-0']);
    expect(writes.some(({ body }) => JSON.stringify(body.delete_by_filter ?? null).includes(JSON.stringify(['revision', 'Lte', revision! + 1])))).toBe(true);
  });

  it('does not tombstone a live same-revision extraction change', async () => {
    await seedResource();
    onEmbed = async () => { await env.PAYLOADS.put('pipeline/body', 'updated body'); };
    const result = await consume([resourceMessage()]);
    expect(result.explicitAcks).toEqual(['search-0']);
    expect(result.retryMessages).toEqual([]);
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
    expect(result.explicitAcks).toEqual(['search-0']);
    const job = publishedEmbeddingJobs()[0]!;
    const child = await consume([job], { OPENROUTER_API_KEY: '' });
    expect(child.explicitAcks).toEqual([]);
    expect(child.retryMessages).toEqual([{ msgId: 'search-0' }]);
    expect(liveRows().some((row) => row.text.includes('gamma delta'))).toBe(true);
    expect(embeddingInputs).toEqual([]);
  });
});
