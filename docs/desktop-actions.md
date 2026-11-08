# Desktop actions

A desktop action is work an agent loop on the API asks of the person's own
Rally desktop: run script in a page of its browser, read the page's outline,
look at it, give it input, load a file through it. The loop never holds a
`WebContents` and never reaches the desktop any other way; it records a typed
request, the conversation's `AgentLoopDO` publishes it on the conversation
socket, and the desktop answers it.

**Today the protocol has no user.** Its one user was the conversation-import
agent, the `session_import` agent profile, which went with Threads (plan step
C-2; its retirement record is in
[`workstream-durable-object.md`](workstream-durable-object.md#changelog)).
`AGENT_PROFILES` in `apps/api/src/services/agent-profiles.ts` is empty, so
nothing registers the browser tools (`createBrowserPlugin` has no production
caller), and no desktop surface handles `desktop_action_requested`. The server
half — the durable record, the socket frames, the waiter — is intact and
described below, for the next feature that needs the person's own browser. The
desktop half lives on as the native primitives the
[browser script runtime](browser-script-runtime.md) drives locally.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/desktop-actions.ts` | The action union, one result schema per kind, the failure codes and `StoredRef`. It still carries the import's `session_import.finish` / `session_import.fail` kinds and stored-messages schema, which nothing sends. |
| `packages/contracts/src/index.ts` | `desktop_action_requested` (server) and `answer_desktop_action` (client) in the conversation socket protocol. |
| `apps/api/src/durable-objects/workstream-desktop-action-storage.ts` | The `desktop_actions` table: record, answer once, abandon, list pending. |
| `apps/api/src/durable-objects/agent-loop-do.ts` | `requestDesktopAction` (the executor a run reaches), `answerDesktopAction`, `answersDesktopActions` (the creator check), and `offerPendingDesktopActions`. |
| `apps/api/src/runtime/local-authorities.ts` | `desktopAction`, the in-object authority a profiled run's tools are handed (`integrations.ts`). |
| `apps/api/src/services/agent-profiles.ts` | `AGENT_PROFILES`, the only way a run is given a `desktopAction` executor; empty. |
| `apps/api/src/services/desktop-actions/browser-plugin.ts` | The browser tools (`browser_js`, `browser_js_reset`) and `runDesktopAction`, which turns an answer into a tool result or a typed error. |
| `apps/desktop/src/common/desktop-actions/executor.ts` | The desktop side: parse, pin to one tab, run through the browser command path. `browser-script-driver.ts` in main drives it for the browser script runtime. |
| `apps/desktop/src/common/desktop-actions/page-script.ts` | The page-script wrapper and its `rally.store` helper. |
| `apps/desktop/src/common/desktop-actions/page-text.ts` | Text normalization embedded in page script: citation marker replacement and Markdown-safe control removal. |
| `apps/desktop/src/common/desktop-actions/store.ts` | What page script stored, by handle, and the per-file cap. |
| `apps/desktop/src/common/desktop-actions/ax-outline.ts` | The accessibility tree as an indented outline. |

## How it works

1. **Ask.** A tool calls the run's `desktopAction` executor with its run id,
   its durable tool call id and the action. The conversation's `AgentLoopDO`
   inserts a `desktop_actions` row keyed by `(run_id, tool_call_id)` — or finds
   the row an earlier attempt of the same call wrote — and, if that row is
   already answered, returns the answer at once.
2. **Publish and wait.** Otherwise it registers an in-memory waiter for the
   action id and publishes `desktop_action_requested { id, action }` to the
   conversation's sockets. A socket that subscribes while the action is pending
   is sent it again, so a desktop that reconnects loses nothing.
3. **Execute.** A desktop's executor parses the action, runs it on the one tab
   the work is pinned to through the embedded browser's command path, and
   answers with `answer_desktop_action { actionId, outcome }`.
4. **Answer.** The object accepts an answer only from the conversation's
   creator, records it on the row (the first answer wins; later ones are
   no-ops), and resolves the waiter. The tool returns the result, or throws a
   typed error with the failure's code and the next step for the model.

The wait is in memory and the record is durable. If the object is evicted while
a tool waits, the run's crash repair re-enters the tool (every browser tool is
`reenterable`); the re-entered call finds its row and either returns the answer
that arrived meanwhile or asks again. A run that stops or a tool that times out
marks its pending action `abandoned`, which is no longer offered to subscribers.

The model-facing tools are `browser_js` and `browser_js_reset`; the persistent
handle API and isolated realm are owned by
[browser script runtime](browser-script-runtime.md). `browser.script` carries one
orchestration call; the older snapshot, click, scroll, type and key action kinds
stay parseable for durable replay and are never advertised to a model.

Page script runs as the body of an async function given `rally`.
`await rally.store(value, { name, mimeType })` keeps a Blob, Response, string or JSON
value with the desktop and resolves to `{ handle, kind, name, mimeType, size }`;
the bytes stay in the desktop's store and only the description reaches the API
and the model. Screenshots are scaled to the page's size in DIPs, so a point
read off the image is the point `click` sends.

Reading a store Promise's reference fields without awaiting it throws a
`script_error` naming the missing await; returning that Promise inside JSON
likewise names the error instead of serializing `{}`. The wrapper observes and
drains every store before its answer leaves, even when a script ignores the
reference, so file reads cannot silently finish after the answer is serialized.

`rally.normalizeText(text, [{ marker, text }])` replaces private-use citation
markers with their written-out text. Ordinary provider-reference spaces and
prose are ignored. It removes remaining private-use syntax and invalid controls,
preserving tabs, newlines and carriage returns for Markdown.

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

The governed `desktop_action_phase` diagnostic (`apps/desktop/src/common/desktop.ts`)
records an action UUID and elapsed times from receipt to answer; no script, URL,
title, tool output or file content enters it.

## Invariants

- **The desktop decides where an action runs, not the model.** The executor is
  pinned to one tab and exposes no open, close, select or raw DevTools action.
  Within that tab it may navigate to and load from any site: restricting where
  the browser goes is not a boundary this product draws. Guard:
  `executor.test.ts`.
- **Only the conversation's creator answers its actions.** An action runs in
  that person's browser session; an answer from anyone else is not theirs to
  give. Guard: `answersDesktopActions`; the Workers proof of it went with the
  import suite and has not been replaced.
- **An action is recorded before it is published, and answered at most once.**
  Otherwise an answer could arrive for an action the object cannot match, or a
  repeated answer could change a result a tool already used. Guard:
  `desktop-action-storage.test.ts` (Workers).
- **Every answer is stored before it is used**, in the row of the action it
  answers, so one that would take the row past `DESKTOP_ACTION_MAX_ROW_BYTES`
  (the platform's 2 MB, less what the action itself holds) is recorded as
  `result_too_large` instead of a failed write. A pending row this Worker can
  no longer parse is left out of what a subscriber is offered, rather than
  failing every subscribe. Guard: `desktop-action-storage.test.ts` (Workers).
- **Stored bytes stay on the desktop.** The model and the API see handles.
  Otherwise a long page would be re-emitted as model output, slowly and
  possibly altered.

## Boundary

This module owns the request/answer protocol, its durable record, the browser
tools, and the desktop executor. It does not own the browser itself
([embedded browser](embedded-browser.md)), the local script runtime that now
drives the executor ([browser script runtime](browser-script-runtime.md)), or
which tools a run is given ([agent harness](agent-harness.md)). A user of the
protocol needs an agent profile that registers the browser tools and a desktop
surface that answers `desktop_action_requested` on the conversation socket;
neither exists today. Per Rally's policy, no action asks the person to confirm
it.

## Failure modes and limits

- A tab that closes fails every later action with `tab_closed`.
- Page script that throws comes back as `script_error` with the page's own
  message; a syntax error fails the whole expression and is reported generically,
  because Electron hides it.
- A stored file over `MAX_STORED_FILE_BYTES` (25,000,000; equal to the upload
  limit) is refused with `file_too_large`.
- Text in one tool result is capped by `BROWSER_TOOL_TEXT_MAX_CHARS`, written open
  (unbounded); the number is the team's to set.
- An action has no reply deadline of its own: `TOOL_DEFAULT_TIMEOUT_MS` ends a
  wait, and the person's Cancel stops the run. Reconnect reoffers the recorded
  action.
- A run whose stored profile no longer exists (a conversation provisioned as
  `session_import`) is refused as `agent_profile_unknown` rather than run with
  the full tool surface.

## Testing

- `apps/api/test-workers/desktop-action-storage.test.ts`: the record, the
  single answer, the row-size refusal and the unparseable pending row, on real
  workerd.
- `apps/api/test/desktop-action-tools.test.ts`: tool → action mapping, the
  screenshot as an image part, failure codes with next steps, refused
  mismatched results.
- `apps/desktop/src/renderer/lib/desktop-actions/*.test.ts`: tab pinning and
  site checks, the page-script wrapper run against page globals, the store cap,
  and the outline.

## Security and trust model

Page content is untrusted, and so is anything the model writes in reaction to
it. The model can run script in a page the person is signed in to — that is the
capability — so the boundary is around the tab: one tab, which may go to any
site, no other tab and no DevTools passthrough. There is no network egress filter on
the page, and outcomes — network bodies included — are not redacted; both are
recorded in this document's changelog. Page script runs in the page, never in Rally's renderer or main
process, and the desktop validates every action and every stored value it
hands on.

## Changelog

### 2026-10-03 — Import saves use the run lifecycle

**Why:** A committed import's success arrived 1.2 seconds after the generic 30-second tool timer. The durable desktop answer said success while the tool receipt and run said failure.

**Changed:** `import_finish` selects the host-only run deadline policy and waits for the desktop's durable answer without a second tool timer. Browser tools keep their ordinary deadlines. The import-wide lifetime control subtracts elapsed durable run time on resume; it is open until the team chooses a value. Persisted contract-2 finish actions and their recorded inputs keep their original wire shape on replay, while newly advertised model inputs require checks.

**Considered and rejected:** Increasing the generic timer or treating every timeout as success. Neither establishes whether a write committed. Run cancellation still stops waiting and retains uncertain-write semantics.

**Consequences:** A slow successful save settles its original tool receipt and lets the model finish normally. No new timeout number or retry path is introduced.

### 2026-10-02 — Make storage and text conversion observable and explicit

**What changed:** Store references require an awaited Promise, pending stores
drain with the call, page script gains Markdown-safe citation normalization, and
the importer records content-free action phases through main-owned telemetry.
The model now uses persistent script/reset tools over shared desktop primitives;
[browser script runtime](browser-script-runtime.md) owns their handle API.

**Why:** Production imports generated missing file handles by reading a Promise,
deleted spaces through a provider reference whose marker was a space, and
mistook paragraphs for invalid controls. Another action's successful answer
arrived 223 seconds after dispatch, after the server timeout, with no evidence
separating delivery, queueing and browser execution.

**Considered and rejected:** Raising the tool timeout, adding a second importer,
or copying scripts and results into diagnostic events. None fixes the identified
contract errors or locates the wait. The shared helpers and phase observations
keep browser capabilities reusable and preserve the existing privacy boundary.

**Consequences:** Models await stores and normalize text through the helper.
Phase telemetry requires the registry reader to deploy before the desktop
producer; a successful socket send alone does not prove server receipt.

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
page content; the boundary is the one tab. A list of sites the tab may use:
an import also needs the provider's file, sign-in and artifact hosts, which
change, and where the browser may go is not a line this product draws.

**Consequences:** Only the conversation's creator answers; a future consumer
keeps that rule unless it states whose desktop may act for its conversation. A
consumer that ends its work on an answer must wait for the tool's
`tool_completed` frame before closing its socket. Whatever a tab's page
received can reach the model, wherever the tab went.

Shipped in #1058.
