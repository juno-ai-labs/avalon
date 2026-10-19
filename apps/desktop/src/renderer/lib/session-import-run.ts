import { safeParseSocketEvent, ServerSocketEventSchema, type ConversationFile, type SessionImportPreview, type TelemetryEventProperties } from '@rally/contracts';
import {
  BrowserImportMessagesSchema,
  verifySessionImport,
  type DesktopActionOutcome,
  type SessionImportFailureReason,
} from '@rally/contracts/desktop-actions';
import { describeZodIssues } from '@rally/contracts/zod-diagnostics';

import type { RallyDesktopBridge } from '../../common/desktop';
import type { RallyApi } from './api';
import { conversationAt } from './browser-conversation';
import { createDesktopActionExecutor } from '../../common/desktop-actions/executor';
import { DesktopActionStore } from '../../common/desktop-actions/store';
import { createRealtimeSocket, type RealtimeSocket } from './realtime-socket';
import { reportTelemetryProductIntent } from './telemetry';

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
  // A chat with no reply is never what a provider shows; an import that has
  // none dropped them, often a report held where the reader did not look.
  if (!parsed.data.some((message) => message.role === 'assistant')) {
    throw new Error('The stored messages have no assistant reply. Find the replies the page shows, including any report or document a tool produced, and store them too.');
  }
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
  | 'abandonSessionImport' | 'startBreakoutImport' | 'completeBreakoutImport'
  | 'updateImportedSession' | 'importedSessionSource' | 'getSocketTicket'>
  & Partial<Pick<RallyApi, 'confirmSocketTicket'>>;

export type SessionImportMode =
  | { kind: 'create'; title: string; spaceIds: string[]; clientMessageId: string }
  | { kind: 'update'; workstreamId: string }
  /** A new Breakout of an existing thread. */
  | { kind: 'breakout'; workstreamId: string; title: string; clientMessageId: string };

export type SessionImportRunResult =
  /** `substreamId` names the Breakout a breakout import opened. */
  | { kind: 'imported'; workstreamId: string; substreamId?: string }
  | { kind: 'failed'; reason: SessionImportFailureReason }
  /** The run ended without a finish; `refusal` is Rally's last answer to one it tried, if any. */
  | { kind: 'unfinished'; refusal?: string }
  /** The person cancelled; nothing to explain. */
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

/** What the person reads when the agent says the conversation cannot be read. Rally's words, never the page's. */
export const SESSION_IMPORT_FAILURE_COPY: Record<SessionImportFailureReason, string> = {
  sign_in_required: 'Sign in to the conversation’s site in this window, then import again.',
  not_a_conversation: 'This tab does not show a conversation. Open one, then import again.',
  page_unavailable: 'The conversation’s page would not load. Reload it, then import again.',
  unreadable: 'Rally could not read this conversation’s messages from the page.',
};

const ENDED = new Set(['completed', 'failed', 'stopped', 'needs_input', 'idle']);

/**
 * One thing the agent did, as the import window lists it: the harness's own
 * words for the step while it runs, then the tool's summary of what it did.
 */
