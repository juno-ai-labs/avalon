import { logWarn } from "../observability/logger";
import { HttpUrlSchema } from '@rally/contracts/url-schemas';
import { AVALON_WEB_PLUGIN_ID } from '@rally/agent-harness';
import { z } from 'zod';
import type { TranscriptTurn } from '@rally/contracts';
import type { Env } from '../env';
import { assertSafePublicUrl } from '../lib/public-web-url';
import { searchDocumentId } from '../services/text-search';
import type { SearchDocumentBatch } from '../services/search-document';

export const CONVERSATION_LINK_SEARCH_SCHEMA = [
  `CREATE TABLE conversation_search_links (
    id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, url TEXT NOT NULL, label TEXT NOT NULL,
    markdown TEXT NOT NULL DEFAULT '', captured INTEGER NOT NULL DEFAULT 0 CHECK (captured IN (0, 1)),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    revision INTEGER NOT NULL CHECK (revision > 0)
  ) STRICT`,
  `CREATE INDEX conversation_search_links_turn ON conversation_search_links(turn_id)`,
];
export const SearchLinkSchema = z.object({ id: z.string(), turnId: z.string(), url: HttpUrlSchema, label: z.string(), text: z.string(), revision: z.number().int().positive() });
interface LinkRow extends Record<string, SqlStorageValue> {
  id: string; turn_id: string; url: string; label: string; markdown: string;
  captured: number; deleted: number; revision: number;
}

