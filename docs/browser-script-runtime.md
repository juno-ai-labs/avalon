# Browser script runtime

Rally exposes its pinned browser tab through `browser_js` and
`browser_js_reset`. A persistent JavaScript session holds browser and tab
handles, batches deterministic actions and emits observations. The basic shape
follows the browser runtime used by Codex; the supported contract belongs to
Rally and does not depend on a particular model family or claim full Codex or
Playwright compatibility.

**No run is given these tools today.** `createBrowserPlugin` is reached only
through an agent profile's `plugins`, and `AGENT_PROFILES` in
`apps/api/src/services/agent-profiles.ts` has been empty since its one profile,
`session_import`, was removed with the browser session import (2026-11). The
desktop realm, driver and API plugin are intact and tested, so this document
describes them as they would run for the next profile that names the plugin.

This document owns the orchestration realm and handle API. The durable
request/answer transport remains in [desktop actions](desktop-actions.md) and
the signed-in native tabs in [embedded browser](embedded-browser.md).

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
The host controls download batch width with `MAX_PAGE_PARALLEL_DOWNLOADS`;
it remains open until the team selects a value. A finite width limits concurrent
fetch, body allocation and base64 conversion, and each batch drains before the
next starts. Completed file bytes remain retained until the script returns, so
this controls transient fan-out rather than aggregate result memory.
`rally.network.list/read` reuse recorded page responses; `rally.load` reuses
signed-in file loading. Store bytes transfer into the owning renderer's store
at the end of each script call; only references reach the API/model.

`browser_js_reset` destroys the orchestration realm. The next call creates a
fresh session. The pinned page, its globals and already transferred file handles
survive. Completion, failure and cancellation of the owning run dispose the
runtime; closing a tab or browser, reloading the owning renderer, or losing its process
also disposes associated runtimes. Disposal discards bytes not yet transferred
and fails the pending script; it never returns a successful partial transfer. Locator waits stop
when their runtime is disposed. A page operation already submitted to Chromium
can finish after cancellation, but it cannot send a late answer or issue
new browser requests through the destroyed realm.

## Invariants

- Model code runs only in the disposable realm. It has no Node or preload,
  uses an ephemeral partition, has no permission grants and cannot navigate,
  open windows, load frames or make network requests under its CSP. The typed
  RPC binding is its browser access. Guard: real Electron smoke verification;
  no automated security isolation guard.
- Native RPC parses the closed request union and pins every operation to the
  owner's tab. It refuses recursive script actions. Guard:
  `browser-script-driver.test.ts`; bootstrap tests reject other tab references.
- The runtime documentation describes the implemented subset. Changing model
  families does not change this contract. Guard: bootstrap mapping tests and
  API tool tests; semantic browser behavior also requires Electron verification.
- Stored bytes stay on the desktop and reset preserves transferred handles.
  Otherwise a successful extraction could leave a later tool call unable to
  read what it stored. Guard: executor tests and real Electron store/reset smoke.
- Browser tools use write receipts and never require individual confirmation.
  A script can mix reads and writes, so treating all scripts as safely retryable
  reads could duplicate mutations. Guard: API tool tests.

## Boundary

The runtime controls one existing tab. It exposes browser/tab discovery,
indexed accessibility observations, screenshots, a documented locator subset,
native input, navigation and Rally page/file extensions. It does not open or
switch tabs, control other applications, expose raw CDP, offer frames or implement
read-only Playwright evaluate. Browser and page scopes are deliberately separate.
Provider-specific extraction instructions remain skills.

## Failure modes and limits

Invalid RPC names/fields fail with declared-field Zod diagnostics. Stale indexes,
ambiguous locators, non-visible targets, disabled targets and unsupported methods
produce repairable script errors. A closed pinned tab fails the desktop action.
A reset during execution closes the realm and stops subsequent native work.

No new timeout or size limit is introduced. The desktop action transport still
owns its deadline. Locators accept caller-supplied `timeoutMs`; otherwise missing targets or
unmet wait states fail immediately. Explicit waits race Chromium observations
against the caller deadline and runtime disposal. Existing file
limits remain in the shared desktop store. Keep large conversation data in the
page/store; emitting it still consumes model context.

## Testing

Run the API `test/desktop-action-tools.test.ts`, desktop
`src/common/browser-script-bootstrap.test.ts`,
`src/main/browser-script-driver.test.ts`, `src/main/browser-script-runtime.test.ts`, the desktop executor
and page-script tests, and harness prompt tests. The API worker test
`test-workers/desktop-action-storage.test.ts` exercises the durable
request/answer storage through a real object; no worker test runs the plugin
inside a run, since no run is given it. Its desktop endpoint is a double; it
does not execute the Chromium realm.

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

**Changed:** The page-local `rally.downloadFiles` helper concurrently fetches and stores files, returns outcomes in source order, and names missing originals and size mismatches. Declared oversized responses are rejected before body consumption; actual byte sizes are checked before storage. Handled per-file store failures retain successful siblings while every started store drains. One host-owned batch-width control bounds active downloads and conversions when a finite value is supplied; the production value remains open pending a team decision. Provider-specific link resolution remains in page script; credentials never cross to the model. Successful references must be projected to `{ handle, name, mimeType }` for the strict import payload, optionally adding `attachment`/`artifact` kind. Transient network, 429 and 5xx failures require retry or route repair.

**Considered and rejected:** A guessed concurrency value and provider-specific downloader. A configurable batch queue provides the mechanism while the team owns its memory policy; the helper works with ordinary page fetch descriptors.

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
