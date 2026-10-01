import type { ConversationFile, SessionImportPreview } from '@rally/contracts';
import {
  BrowserImportMessagesSchema,
  DesktopActionRequestSchema,
  type DesktopActionOutcome,
  type SessionImportFailureReason,
} from '@rally/contracts/desktop-actions';
import { describeZodIssues } from '@rally/contracts/zod-diagnostics';

import type { RallyDesktopBridge } from '../../common/desktop';
import type { RallyApi } from './api';
import { conversationAt, providerSiteAllows, type BrowserConversationProvider } from './browser-conversation';
import { createDesktopActionExecutor } from './desktop-actions/executor';
import { DesktopActionStore } from './desktop-actions/store';
import { createRealtimeSocket, type RealtimeSocket } from './realtime-socket';

const TYPE_EXTENSIONS: Record<string, string> = {
  'text/markdown': '.md', 'text/html': '.html', 'application/json': '.json', 'image/svg+xml': '.svg',
  'text/csv': '.csv', 'text/javascript': '.js', 'text/x-python': '.py', 'text/css': '.css',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf',
};

/** A titled file — a generated image, a report — is named so it opens as its type. */
function withExtension(name: string, mimeType: string): string {
  return /\.[a-z0-9]{1,5}$/iu.test(name) ? name : `${name}${TYPE_EXTENSIONS[mimeType] ?? ''}`;
}

/**
 * The conversation the agent stored, as the import request Rally validates.
 *
 * Throws with the field that is wrong, which the finish action hands back to
 * the agent so it can fix and store the messages again.
 */
export function assemblePreview(
  store: DesktopActionStore,
  input: { title: string; messagesHandle: string; source: SessionImportPreview['source'] },
): SessionImportPreview {
  const stored = store.get(input.messagesHandle);
  if (!stored) throw new Error(`No stored value has the handle ${input.messagesHandle}.`);
  if (stored.ref.kind !== 'json') throw new Error(`${input.messagesHandle} is a file; store the messages array as JSON.`);
  const parsed = BrowserImportMessagesSchema.safeParse(JSON.parse(stored.data));
  if (!parsed.success) throw new Error(`The stored messages do not match the import format: ${describeZodIssues(parsed.error)}`);
  const ids = parsed.data.map((message) => message.sourceMessageId);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`sourceMessageId ${duplicate} appears more than once.`);
  const messages = parsed.data.map((message, index) => {
    const files = (message.files ?? []).map((file): ConversationFile => {
      if ('unavailable' in file) {
        return { name: file.unavailable.name, mimeType: 'application/octet-stream', kind: message.role === 'user' ? 'attachment' : 'artifact',
          source: { kind: 'unavailable', reference: file.unavailable.name, reason: file.unavailable.reason } };
      }
      const item = store.get(file.handle);
      if (!item) throw new Error(`Message ${index + 1} names file handle ${file.handle}, which no stored value has.`);
      const mimeType = file.mimeType ?? item.ref.mimeType;
      return {
        name: withExtension(file.name ?? item.ref.name, mimeType),
        mimeType,
        kind: file.kind ?? (message.role === 'user' ? 'attachment' : 'artifact'),
        source: item.ref.kind === 'json'
          ? { kind: 'inline', encoding: 'utf8', data: item.data }
          : { kind: 'inline', encoding: 'base64', data: item.data },
      };
    });
    if (!message.text.trim() && files.length === 0) throw new Error(`Message ${index + 1} has no text and no files.`);
    return { role: message.role, text: message.text, sourceMessageId: message.sourceMessageId, ...(files.length ? { files } : {}) };
  });
  return { title: input.title, source: input.source, content: { messages } };
}

export type SessionImportApi = Pick<RallyApi,
  'startSessionImport' | 'startSessionImportUpdate' | 'completeSessionImport' | 'discardSessionImport'
  | 'updateImportedSession' | 'importedSessionSource' | 'getSocketTicket'>;

