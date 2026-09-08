import { createAccessContext, requireAuthorizedRead } from './authorization-service';
import { WorkstreamDirectoryService } from './workstream-directory-service';
import { logInfo } from '../observability/logger';
import type { SearchRequest, SearchResult } from '@rally/contracts/search';
import type { AuthContext, Env } from '../env';
import { ApiError } from '../lib/api-error';
import { IdSchema, SubstreamIdSchema, asSubstreamId } from '@rally/contracts';
import { WorkstreamObjectClient } from './workstream-object-client';
import { ConversationService } from './conversation-service';
import { ResourceService } from './resource-service';
import { resourceSearchCategory } from './resource-search-text';
import { workspaceSearchIndex, searchContentHash, type TextSearchCandidate, type AuthorizedSearchSource } from './text-search';
import { literalMatchRanges, matchingPassage } from './search-passages';

/** Search uses the same 50-result page as the existing resource directory. */
const SEARCH_PAGE_SIZE = 50;
/** A two-line desktop result keeps 60 characters of context on each side. */
const PREVIEW_CONTEXT_CHARACTERS = 60;

function denied(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404);
}

export async function searchWorkspace(env: Env, auth: AuthContext, request: SearchRequest, signal?: AbortSignal): Promise<SearchResult[]> {
  return (await searchWorkspacePage(env, auth, request, signal)).results;
}

