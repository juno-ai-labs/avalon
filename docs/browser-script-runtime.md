# Browser script runtime

Rally exposes its pinned browser tab through `browser_js` and
`browser_js_reset`. A persistent JavaScript session holds browser and tab
handles, batches deterministic actions and emits observations. The basic shape
follows the browser runtime used by Codex; the supported contract belongs to
Rally and does not depend on a particular model family or claim full Codex or
Playwright compatibility.

This document owns the orchestration realm and handle API. The durable
request/answer transport remains in [desktop actions](desktop-actions.md), the
signed-in native tabs in [embedded browser](embedded-browser.md), and the
conversation commit in [session import](session-import.md).

## Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/browser-runtime.ts` | The model's entry instructions and complete supported API documentation. |
| `packages/contracts/src/desktop-actions.ts` | Script/reset action and result schemas. |
| `apps/api/src/services/desktop-actions/browser-plugin.ts` | The two model tools, durable execution receipts and text/image result mapping. |
| `apps/desktop/src/common/browser-script-bootstrap.ts` | Session-local `cua`, browser/tab handles, locator chains and `nodeRepl` output. |
| `apps/desktop/src/common/browser-script-protocol.ts` | Closed native RPC request union. |
| `apps/desktop/src/main/browser-script-runtime.ts` | Isolated persistent Chromium realm and its lifecycle. |
| `apps/desktop/src/main/browser-script-driver.ts` | Pinned-tab AX/DOM discovery, semantic actions and Rally extensions. |
| `apps/desktop/src/common/desktop-actions/` | Shared native browser primitives, page extraction wrapper and stored bytes. |

## How it works

`browser_js({ code, title? })` records one `browser.script` desktop action. Its
renderer executor chooses the runtime ID and pinned tab; model code chooses
neither. Main owns one hidden, sandboxed `WebContentsView` for that runtime.
CDP's REPL evaluation supports top-level await and persistent declarations.
The browser call title labels activity rows while running and after completion; scripts with errors name the failed work. No model JavaScript runs in Electron main or Rally's trusted renderer.

The first call runs one discovery entry point, for example
`const browser = await cua.getBrowser({ id: "iab" });`. It emits the supported
API documentation. A subsequent `const tab = await browser.tabs.selected();`
binds the pinned tab and emits its indexed accessibility state. The
`cua.getTab` and `cua.getState` entry points also work. Unsupported APIs are
absent rather than advertised as aliases.

A model can use `tab.playwright.getByRole("button", { name: "Expand" }).click()`,
other documented locators, or indexed AX actions. Role/name matching uses
Chromium's accessibility tree, not guessed DOM role attributes. Locator chains
are descriptions, resolved afresh for each operation. Single-target operations and visible/hidden waits
reject ambiguous matches. Missing targets or unmet states return a repairable error
unless the caller supplies `timeoutMs`; the deadline runs in main even when the
page stops painting. Input uses the existing native browser command path;
it does not simulate clicks by calling DOM event handlers. Locator input checks
visibility and rejects disabled or read-only targets; this subset does not
implement Playwright's full actionability or frame semantics.

State and screenshots emit automatically unless `emit: false`. AX observations
emit differences after the first read, with `disableDiffing` for a full tree.
Removed targets lose their indexes; new targets never reuse them. Models emit
small custom results using `nodeRepl.write`. Native screenshots become image
content parts, keeping their base64 out of tool text. A thrown script retains
its earlier observations and an error so the model can repair the next call.

`rally.pageScript(callbackOrBody)` is a writable page extraction extension, explicitly
separate from the orchestration scope. Callbacks are serialized into the page and cannot capture orchestration variables. Function expressions passed as strings are refused with a repair instruction instead of silently returning null. It retains the existing async wrapper,
`await rally.store`, text normalization and signed-in page fetch behavior.
`rally.downloadFiles(files)` fetches and stores independent files concurrently,
preserves source order, checks declared original sizes, and returns stored
references or named unavailable entries. Resolve provider download links in
parallel before calling it; credentials stay in page-local `RequestInit` values.
`rally.network.list/read` reuse recorded page responses; `rally.load` reuses
signed-in file loading. Store bytes transfer into the owning renderer's store
at the end of each script call; only references reach the API/model.

`browser_js_reset` destroys the orchestration realm. The next call creates a
fresh session. The pinned page, its globals and already transferred file handles
survive. Completion, failure and cancellation of an import dispose the runtime;
closing a tab or browser, reloading the owning renderer, or losing its process
also disposes associated runtimes. Disposal discards bytes not yet transferred
and fails the pending script; it never returns a successful partial transfer. Locator waits stop
when their runtime is disposed. A page operation already submitted to Chromium
can finish after cancellation, but it cannot send a late import answer or issue
new browser requests through the destroyed realm.

## Invariants

