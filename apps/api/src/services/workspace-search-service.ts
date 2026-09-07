import type { SearchRequest, SearchResult } from '@rally/contracts/search';
import type { AuthContext, Env } from '../env';
import { ApiError } from '../lib/api-error';
import { IdSchema, SubstreamIdSchema } from '@rally/contracts';
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
  signal?.throwIfAborted();
  const sources: AuthorizedSearchSource<SearchResult>[] = [];
  if (request.category === 'all' || request.category === 'messages' || request.category === 'links') {
    if (request.category !== 'links') sources.push({ source: 'messages', scopeIds: null, load: async (candidates) => {
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
      for (const group of groups.values()) {
        signal?.throwIfAborted();
        try {
          const conversation = new ConversationService(env, auth);
          await conversation.authorizeViewer(group.parentId, group.substreamId);
          const record = await new WorkstreamObjectClient(env, auth, group.parentId, group.substreamId)
            .searchTurns(group.candidates.map((candidate) => candidate.turnId));
          // Recheck after the awaited canonical read, once per conversation.
          await conversation.authorizeViewer(group.parentId, group.substreamId);
          for (const candidate of group.candidates) {
            const turn = record.turns.find((value) => value.turnId === candidate.turnId);
            if (!turn || turn.revision !== candidate.revision) continue;
            const text = turn.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
            if (candidate.generation && await searchContentHash(text) !== candidate.generation) continue;
            const passage = matchingPassage(text, literalMatchRanges(text, request.query), PREVIEW_CONTEXT_CHARACTERS);
            if (!passage) continue;
            results.set(candidate.id, {
              id: candidate.id, category: 'messages', title: record.title, sourceLabel: record.title,
              occurredAt: turn.createdAtUtc, revision: String(turn.revision),
              excerpt: passage.excerpt, excerptStart: passage.excerptStart, highlights: passage.highlights,
              location: { kind: 'message', workstreamId: group.parentId, substreamId: group.substreamId,
                turnId: turn.turnId, transcriptSequence: turn.transcriptSequence, range: passage.range },
            });
          }
        } catch (error) { if (!denied(error)) throw error; }
      }
      return results;
    } });
    if (request.category !== 'messages') sources.push({ source: 'conversation_links', scopeIds: null, load: async (candidates) => {
      const results = new Map<string, SearchResult>();
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        const [substreamId, turnId, linkId] = candidate.source_id.split('/');
        if (!SubstreamIdSchema.safeParse(substreamId).success || !substreamId || !turnId || !linkId
          || !IdSchema.safeParse(candidate.scope_id).success) continue;
        try {
          await new ConversationService(env, auth).authorizeViewer(candidate.scope_id, substreamId);
          const record = await new WorkstreamObjectClient(env, auth, candidate.scope_id, substreamId).searchLink(turnId, linkId);
          if (!record.link || record.link.revision !== candidate.revision) continue;
          if (candidate.generation && await searchContentHash(record.link.text) !== candidate.generation) continue;
          const passage = matchingPassage(record.link.text, literalMatchRanges(record.link.text, request.query), PREVIEW_CONTEXT_CHARACTERS);
          if (!passage) continue;
          await new ConversationService(env, auth).authorizeViewer(candidate.scope_id, substreamId);
          results.set(candidate.id, { id: candidate.id, category: 'links', title: record.link.label,
            sourceLabel: record.title, occurredAt: null, revision: String(record.link.revision),
            excerpt: passage.excerpt, excerptStart: passage.excerptStart, highlights: passage.highlights,
            location: { kind: 'link', url: record.link.url, range: passage.range } });
        } catch (error) { if (!denied(error)) throw error; }
      }
      return results;
    } });
  }
  for (const category of ['links', 'artifacts', 'files'] as const) {
    if (request.category !== 'all' && request.category !== category) continue;
    sources.push({ source: category, scopeIds: [auth.workspaceId], load: async (candidates) => {
      const results = new Map<string, SearchResult>();
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        try {
          const record = await new ResourceService(env, auth).searchText(candidate.source_id);
          if (!record || Number(record.revision) !== candidate.revision) continue;
          const resource = record.resource;
          const actualCategory = resourceSearchCategory(resource.provider, resource.canonicalUrl);
          if (actualCategory !== category) continue;
          if (candidate.generation && await searchContentHash(record.text) !== candidate.generation) continue;
          const passage = matchingPassage(record.text, literalMatchRanges(record.text, request.query), PREVIEW_CONTEXT_CHARACTERS);
          if (!passage) continue;
          results.set(candidate.id, {
            id: candidate.id, category, title: resource.title, sourceLabel: resource.title,
            occurredAt: resource.updatedAt, revision: record.revision,
            excerpt: passage.excerpt, excerptStart: passage.excerptStart, highlights: passage.highlights,
            location: { kind: 'resource', resourceId: resource.id, mimeType: resource.mimeType, range: passage.range },
          });
        } catch (error) { if (!denied(error)) throw error; }
      }
      return results;
    } });
  }
  const index = await workspaceSearchIndex(env, auth.workspaceId);
  return index.query(sources, { query: request.query, mode: 'substring', limit: SEARCH_PAGE_SIZE, ...(signal ? { signal } : {}) });
}
