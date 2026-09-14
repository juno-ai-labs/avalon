import { createSearchAccessContext, type DeferredWork } from './search-authorization';
import { logInfo } from '../observability/logger';
import type { SearchRequest, SearchResult } from '@rally/contracts/search';
import type { AuthContext, Env } from '../env';
import { IdSchema, SubstreamIdSchema, asSubstreamId } from '@rally/contracts';
import { HttpUrlSchema } from '@rally/contracts/url-schemas';
import { workspaceSearchIndex, type TextSearchCandidate, type AuthorizedSearchSource } from './text-search';
import { literalMatchRanges, matchingPassage } from './search-passages';

/** Search uses the same 50-result page as the existing resource directory. */
const SEARCH_PAGE_SIZE = 50;
/** A two-line desktop result keeps 60 characters of context on each side. */
const PREVIEW_CONTEXT_CHARACTERS = 60;

interface ConversationGroup { parentId: string; substreamId: string; candidates: TextSearchCandidate[] }

export async function searchWorkspace(env: Env, auth: AuthContext, request: SearchRequest, signal?: AbortSignal,
  defer?: DeferredWork): Promise<SearchResult[]> {
  return (await searchWorkspacePage(env, auth, request, signal, defer)).results;
}

/**
 * One candidate page, admitted through the projected search decisions and
 * rendered from the index's own attributes. Nothing here reads a content
 * owner (WorkstreamDO, SubstreamAgent) or R2; admission reads KV in Global and
 * the WorkspaceDO snapshot table in regional, one warm object. The projection is
 * registered from the mutation side, so a decision exists before the search
 * that needs it; one the projection still lacks is omitted and filled after
 * the response (`defer`), and a row indexed before the display attributes
 * existed is omitted until its queued rewrite lands. Not finding something is
 * the safe failure; the page never reports which candidates it left out.
 */