- Model code runs only in the disposable realm. It has no Node or preload,
  uses an ephemeral partition, has no permission grants and cannot navigate,
  open windows, load frames or make network requests under its CSP. The typed
  RPC binding is its browser access. Guard: real Electron smoke verification;
  no automated security isolation guard.
- Native RPC parses the closed request union and pins every operation to the
  owner's tab. It refuses recursive script actions and import actions. Guard:
  `browser-script-driver.test.ts`; bootstrap tests reject other tab references.
- The runtime documentation describes the implemented subset. Changing model
  families does not change this contract. Guard: bootstrap mapping tests and
  API tool tests; semantic browser behavior also requires Electron verification.
- Stored bytes stay on the desktop and reset preserves transferred handles.
  Otherwise a successful extraction could leave `import_finish` unable to read
  its messages. Guard: executor tests and real Electron store/reset smoke.
- Browser tools use write receipts and never require individual confirmation.
  A script can mix reads and writes, so treating all scripts as safely retryable
  reads could duplicate mutations. Guard: API tool tests.

## Boundary

The runtime controls one existing tab. It exposes browser/tab discovery,
indexed accessibility observations, screenshots, a documented locator subset,
native input, navigation and Rally page/file extensions. It does not open or
switch tabs, control other applications, expose raw CDP, offer frames or implement
read-only Playwright evaluate. Browser and page scopes are deliberately separate.
Provider-specific extraction instructions remain skills, and `import_finish` /
`import_fail` remain separate durable tools.

## Failure modes and limits

Invalid RPC names/fields fail with declared-field Zod diagnostics. Stale indexes,
ambiguous locators, non-visible targets, disabled targets and unsupported methods
produce repairable script errors. A closed pinned tab fails the desktop action.
A reset during execution closes the realm and stops subsequent native work.

The API admits new and update import runs only from client contract 2 or newer,
which implements script/reset actions. Older or undeclared clients receive an
update-required response before a Channel or agent is reserved. Other routes
continue serving client contract 1.

No new timeout or size limit is introduced. The desktop action transport still
owns its deadline. Locators accept caller-supplied `timeoutMs`; otherwise missing targets or
unmet wait states fail immediately. Explicit waits race Chromium observations
against the caller deadline and runtime disposal. Existing file
limits remain in the shared desktop store. Keep large conversation data in the
page/store; emitting it still consumes model context.

## Testing

Run the API `test/desktop-action-tools.test.ts`, desktop
`src/common/browser-script-bootstrap.test.ts`,
`src/main/browser-script-driver.test.ts`, `src/main/browser-script-runtime.test.ts`, existing desktop executor/page-script
and session-import-run tests, and harness prompt tests. API worker tests
`test-workers/desktop-action-storage.test.ts` and
`test-workers/session-import-run.test.ts` exercise script receipts, durable replay
and the new tool inventory through real objects and sockets. Their model and
desktop endpoints are doubles; they do not execute the Chromium realm.

Bootstrap tests execute
the installed API against a typed RPC double; driver tests stand in for native
Chromium, which Node Vitest cannot run. They do not prove renderer isolation or
native input rendering.

Use the real Electron/CDP workflow in [dev environment](dev-environment.md) for
persistence, top-level await, AX role/name targeting, native fill/click,
screenshot images, page storage, partial errors, reset and cancellation. Capture
and inspect the real window. A regression control must drop an actual production
binding or input dispatch and fail the corresponding smoke assertion before
restoring the code.

## Changelog

### 2026-10-03 — Concurrent page file downloads

**Why:** The import model downloaded independent originals in sequential loops, paying each network delay in turn.

**Changed:** The page-local `rally.downloadFiles` helper concurrently fetches and stores files, returns outcomes in source order, and names missing originals and size mismatches. Provider-specific link resolution remains in page script; credentials never cross to the model.

**Considered and rejected:** A fixed worker-pool cap and provider-specific downloader. Existing browser and store boundaries own resource limits; the helper works with ordinary page fetch descriptors.

**Consequences:** Callers resolve provider links with `Promise.all`, preserve returned ordering when attaching files, and repair or explicitly account for unavailable originals.

### 2026-10-02 — Persistent browser handles with a model-neutral contract

Slow canceled imports exposed mistakes at the browser tool boundary, including
unawaited storage and oversized observations. The model-facing browser tools now
share one persistent JavaScript session with semantic handles, following Codex's
basic browser shape. Exact tool/API parity was rejected: Rally may use different
model families, controls one pinned tab and needs writable extraction and file
storage. Import admission requires the matching desktop contract before any
reservation; cancellation guards the shared native dispatch path, and renderer
reloads destroy orphaned realms. Keep the documented subset explicit, preserve desktop-owned tab and
byte authority, and execute orchestration in a separate sandboxed realm rather
than the authenticated renderer.
