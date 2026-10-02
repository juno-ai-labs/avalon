# Desktop actions

A desktop action is work an agent loop on the API asks of the person's own
Rally desktop: run script in a page of its browser, read the page's outline,
look at it, give it input, load a file through it. The loop never holds a
`WebContents` and never reaches the desktop any other way; it records a typed
request, the conversation's room publishes it on the socket the desktop already
holds, and the desktop answers it. The conversation import agent
([session import](session-import.md)) is the first user. The transport — the
durable record, the socket frames, the waiter — knows nothing about imports;
the action union in `@rally/contracts` does carry the importer's
`session_import.finish` / `session_import.fail` kinds and its stored-messages
schema, handled by the import window's own handlers.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/desktop-actions.ts` | The action union, one result schema per kind, the failure codes, `StoredRef`, and the import's stored-messages schema. |
| `packages/contracts/src/index.ts` | `desktop_action_requested` (server) and `answer_desktop_action` (client) in the conversation socket protocol. |
| `apps/api/src/durable-objects/workstream-desktop-action-storage.ts` | The `desktop_actions` table: record, answer once, abandon, list pending. |
| `apps/api/src/durable-objects/substream-agent.ts` | `requestDesktopAction` (the executor a run reaches), `answerDesktopAction`, and re-offering pending actions to a subscriber. |
| `apps/api/src/runtime/local-authorities.ts` | `desktopAction`, the in-object authority a run's tools read. |
| `apps/api/src/services/desktop-actions/browser-plugin.ts` | The browser tools and `runDesktopAction`, which turns an answer into a tool result or a typed error. |
| `apps/desktop/src/renderer/lib/desktop-actions/executor.ts` | The desktop side: parse, pin to one tab, check sites, run through the browser command path. |
| `apps/desktop/src/renderer/lib/desktop-actions/page-script.ts` | The page-script wrapper and its `rally.store` helper. |
| `apps/desktop/src/renderer/lib/desktop-actions/store.ts` | What page script stored, by handle, and the per-file cap. |
| `apps/desktop/src/renderer/lib/desktop-actions/ax-outline.ts` | The accessibility tree as an indented outline. |

## How it works

1. **Ask.** A tool calls the run's `desktopAction` executor with its run id,
   its durable tool call id and the action. The conversation's `SubstreamAgent`
   inserts a `desktop_actions` row keyed by `(run_id, tool_call_id)` — or finds
   the row an earlier attempt of the same call wrote — and, if that row is
   already answered, returns the answer at once.
2. **Publish and wait.** Otherwise it registers an in-memory waiter for the
   action id and publishes `desktop_action_requested { id, action }` to the
   conversation's sockets. A socket that subscribes while the action is pending
   is sent it again, so a desktop that reconnects loses nothing.
3. **Execute.** The desktop's executor parses the action, runs it on the one tab
   the work is pinned to through `commandEmbeddedBrowser`, and answers with
   `answer_desktop_action { actionId, outcome }`.
4. **Answer.** The room accepts an answer only from the conversation's creator,
   records it on the row (the first answer wins; later ones are no-ops), and
   resolves the waiter. The tool returns the result, or throws a typed error
   with the failure's code and the next step for the model.

The wait is in memory and the record is durable. If the object is evicted while
a tool waits, the run's crash repair re-enters the tool (every browser tool is
`reenterable`); the re-entered call finds its row and either returns the answer
that arrived meanwhile or asks again. A run that stops or a tool that times out
marks its pending action `abandoned`, which is no longer offered to subscribers.

Page script runs as the body of an async function given `rally`.
`rally.store(value, { name, mimeType })` keeps a Blob, Response, string or JSON
value with the desktop and returns `{ handle, kind, name, mimeType, size }`;
the bytes travel back with the call's answer into the window's store, and only
the description reaches the API and the model. A later action of the same work
— the import's finish — reads them by handle. Screenshots are scaled to the
page's size in DIPs, so a point read off the image is the point `click` sends.

`browser.network_list` and `browser.network_read` are the browser's network
panel. The [embedded browser](embedded-browser.md) records every response a
tab's page receives, from its first request until it navigates to a new
document, and copies each Fetch and XHR body as it finishes. The list returns
each response's URL, method, status, type, size and whether its body was kept.
A read places the body in the page as `window.__rallyNetwork[requestId]` —
parsed when it is JSON — so page script works on it there, and returns its
size, type and top-level keys; with `length` it also returns that slice of the
body's text, from `offset`. Nothing is redacted: the page already received the
body, and the model reads it as it reads any page content.

A desktop keeps every answer it computed. The room offers an unanswered action
again to each new subscription, so a desktop that is offered an action it has
already answered sends the same answer again rather than ignoring it: that is
how an answer that met a socket between connections still arrives. A consumer
that ends its work on an answer should wait for the tool's `tool_completed`
frame — the room has the answer then — before it closes its socket.

## Invariants

- **The desktop decides where an action runs, not the model.** The executor is
  pinned to one tab and exposes no open, close, select or raw DevTools action;
  navigation and loads are refused off the work's allowed sites, and a page
  found off them after an action fails that action. Otherwise a planted
  instruction in a page could drive the person's other signed-in sites. Guard:
  `executor.test.ts`.