export async function searchWorkspacePage(env: Env, auth: AuthContext, request: SearchRequest, signal?: AbortSignal,
  defer?: DeferredWork) {
  signal?.throwIfAborted();
  const started = performance.now();
  const access = createSearchAccessContext(env, auth, defer);
  const readableGroups = async (groups: ConversationGroup[]) => {
    const decisions = await access.checkMany(groups.map((group) => ({ kind: 'conversation' as const,
      workspaceId: auth.workspaceId, parentId: IdSchema.parse(group.parentId), substreamId: asSubstreamId(group.substreamId) })));
    return groups.filter((_, index) => decisions[index]!.status === 'allowed');
  };
  const scopeMs = performance.now() - started;
  let retrievalMs = 0;
  let hydrationMs = 0;
  const passageOf = (text: string) => matchingPassage(text, literalMatchRanges(text, request.query), PREVIEW_CONTEXT_CHARACTERS);
  const displayTime = (value: number | null | undefined) => typeof value === 'number' ? new Date(value).toISOString() : null;
  const messageResult = (group: ConversationGroup, candidate: TextSearchCandidate): SearchResult | null => {
    const separator = candidate.source_id.indexOf('/');
    const turnId = separator < 0 ? '' : candidate.source_id.slice(separator + 1);
    if (!turnId || candidate.archived !== false || typeof candidate.text !== 'string' || typeof candidate.title !== 'string'
      || typeof candidate.occurred_at !== 'number' || typeof candidate.transcript_sequence !== 'number') return null;
    const passage = passageOf(candidate.text);
    if (!passage) return null;
    return {
      id: candidate.id, category: 'messages', title: candidate.title, sourceLabel: candidate.source_label ?? candidate.title,
      occurredAt: displayTime(candidate.occurred_at), revision: String(candidate.revision),
      excerpt: passage.excerpt, excerptStart: passage.excerptStart, highlights: passage.highlights,
      location: { kind: 'message', workstreamId: group.parentId, substreamId: group.substreamId,
        turnId, transcriptSequence: candidate.transcript_sequence, range: passage.range },
    };
  };
  const linkResult = (candidate: TextSearchCandidate): SearchResult | null => {
    const url = HttpUrlSchema.safeParse(candidate.url);
    if (candidate.archived !== false || typeof candidate.text !== 'string' || typeof candidate.title !== 'string' || !url.success) return null;
    const passage = passageOf(candidate.text);
    if (!passage) return null;
    return { id: candidate.id, category: 'links', title: candidate.title, sourceLabel: candidate.source_label ?? '',
      occurredAt: null, revision: String(candidate.revision),
      excerpt: passage.excerpt, excerptStart: passage.excerptStart, highlights: passage.highlights,
      location: { kind: 'link', url: url.data, range: passage.range } };
  };
  // Messages and links are admitted per conversation; the decision is the projected one.
  const conversationSource = (source: 'messages' | 'conversation_links'): AuthorizedSearchSource<SearchResult> => ({
    source, scopeIds: null, load: async (candidates) => {
      const results = new Map<string, SearchResult>();
      const groups = new Map<string, ConversationGroup>();
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        // Rows written before `substream_id` existed still name the substream first in `source_id`.
        const substreamId = candidate.substream_id ?? candidate.source_id.slice(0, Math.max(0, candidate.source_id.indexOf('/')));
        if (!SubstreamIdSchema.safeParse(substreamId).success || !IdSchema.safeParse(candidate.scope_id).success) continue;
        const key = `${candidate.scope_id}/${substreamId}`;
        const group = groups.get(key) ?? { parentId: candidate.scope_id, substreamId, candidates: [] };
        group.candidates.push(candidate);
        groups.set(key, group);
      }
      for (const group of await readableGroups([...groups.values()])) {
        for (const candidate of group.candidates) {
          const result = source === 'messages' ? messageResult(group, candidate) : linkResult(candidate);
          if (result) results.set(candidate.id, result);
        }
      }
      return results;
    },
  });
  const sources: AuthorizedSearchSource<SearchResult>[] = [];
  if (request.category === 'all' || request.category === 'messages') sources.push(conversationSource('messages'));
  if (request.category === 'all' || request.category === 'links') sources.push(conversationSource('conversation_links'));
  for (const category of ['links', 'artifacts', 'files'] as const) {
    if (request.category !== 'all' && request.category !== category) continue;
    sources.push({ source: category, scopeIds: [auth.workspaceId], load: async (candidates) => {
      const results = new Map<string, SearchResult>();
      const admitted = candidates.filter((candidate) => IdSchema.safeParse(candidate.source_id).success
        && (candidate.connection_id == null || IdSchema.safeParse(candidate.connection_id).success));
      // A connector's rows share one decision, read once; an attachment or note has its own.
      const addresses = admitted.map((candidate) => candidate.connection_id != null
        ? { kind: 'connection' as const, workspaceId: auth.workspaceId, connectionId: IdSchema.parse(candidate.connection_id) }
        : { kind: 'resource' as const, workspaceId: auth.workspaceId, resourceId: IdSchema.parse(candidate.source_id) });
      const unique = [...new Map(addresses.map((address) => [JSON.stringify(address), address])).values()];
      const decisions = new Map((await access.checkMany(unique)).map((decision, index) => [JSON.stringify(unique[index]), decision]));
      admitted.forEach((candidate, index) => {
        signal?.throwIfAborted();
        if (decisions.get(JSON.stringify(addresses[index]))?.status !== 'allowed' || typeof candidate.text !== 'string' || typeof candidate.title !== 'string') return;
        const passage = passageOf(candidate.text);
        if (!passage) return;
        results.set(candidate.id, {
          id: candidate.id, category, title: candidate.title, sourceLabel: candidate.source_label ?? candidate.title,
          occurredAt: displayTime(candidate.occurred_at), revision: String(candidate.revision),
          excerpt: passage.excerpt, excerptStart: passage.excerptStart, highlights: passage.highlights,
          location: { kind: 'resource', resourceId: candidate.source_id, mimeType: candidate.mime_type ?? null, range: passage.range },
        });
      });
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