export type SessionImportMode =
  | { kind: 'create'; title: string; spaceIds: string[]; clientMessageId: string }
  | { kind: 'update'; workstreamId: string };

export type SessionImportRunResult =
  | { kind: 'imported'; workstreamId: string }
  | { kind: 'failed'; reason: SessionImportFailureReason }
  | { kind: 'unfinished' }
  /** The person cancelled; nothing to explain. */
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

/** What the person reads when the agent says the conversation cannot be read. Rally's words, never the page's. */
export const SESSION_IMPORT_FAILURE_COPY: Record<SessionImportFailureReason, string> = {
  sign_in_required: 'Sign in to the conversation’s site in this window, then import again.',
  not_a_conversation: 'This tab does not show a conversation. Open one, then import again.',
  page_unavailable: 'The conversation’s page would not load. Reload it, then import again.',
};

const ENDED = new Set(['completed', 'failed', 'stopped', 'needs_input', 'idle']);

export interface SessionImportRun {
  readonly done: Promise<SessionImportRunResult>;
  /** Stop the agent; a new Channel that never opened is discarded. */
  cancel(): Promise<void>;
}

/**
 * Run one conversation import from this window.
 *
 * Starts the agent on the API, opens its hidden conversation's socket, and
 * answers every desktop action it asks for on the pinned tab. The finish
 * action is where this window does its part: it assembles what the agent
 * stored into the import request and hands it to Rally, creating the Channel
 * or adding to it, and tells the agent what Rally said.
 */