- **Only the conversation's creator answers its actions.** An action runs in
  that person's browser session; an answer from anyone else is not theirs to
  give. Guard: `session-import-run.test.ts` (Workers) admission, and
  `answerDesktopAction`'s check.
- **An action is recorded before it is published, and answered at most once.**
  Otherwise an answer could arrive for an action the object cannot match, or a
  repeated answer could change a result a tool already used. Guard: the
  eviction test in `session-import-run.test.ts` (Workers).
- **Every answer is stored before it is used**, in the row of the action it
  answers, so one that would take the row past `DESKTOP_ACTION_MAX_ROW_BYTES`
  (the platform's 2 MB, less what the action itself holds) is recorded as
  `result_too_large` instead of a failed write. A pending row this Worker can
  no longer parse is left out of what a subscriber is offered, rather than
  failing every subscribe. Guard: `desktop-action-storage.test.ts` (Workers).
- **Stored bytes stay on the desktop.** The model and the API see handles.
  Otherwise a long conversation would be re-emitted as model output, slowly and
  possibly altered.

## Boundary

This module owns the request/answer protocol, its durable record, the browser
tools, and the desktop executor. It does not own the browser itself
([embedded browser](embedded-browser.md)), which tools a run is given (its
[agent profile](agent-harness.md)), or what any one user of the protocol does
with an answer — the import's finish and fail actions are handled by
[session import](session-import.md). Today only a run whose conversation's
creator has that conversation's socket open in a desktop can be answered. The
import window is the one non-conversation window the desktop's main process lets
open a realtime socket, and it closes that socket when the window navigates,
crashes or closes. A
Channel's main loop reaching the person's main window is a later consumer of the
same frames. Per Rally's policy, no action asks the person to confirm it.

## Failure modes and limits

- A tab that closes fails every later action with `tab_closed`.
- Page script that throws comes back as `script_error` with the page's own
  message; a syntax error fails the whole expression and is reported generically,
  because Electron hides it.
- A stored file over `MAX_STORED_FILE_BYTES` (25,000,000; equal to the upload
  limit) is refused with `file_too_large`.
- Text in one tool result is capped by `BROWSER_TOOL_TEXT_MAX_CHARS`, written open
  (unbounded); the number is the team's to set.
- An action has no reply deadline of its own; the tool's ordinary
  `TOOL_DEFAULT_TIMEOUT_MS` ends a wait, and the person's Cancel stops the run.
- A dropped socket reconnects after a second and is offered every pending action
  again.

## Testing

- `apps/api/test-workers/session-import-run.test.ts`: real objects, the provider
  double as the model and the test as the desktop over the child's socket —
  answers reach the tool, an answer survives a lost waiter, admission is the
  creator's alone.
- `apps/api/test/desktop-action-tools.test.ts`: tool → action mapping, the
  screenshot as an image part, failure codes with next steps, refused
  mismatched results.
- `apps/desktop/src/renderer/lib/desktop-actions/*.test.ts`: tab pinning and
  site checks, the page-script wrapper run against page globals, the store cap,
  and the outline.

## Security and trust model

Page content is untrusted, and so is anything the model writes in reaction to
it. The model can run script in a page the person is signed in to — that is the
capability — so the boundary is around the tab: one tab, the work's own sites,
no other tab and no DevTools passthrough. There is no network egress filter on
the page, and outcomes — network bodies included — are not redacted; both are
recorded in this document's changelog. Page script runs in the page, never in Rally's renderer or main
process, and the desktop validates every action and every stored value it
hands on.

## Changelog

### 2026-10-01 — Introduce desktop actions for the conversation importer

**What changed:** An agent loop on the API can ask the conversation creator's
desktop to act in its browser: a durable `desktop_actions` row, a
`desktop_action_requested` frame on the conversation's socket, an in-memory
wait, and an answer the desktop sends back. The browser tools include a network
panel (`browser.network_list` / `browser.network_read`) over responses the tab
recorded. A desktop re-sends a stored answer to a re-offered action.

**Why:** [Embedded browser](embedded-browser.md) planned this boundary; the
conversation importer needed it to read a page the person is signed in to.
Agents spent most of an import reconstructing the request that had loaded a
conversation — a token here, a request body there — when the page had already
received the response, so reading recorded responses removes that step for
every site at once. ChatGPT imports lost their finish answer when the window
sent it into a socket between connections and then ignored the room's re-offer
as already handled; the tool waited out its timeout.

**Considered and rejected:** An elicitation-style wait — halt the run, admit
the answer as new input, resume — which costs one activation per browser step
and makes an import of dozens of steps slow; the durable row plus the existing
tool re-entry gives the same eviction safety. A new object or a WorkspaceDO
relay, when the agent loop and the desktop's socket are already in the
conversation's `SubstreamAgent`. Making send itself durable, when the room's
re-offer exists to recover exactly this. Redacting outcomes or network bodies,
and an egress filter on the page: by product decision nothing is redacted — the
page already received what it shows, and the model reads it as it reads any
page content; the boundary is the one tab on the work's own sites.

**Consequences:** Only the conversation's creator answers; a future consumer
keeps that rule unless it states whose desktop may act for its conversation. A
consumer that ends its work on an answer must wait for the tool's
`tool_completed` frame before closing its socket. Whatever a tab's page
received can reach the model, so a consumer must choose its sites with that in
mind.

Shipped in #1058.