/** Public web access in a participant-visible tool record has the same audience as its turn. */
export function conversationLinks(turn: TranscriptTurn): Map<string, string> {
  const links = new Map<string, string>();
  const add = (url: string, label = url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') links.set(parsed.href, label);
    } catch { /* Ordinary prose, not a URL. */ }
  };
  for (const block of turn.blocks) {
    if (block.type === 'text') {
      for (const match of block.text.matchAll(/https?:\/\/[^\s<>"\]]+/gu)) {
        let end = match[0].length;
        let parentheses = 0;
        for (let index = 0; index < match[0].length; index += 1) {
          const character = match[0][index];
          if (character === '(') parentheses += 1;
          if (character === ')') {
            if (parentheses === 0) { end = index; break; }
            parentheses -= 1;
          }
        }
        const url = match[0].slice(0, end).replace(/[.,;!?]+$/u, '');
        const label = /\[([^\]]*)\]\($/u.exec(block.text.slice(0, match.index))?.[1];
        add(url, label || url);
      }
    } else if (block.type === 'tool' && block.status === 'completed'
      && block.pluginId === AVALON_WEB_PLUGIN_ID
      && (block.toolName === 'web_fetch' || block.toolName === 'web.fetch' || block.toolName === 'fetch')) {
      const input = z.object({ url: z.string() }).safeParse(block.participantSafeInput);
      if (input.success) add(input.data.url);
    }
  }
  return links;
}

export function readConversationSearchLink(sql: SqlStorage, id: string, turn: TranscriptTurn | null) {
  if (!turn) return null;
  const row = sql.exec<LinkRow>('SELECT * FROM conversation_search_links WHERE id = ? AND deleted = 0', id).toArray()[0];
  // A message edit can commit before its projection job runs. Never return the
  // previous label during that interval, even when the URL itself is unchanged.
  if (!row || row.turn_id !== turn.turnId || conversationLinks(turn).get(row.url) !== row.label) return null;
  return SearchLinkSchema.parse({ id: row.id, turnId: row.turn_id, url: row.url, label: row.label,
    text: [row.label, row.url, row.markdown].filter(Boolean).join('\n'), revision: row.revision });
}

/** Reconcile identity/labels without ever loading a captured body. */
async function reconcileConversationLinks(sql: SqlStorage,
  identity: { parentId: string; substreamId: string }, turnId: string,
  readTurn: () => TranscriptTurn | null,
): Promise<void> {
  const turn = readTurn();
  const links = turn ? conversationLinks(turn) : new Map<string, string>();
  const existing = sql.exec<Pick<LinkRow, 'id' | 'url' | 'deleted'>>('SELECT id, url, deleted FROM conversation_search_links WHERE turn_id = ?', turnId).toArray();
  for (const row of existing) {
    if (!links.has(row.url) && row.deleted === 0) {
      sql.exec('UPDATE conversation_search_links SET deleted = 1, markdown = ?, captured = 0, revision = revision + 1 WHERE id = ?', '', row.id);
    }
  }
  for (const [url, label] of links) {
    const id = await searchDocumentId('conversation_links', `${identity.parentId}/${identity.substreamId}/${turnId}`, url);
    sql.exec(`INSERT INTO conversation_search_links(id, turn_id, url, label, revision)
      VALUES (?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET label = excluded.label, deleted = 0,
        revision = conversation_search_links.revision + 1
      WHERE conversation_search_links.label != excluded.label OR conversation_search_links.deleted = 1`, id, turnId, url, label);
  }
}

export async function conversationSearchDocumentIds(sql: SqlStorage,
  identity: { parentId: string; substreamId: string }, turnId: string,
  readTurn: () => TranscriptTurn | null,
): Promise<string[]> {
  await reconcileConversationLinks(sql, identity, turnId, readTurn);
  // Retained deleted IDs must also publish their tombstone jobs.
  return sql.exec<{ id: string }>('SELECT id FROM conversation_search_links WHERE turn_id = ?', turnId)
    .toArray().map((row) => row.id);
}

/** Called by the durable projection Queue, never by message admission. */
export async function prepareConversationLinks(sql: SqlStorage, env: Env,
  identity: { workspaceId: string; parentId: string; substreamId: string }, turnId: string,
  readTurn: () => TranscriptTurn | null, capture = true, documentId?: string,
  // Read after capture, like the turn: the conversation the link lives in.
  readConversation: () => ConversationDisplay | null = () => null,
): Promise<SearchDocumentBatch> {
  await reconcileConversationLinks(sql, identity, turnId, readTurn);
  // A child must not load every sibling's captured body into its RPC payload.
  const rows = () => documentId === undefined
    ? sql.exec<LinkRow>('SELECT * FROM conversation_search_links WHERE turn_id = ?', turnId).toArray()
    : sql.exec<LinkRow>('SELECT * FROM conversation_search_links WHERE turn_id = ? AND id = ?', turnId, documentId).toArray();
  let captureFailed = false;
  for (const row of rows()) {
    if (!capture || row.deleted) continue;
    if (row.captured) continue;
    try { assertSafePublicUrl(row.url); } catch { continue; }
    let captureStatus: number | undefined;
    let captureCode: number | undefined;
    try {
      if (!env.BROWSER) throw new Error('browser_run_unavailable');
      const response = await env.BROWSER.quickAction('markdown', { url: row.url, gotoOptions: { waitUntil: 'networkidle2' } });
      captureStatus = response.status;
      const body: unknown = await response.json();
      const failure = z.object({ errors: z.array(z.object({ code: z.number() })).optional() }).safeParse(body);
      if (failure.success) captureCode = failure.data.errors?.[0]?.code;
      if (!response.ok) throw new Error('browser_run_capture_failed');
      const payload = z.object({ success: z.literal(true), result: z.string() }).parse(body);
      if (!readConversationSearchLink(sql, row.id, readTurn())) continue;
      sql.exec(`UPDATE conversation_search_links SET markdown = ?, captured = 1, revision = revision + 1
        WHERE id = ? AND revision = ? AND deleted = 0`, payload.result, row.id, row.revision);
    } catch {
      captureFailed = true;
      logWarn(env, 'search_link_capture_failed', {
        workspace_id: identity.workspaceId, workstream_id: identity.parentId,
        substream_id: identity.substreamId, link_id: row.id,
        http_status: captureStatus, provider_code: captureCode,
      });
    }
  }
  const documents: SearchDocumentBatch['documents'] = [];
  const conversation = readConversation();
  for (const row of rows()) {
    const current = readConversationSearchLink(sql, row.id, readTurn());
    if (!current && !row.deleted) { captureFailed = true; continue; }
    documents.push({ id: row.id, source: 'conversation_links',
      sourceId: `${identity.substreamId}/${turnId}/${row.id}`, scopeId: identity.parentId,
      substreamId: identity.substreamId,
      revision: current?.revision ?? row.revision, text: current?.text ?? null,
      ...(current && conversation ? { display: { title: current.label, sourceLabel: conversation.title,
        occurredAt: null, transcriptSequence: null, url: current.url, mimeType: null, archived: conversation.archived } } : {}) });
  }
  return { documents, retry: captureFailed };
}

/** The conversation a link or message belongs to, as its result renders it. */
export interface ConversationDisplay { title: string; archived: boolean }
