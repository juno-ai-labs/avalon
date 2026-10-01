# Desktop actions

A desktop action is work an agent loop on the API asks of the person's own
Rally desktop: run script in a page of its browser, read the page's outline,
look at it, give it input, load a file through it. The loop never holds a
`WebContents` and never reaches the desktop any other way; it records a typed
request, the conversation's room publishes it on the socket the desktop already
holds, and the desktop answers it. The conversation import agent
([session import](session-import.md)) is the first user; the protocol knows
nothing about imports.

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
- **Every answer is stored before it is used**, so one larger than a SQLite row
  (2 MB, the platform's limit) is turned into `result_too_large` instead of a
  failed write. Guard: verified by reading, no automated test.
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
the page; a decision recorded in [session import](session-import.md)'s
changelog. Page script runs in the page, never in Rally's renderer or main
process, and the desktop validates every action and every stored value it
hands on.

## Changelog

### 2026-10-01 — Introduce desktop actions for the conversation importer

[Embedded browser](embedded-browser.md) planned a typed desktop-action request
and result on the existing browser command path; the conversation importer is
what built it. It runs in the conversation's own `SubstreamAgent` and socket
rather than a new object or a WorkspaceDO relay, because the agent loop is
already there and the importing desktop already holds that socket. The wait was
first designed elicitation-style — halt the run, admit the answer as new input,
resume — and rejected for a durable row plus an in-memory wait: one activation
per browser step would have made an import of dozens of steps slow, and the row
alone gives eviction safety through the existing tool re-entry. A future
consumer should keep the creator-only answer rule unless it states whose desktop
may act for its conversation.