export function startSessionImportRun(input: {
  api: SessionImportApi;
  bridge: Pick<RallyDesktopBridge, 'getEmbeddedBrowserState' | 'commandEmbeddedBrowser'>;
  tabId: string;
  sourceUrl: string;
  mode: SessionImportMode;
  onProgress?: (step: { label: string; steps: number }) => void;
}): SessionImportRun {
  const conversation = conversationAt(input.sourceUrl, '');
  const provider: BrowserConversationProvider | null = conversation?.provider ?? null;
  const store = new DesktopActionStore();
  let settle: (result: SessionImportRunResult) => void = () => undefined;
  const done = new Promise<SessionImportRunResult>((resolve) => { settle = resolve; });
  let finished = false;
  let cancelled = false;
  let socket: RealtimeSocket | null = null;
  let run: { workstreamId: string; substreamId: string } | null = null;
  let steps = 0;
  /** How the run ends once the action that decided it has been answered. */
  let ending: SessionImportRunResult | null = null;
  const finish = (result: SessionImportRunResult) => {
    if (finished) return;
    finished = true;
    socket?.close(1000, 'import ended');
    // A new Channel that will never open is discarded rather than left listed.
    if (result.kind !== 'imported' && result.kind !== 'cancelled') void discard();
    settle(result);
  };

  const executor = createDesktopActionExecutor({
    bridge: input.bridge,
    tabId: input.tabId,
    siteAllows: (url) => provider !== null && providerSiteAllows(provider, url),
    store,
    handlers: {
      'session_import.finish': async (action): Promise<DesktopActionOutcome> => {
        if (!run || !conversation) return { ok: false, code: 'import_rejected', message: 'The import has not started.' };
        let preview: SessionImportPreview;
        try {
          const source = input.mode.kind === 'update'
            ? await input.api.importedSessionSource(run.workstreamId)
            : { provider: conversation.provider, url: conversation.url, sessionId: conversation.id };
          if (!source || source.provider === 'claude_code') {
            return { ok: false, code: 'import_rejected', message: 'This channel has no source conversation to update.' };
          }
          preview = assemblePreview(store, {
            title: input.mode.kind === 'create' ? input.mode.title : action.title,
            messagesHandle: action.messages,
            source: { provider: source.provider, url: source.url, sessionId: source.sessionId },
          });
        } catch (error) {
          return { ok: false, code: 'invalid_conversation', message: error instanceof Error ? error.message : String(error) };
        }
        try {
          if (input.mode.kind === 'create') {
            await input.api.completeSessionImport(run.workstreamId, preview, {
              clientMessageId: input.mode.clientMessageId, spaceIds: input.mode.spaceIds,
            });
          } else {
            await input.api.updateImportedSession(run.workstreamId, preview, crypto.randomUUID());
          }
        } catch (error) {
          return { ok: false, code: 'import_rejected', message: error instanceof Error ? error.message : 'Rally refused the import.' };
        }
        ending = { kind: 'imported', workstreamId: run.workstreamId };
        return { ok: true, result: { workstreamId: run.workstreamId, messages: preview.content.messages.length } };
      },
      'session_import.fail': async (action) => {
        ending = { kind: 'failed', reason: action.reason };
        return { ok: true, result: {} };
      },
    },
  });

  // One action at a time, each answered once: a re-offered action this window
  // is already running, or has answered, is not run again.
  const seen = new Set<string>();
  let queue = Promise.resolve();
  const onFrame = (raw: string) => {
    let frame: { type?: string; request?: unknown; invocation?: { toolName?: string }; status?: string };
    try { frame = JSON.parse(raw) as typeof frame; } catch { return; }
    if (frame.type === 'desktop_action_requested') {
      const parsed = DesktopActionRequestSchema.safeParse(frame.request);
      if (!parsed.success || seen.has(parsed.data.id)) return;
      seen.add(parsed.data.id);
      const request = parsed.data;
      queue = queue.then(async () => {
        const outcome = await executor.execute(request.action);
        // Answered before the run is ended here, so the agent's tool returns
        // instead of waiting on a socket this window has closed.
        socket?.send(JSON.stringify({ type: 'answer_desktop_action', actionId: request.id, outcome }));
        if (ending) finish(ending);
      });
    } else if (frame.type === 'tool_started') {
      steps += 1;
      input.onProgress?.({ label: frame.invocation?.toolName ?? 'Working', steps });
    } else if (frame.type === 'harness_status_changed' && frame.status && ENDED.has(frame.status) && steps > 0) {
      // Finishing answers before the run ends; an end with no finish means the agent gave up.
      void queue.then(() => finish({ kind: 'unfinished' }));
    }
  };

  const connect = async (): Promise<void> => {
    if (!run || finished || cancelled) return;
    const ticket = await input.api.getSocketTicket(run.workstreamId, run.substreamId);
    const next = createRealtimeSocket('substream_feed', ticket.url, ticket.protocols);
    socket = next;
    next.addEventListener('open', () => next.send(JSON.stringify({ type: 'subscribe', afterSequence: 0, publishPresence: false })));
    next.addEventListener('message', (event) => onFrame(event.data));
    next.addEventListener('close', () => {
      if (socket !== next || finished || cancelled) return;
      // A dropped socket loses nothing: unanswered actions are offered again
      // to the next subscription. The person ends a stuck import with Cancel.
      setTimeout(() => { void connect().catch((error: unknown) => finish({ kind: 'error', message: messageOf(error) })); }, 1_000);
    });
  };

  async function discard() {
    if (!run) return;
    await input.api.discardSessionImport(run.workstreamId, {
      substreamId: run.substreamId,
      clientMessageId: input.mode.kind === 'create' ? input.mode.clientMessageId : null,
    }).catch(() => undefined);
  }

  void (async () => {
    try {
      run = input.mode.kind === 'create'
        ? await input.api.startSessionImport({ sourceUrl: input.sourceUrl, title: input.mode.title, spaceIds: input.mode.spaceIds,
          clientMessageId: input.mode.clientMessageId })
        : await input.api.startSessionImportUpdate(input.mode.workstreamId);
      if (cancelled) {
        await discard();
        return;
      }
      await connect();
    } catch (error) {
      finish({ kind: 'error', message: messageOf(error) });
    }
  })();

  return {
    done,
    async cancel() {
      if (finished) return;
      cancelled = true;
      await discard();
      finish({ kind: 'cancelled' });
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'The import could not start.';
}