export interface SessionImportStep {
  id: string;
  label: string;
  status: 'running' | 'done' | 'failed';
}

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
  /** Every step so far, oldest first, each time one starts or ends. */
  onSteps?: (steps: readonly SessionImportStep[]) => void;
  /**
   * The run exists: for a new import, the API has reserved its Channel under
   * `workstreamId`; `substreamId` is the agent's hidden conversation.
   */
  onStarted?: (run: { workstreamId: string; substreamId: string }) => void;
}): SessionImportRun {
  const conversation = conversationAt(input.sourceUrl, '');
  const store = new DesktopActionStore();
  let settle: (result: SessionImportRunResult) => void = () => undefined;
  const done = new Promise<SessionImportRunResult>((resolve) => { settle = resolve; });
  let finished = false;
  let cancelled = false;
  let socket: RealtimeSocket | null = null;
  let run: { workstreamId: string; substreamId: string } | null = null;
  const steps: SessionImportStep[] = [];
  /**
   * Whether the agent's run has begun. The subscription can open on the
   * conversation's earlier, idle status, which is not this run ending; a run
   * that has started and then ends without a finish gave up, however many
   * steps it took — including none.
   */
  let started = false;
  /** A step's row, once: a resubscribed socket replays frames already listed. */
  const recordStep = (id: string, next: (current: SessionImportStep | undefined) => SessionImportStep) => {
    const at = steps.findIndex((step) => step.id === id);
    if (at === -1) steps.push(next(undefined));
    else steps[at] = next(steps[at]);
    input.onSteps?.([...steps]);
  };
  /** How the run ends once the action that decided it has been answered. */
  let ending: SessionImportRunResult | null = null;
  /** Rally's own words the last time it refused the agent's finish. */
  let refusal: string | null = null;
  /** The finish's answer once the Channel opened, repeated to a retried finish. */
  let imported: { workstreamId: string; messages: number } | null = null;
  const actionClocks = new Map<string, number>();
  const pendingActions = new Set<string>();
  let activeActionId: string | null = null;
  let completingImport = false;
  let runEnded = false;
  const observe = (actionId: string, phase: TelemetryEventProperties<'desktop_action_phase'>['phase']) => {
    reportTelemetryProductIntent({
      kind: 'desktop_action_phase', actionId, phase,
      elapsedMs: Math.max(0, Math.round(performance.now() - (actionClocks.get(actionId) ?? performance.now()))),
      windowVisible: document.visibilityState === 'visible',
    });
  };
  const finish = (result: SessionImportRunResult) => {
    if (finished) return;
    finished = true;
    executor.dispose();
    for (const actionId of pendingActions) observe(actionId, 'run_ended');
    socket?.close(1000, 'import ended');
    // A new Channel that will never open is discarded rather than left listed.
    if (result.kind !== 'imported' && result.kind !== 'cancelled') void discard();
    settle(result);
  };

  const executor = createDesktopActionExecutor({
    bridge: input.bridge,
    tabId: input.tabId,
    store,
    onPhase: (phase) => { if (activeActionId) observe(activeActionId, phase); },
    handlers: {
      'session_import.finish': async (action): Promise<DesktopActionOutcome> => {
        if (!run || !conversation) return { ok: false, code: 'import_rejected', message: 'The import has not started.' };
        // A repeated finish after the Channel opened changes nothing, and is told so in the same words.
        if (imported) return { ok: true, result: imported };
        if (finished || cancelled || runEnded) return { ok: false, code: 'import_rejected', message: 'The import run has ended.' };
        let preview: SessionImportPreview;
        try {
          const source = input.mode.kind === 'update'
            ? await input.api.importedSessionSource(run.workstreamId)
            : { provider: conversation.provider, url: conversation.url, sessionId: conversation.id };
          if (!source || source.provider === 'claude_code') {
            return { ok: false, code: 'import_rejected', message: 'This thread has no source conversation to update.' };
          }
          preview = assemblePreview(store, {
            title: input.mode.kind === 'update' ? action.title : input.mode.title,
            messagesHandle: action.messages,
            source: { provider: source.provider, url: source.url, sessionId: source.sessionId },
          });
          verifySessionImport(preview.content.messages, action.verification);
        } catch (error) {
          return { ok: false, code: 'invalid_conversation', message: error instanceof Error ? error.message : String(error) };
        }
        if (finished || cancelled || runEnded) return { ok: false, code: 'import_rejected', message: 'The import run has ended.' };
        completingImport = true;
        let breakoutId: string | undefined;
        try {
          if (input.mode.kind === 'breakout') {
            breakoutId = await input.api.completeBreakoutImport(run.workstreamId, preview, { clientMessageId: input.mode.clientMessageId });
          } else if (input.mode.kind === 'create') {
            await input.api.completeSessionImport(run.workstreamId, preview, {
              clientMessageId: input.mode.clientMessageId, spaceIds: input.mode.spaceIds,
            });
          } else {
            await input.api.updateImportedSession(run.workstreamId, preview, crypto.randomUUID());
          }
        } catch (error) {
          refusal = error instanceof Error && error.message.trim() ? error.message : 'Rally refused the import.';
          return { ok: false, code: 'import_rejected', message: refusal };
        } finally {
          completingImport = false;
        }
        ending = { kind: 'imported', workstreamId: run.workstreamId, ...(breakoutId ? { substreamId: breakoutId } : {}) };
        imported = { workstreamId: run.workstreamId, messages: preview.content.messages.length };
        return { ok: true, result: imported };
      },
      'session_import.fail': async (action) => {
        // An opened Channel stays the ending; a later give-up cannot unlist it.
        if (ending?.kind !== 'imported') ending = { kind: 'failed', reason: action.reason };
        return { ok: true, result: {} };
      },
    },
  });

  // One action at a time, each run once. A re-offered action this window is
  // still running is ignored; one it has answered gets the same answer again,
  // because the room re-offers exactly the actions whose answer it never got.
  const seen = new Set<string>();
  const answers = new Map<string, DesktopActionOutcome>();
  const answer = (id: string, outcome: DesktopActionOutcome) => {
    if (finished || cancelled) return;
    try {
      socket?.send(JSON.stringify({ type: 'answer_desktop_action', actionId: id, outcome }));
      observe(id, 'answer_sent');
    } catch {
      observe(id, 'answer_deferred');
      // The socket is between connections; the room offers this action again
      // on the next one, and the stored answer goes then.
    }
  };
  let queue = Promise.resolve();
  const onFrame = (raw: string, confirmLive?: () => void) => {
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { return; }
    // A frame this window cannot read is one it has no part in.
    const parsed = safeParseSocketEvent(ServerSocketEventSchema, decoded);
    if (!parsed.success) return;
    const frame = parsed.data;
    if ('sequence' in frame) confirmLive?.();
    if (frame.type === 'desktop_action_requested') {
      const request = frame.request;
      if (finished || cancelled || runEnded) return;
      if (!actionClocks.has(request.id)) {
        actionClocks.set(request.id, performance.now());
        observe(request.id, 'received');
      } else observe(request.id, 'reoffered');
      const answered = answers.get(request.id);
      if (answered) {
        answer(request.id, answered);
        return;
      }
      if (seen.has(request.id)) return;
      seen.add(request.id);
      pendingActions.add(request.id);
      queue = queue.then(async () => {
        if (finished || cancelled || runEnded) return;
        activeActionId = request.id;
        observe(request.id, 'execution_started');
        try {
          const outcome = await executor.execute(request.action);
          observe(request.id, outcome.ok ? 'execution_completed' : 'execution_failed');
          answers.set(request.id, outcome);
          answer(request.id, outcome);
        } catch {
          observe(request.id, 'execution_failed');
          const outcome: DesktopActionOutcome = { ok: false, code: 'browser_command_failed', message: 'The desktop action could not complete.' };
          answers.set(request.id, outcome);
          answer(request.id, outcome);
        } finally {
          pendingActions.delete(request.id);
          activeActionId = null;
          if (runEnded && !finished) finish(ending?.kind === 'imported' ? ending : refusal ? { kind: 'unfinished', refusal } : { kind: 'unfinished' });
        }
      });
    } else if (frame.type === 'tool_started' || frame.type === 'tool_completed' || frame.type === 'tool_failed') {
      const invocation = frame.invocation;
      // The run ends here, once the room has the finish's answer, not when this
      // window sent it: closing on the send lost the answer whenever the socket
      // was between connections, and the agent waited out its tool timeout.
      if (frame.type === 'tool_completed' && ending
        && (invocation.toolName === 'import_finish' || invocation.toolName === 'import_fail')) {
        const decided = ending;
        void queue.then(() => finish(decided));
      }
      const id = invocation.toolCallId;
      if (frame.type === 'tool_started') {
        recordStep(id, (current) => current ?? { id, label: invocation.activityName ?? 'Working', status: 'running' });
      } else {
        recordStep(id, (current) => ({
          id,
          label: invocation.outputSummary ?? current?.label ?? invocation.activityName ?? 'Working',
          status: frame.type === 'tool_failed' || invocation.status === 'failed' || invocation.status === 'ambiguous' ? 'failed' : 'done',
        }));
      }
    } else if (frame.type === 'harness_status_changed' && frame.status === 'running') {
      started = true;
    } else if (frame.type === 'harness_status_changed' && ENDED.has(frame.status) && (started || steps.length > 0)) {
      // Finishing answers before the run ends; an end with no finish means the agent gave up.
      // An opened Channel stays imported even when the finish's own tool row never completed.
      runEnded = true;
      // Only an in-flight commit can still decide whether a Channel opened.
      // Browser work cannot turn a terminal run into a successful import.
      if (!completingImport) finish(ending?.kind === 'imported' ? ending : refusal ? { kind: 'unfinished', refusal } : { kind: 'unfinished' });
    }
  };

  const connect = async (): Promise<void> => {
    if (!run || finished || cancelled) return;
    const ticket = await input.api.getSocketTicket(run.workstreamId, run.substreamId);
    const next = createRealtimeSocket('substream_feed', ticket.url, ticket.protocols);
    socket = next;
    next.addEventListener('open', () => next.send(JSON.stringify({ type: 'subscribe', afterSequence: 0, publishPresence: false })));
    next.addEventListener('message', (event) => {
      if (socket !== next || finished || cancelled) return;
      // Sequenced server data proves this import feed is usable.
      onFrame(event.data, () => input.api.confirmSocketTicket?.(ticket));
    });
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
      clientMessageId: input.mode.kind === 'update' ? null : input.mode.clientMessageId,
      ...(input.mode.kind === 'breakout' ? { breakout: true } : {}),
    }).catch(() => undefined);
  }

  void (async () => {
    try {
      run = input.mode.kind === 'create'
        ? await input.api.startSessionImport({ sourceUrl: input.sourceUrl, title: input.mode.title, spaceIds: input.mode.spaceIds,
          clientMessageId: input.mode.clientMessageId })
        : input.mode.kind === 'breakout'
          ? await input.api.startBreakoutImport(input.mode.workstreamId, { sourceUrl: input.sourceUrl, title: input.mode.title,
            clientMessageId: input.mode.clientMessageId })
          : await input.api.startSessionImportUpdate(input.mode.workstreamId);
      // Cancelled while the reservation was in flight: the run has already
      // ended, so the Channel is discarded without ever being reported.
      if (cancelled) {
        await discard();
        return;
      }
      input.onStarted?.({ workstreamId: run.workstreamId, substreamId: run.substreamId });
      await connect();
    } catch (error) {
      // A new import's start that failed may still have reserved its Channel,
      // and the ids `discard` needs never came back. The create key is enough
      // to take the reservation back; the API answers no-op if none was made.
      if (!run && input.mode.kind === 'create') {
        await input.api.abandonSessionImport({ clientMessageId: input.mode.clientMessageId }).catch(() => undefined);
      }
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