export async function searchWorkspacePage(env: Env, auth: AuthContext, request: SearchRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const started = performance.now();
  const access = createAccessContext(env, auth);
  const conversations = new ConversationService(env, auth);
  const parents = new Map<string, ReturnType<ConversationService['resolveParent']>>();
  const authorizeConversation = async (parentId: string, substreamId: string) => {
    const resource = { kind: 'conversation' as const, workspaceId: auth.workspaceId,
      parentId: IdSchema.parse(parentId), substreamId: asSubstreamId(substreamId) };
    requireAuthorizedRead(await access.check(resource));
    let parent = parents.get(parentId);
    if (!parent) { parent = conversations.resolveParent(parentId); parents.set(parentId, parent); }
    // Retain the existing automation conversation seating required by its product reader.
    // Policy evaluation itself remains read-only and runs before this compatibility action.
    if ((await parent).kind === 'automation') await conversations.authorizeViewer(parentId, substreamId);
  };
  const resources = new ResourceService(env, auth, undefined, access);
  const scopes = request.pageSize && ['all', 'messages', 'links'].includes(request.category)
    ? await new WorkstreamDirectoryService(env, auth).searchableIds() : null;
  const scopeMs = performance.now() - started;
  let retrievalMs = 0;
  let hydrationMs = 0;
  const sources: AuthorizedSearchSource<SearchResult>[] = [];
  if (request.category === 'all' || request.category === 'messages' || request.category === 'links') {
    if (request.category !== 'links') sources.push({ source: 'messages', scopeIds: scopes, load: async (candidates) => {
      const results = new Map<string, SearchResult>();
      const groups = new Map<string, { parentId: string; substreamId: string; candidates: Array<TextSearchCandidate & { turnId: string }> }>();
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        const separator = candidate.source_id.indexOf('/');
        if (separator < 0 || !IdSchema.safeParse(candidate.scope_id).success) continue;
        const substreamId = candidate.source_id.slice(0, separator);
        if (!SubstreamIdSchema.safeParse(substreamId).success) continue;
        const key = `${candidate.scope_id}/${substreamId}`;
        const group = groups.get(key) ?? { parentId: candidate.scope_id, substreamId, candidates: [] };
        group.candidates.push({ ...candidate, turnId: candidate.source_id.slice(separator + 1) });
        groups.set(key, group);
      }
      await Promise.all([...groups.values()].map(async (group) => {
        signal?.throwIfAborted();
        try {
          await authorizeConversation(group.parentId, group.substreamId);
          const record = await new WorkstreamObjectClient(env, auth, group.parentId, group.substreamId)
            .searchTurns(group.candidates.map((candidate) => candidate.turnId));
          const validated = new Map<string, SearchResult>();
          for (const candidate of group.candidates) {
            const turn = record.turns.find((value) => value.turnId === candidate.turnId);
            if (!turn || turn.revision !== candidate.revision) continue;
            const text = turn.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
            if (candidate.generation && await searchContentHash(text) !== candidate.generation) continue;
            const passage = matchingPassage(text, literalMatchRanges(text, request.query), PREVIEW_CONTEXT_CHARACTERS);
            if (!passage) continue;
            validated.set(candidate.id, {
              id: candidate.id, category: 'messages', title: record.title, sourceLabel: record.title,
              occurredAt: turn.createdAtUtc, revision: String(turn.revision),
              excerpt: passage.excerpt, excerptStart: passage.excerptStart, highlights: passage.highlights,
              location: { kind: 'message', workstreamId: group.parentId, substreamId: group.substreamId,
                turnId: turn.turnId, transcriptSequence: turn.transcriptSequence, range: passage.range },
            });
          }
          // Hashing is asynchronous too: authorize after all canonical validation.
          await authorizeConversation(group.parentId, group.substreamId);
          for (const [id, result] of validated) results.set(id, result);
        } catch (error) { if (!denied(error)) throw error; }
      }));
      return results;
    } });
    if (request.category !== 'messages') sources.push({ source: 'conversation_links', scopeIds: scopes, load: async (candidates) => {
      const results = new Map<string, SearchResult>();
      const groups = new Map<string, { parentId: string; substreamId: string;
        candidates: Array<{ candidate: TextSearchCandidate; turnId: string; linkId: string }> }>();
      for (const candidate of candidates) {
        const [substreamId, turnId, linkId] = candidate.source_id.split('/');
        if (!SubstreamIdSchema.safeParse(substreamId).success || !substreamId || !turnId || !linkId
          || !IdSchema.safeParse(candidate.scope_id).success) continue;
        const key = `${candidate.scope_id}/${substreamId}`;
        const group = groups.get(key) ?? { parentId: candidate.scope_id, substreamId, candidates: [] };
        group.candidates.push({ candidate, turnId, linkId });
        groups.set(key, group);
      }
      await Promise.all([...groups.values()].map(async (group) => {
        signal?.throwIfAborted();
        try {
          await authorizeConversation(group.parentId, group.substreamId);
          const record = await new WorkstreamObjectClient(env, auth, group.parentId, group.substreamId)
            .searchLinks(group.candidates.map(({ turnId, linkId }) => ({ turnId, linkId })));
          const validated = new Map<string, SearchResult>();
          for (const { candidate, linkId } of group.candidates) {
            const link = record.links.find((value) => value.linkId === linkId)?.link;
            if (!link || link.revision !== candidate.revision) continue;
            if (candidate.generation && await searchContentHash(link.text) !== candidate.generation) continue;
            const passage = matchingPassage(link.text, literalMatchRanges(link.text, request.query), PREVIEW_CONTEXT_CHARACTERS);
            if (!passage) continue;
            validated.set(candidate.id, { id: candidate.id, category: 'links', title: link.label,
              sourceLabel: record.title, occurredAt: null, revision: String(link.revision),
              excerpt: passage.excerpt, excerptStart: passage.excerptStart, highlights: passage.highlights,
              location: { kind: 'link', url: link.url, range: passage.range } });
          }
          // Hashing is asynchronous too: authorize after all canonical validation.
          await authorizeConversation(group.parentId, group.substreamId);
          for (const [id, result] of validated) results.set(id, result);
        } catch (error) { if (!denied(error)) throw error; }
      }));
      return results;
    } });
  }
  for (const category of ['links', 'artifacts', 'files'] as const) {
    if (request.category !== 'all' && request.category !== category) continue;
    sources.push({ source: category, scopeIds: [auth.workspaceId], load: async (candidates) => {
      const results = new Map<string, SearchResult>();
      await Promise.all(candidates.map(async (candidate) => {
        signal?.throwIfAborted();
        try {
          const record = await resources.searchText(candidate.source_id);
          if (!record || Number(record.revision) !== candidate.revision) return;
          const resource = record.resource;
          const actualCategory = resourceSearchCategory(resource.provider, resource.canonicalUrl);
          if (actualCategory !== category) return;
          if (candidate.generation && await searchContentHash(record.text) !== candidate.generation) return;
          const passage = matchingPassage(record.text, literalMatchRanges(record.text, request.query), PREVIEW_CONTEXT_CHARACTERS);
          if (!passage) return;
          results.set(candidate.id, {
            id: candidate.id, category, title: resource.title, sourceLabel: resource.title,
            occurredAt: resource.updatedAt, revision: record.revision,
            excerpt: passage.excerpt, excerptStart: passage.excerptStart, highlights: passage.highlights,
            location: { kind: 'resource', resourceId: resource.id, mimeType: resource.mimeType, range: passage.range },
          });
        } catch (error) { if (!denied(error)) throw error; }
      }));
      return results;
    } });
  }
  const index = await workspaceSearchIndex(env, auth.workspaceId);
  const options = { query: request.query, mode: 'substring' as const, limit: request.pageSize ?? SEARCH_PAGE_SIZE,
    ...(signal ? { signal } : {}), onTiming: (phase: 'retrieval' | 'hydration', ms: number) => {
      if (phase === 'retrieval') retrievalMs += ms;
      else hydrationMs += ms;
    } };
  const result = request.pageSize ? await index.queryPage(sources, options, request.cursor)
    : { results: await index.query(sources, options) };
  logInfo(env, 'search_response_timing', { scope_ms: scopeMs, retrieval_ms: retrievalMs,
    hydration_ms: hydrationMs, duration_ms: performance.now() - started, result_count: result.results.length,
    paginated: Boolean(request.pageSize), continuation: Boolean(request.cursor) });
  return request.pageSize ? { ...result, timings: { scopeMs, retrievalMs, hydrationMs,
    serverMs: performance.now() - started } } : result;
}
