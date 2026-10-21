# Electron network requests

Rally and Sideline share an upload bridge that keeps request failures inside the
request's promise. It uses Chromium's network stack, default Electron session,
proxy configuration, certificate checks, and credentials policy.

## Where the code lives

`packages/electron-network/src/index.ts` exports `createElectronFetch`. Each
Electron main process creates it with `net` and routes its application fetches
through it, including telemetry and native crash uploads. Both Electron Vite
configurations bundle the workspace package into the main-process output; a
packaged app must not try to load its TypeScript source from node_modules.

The third-party updater uses its own Chromium transport. The pnpm patch at
`patches/electron-updater@6.8.9.patch` owns every native response's error event
before passing it to the updater's consumer. Electron already forwards the same
native failure to the request; the response listener prevents a second, unowned
stream error without duplicating request errors or changing update retry policy.

## How it works

Private and file protocol requests use Electron's `net.fetch`. All HTTP requests
use `net.request`: a Web `Request` serializes
JSON, multipart, or stream input, and one owned `pipeTo` operation writes it to
the native request. Its rejection handler rejects the fetch promise and aborts
the native request. There is no code-specific network-error classification in
this path.

Electron responses are checked to be Node Readables before adaptation to Web
response streams. Headers, status, backpressure, and response-read failures
remain available to the caller. Null-body response statuses drain the native
response. The caller's abort signal remains attached through response completion,
so cancellation after headers interrupts the response read too.

## Invariants

- Every upload promise has a rejection handler, including source-stream failure
  and abort paths. A request failure must not leave a second unhandled rejection.
- A mutation is sent once. This primitive never retries a request or assumes a
  failed response means the server did not perform a write.
- Transport failures reject normally. Existing request owners decide whether to
  retain state, reconnect, retry, or display an error.
- Chromium networking and the default Electron session remain in use. Switching
  to Node fetch would change proxy, cookie, and authentication behavior.

## Boundary

The injected transport declares only the capabilities the adapter consumes.
Actual Electron `net` satisfies that interface. Input normalization uses Web
`Request`, and response conversion checks the real Node stream base class that
Electron's public declarations omit. The bridge does not relax TLS checks,
change credentials policy, log request payloads, or replay writes.

## Failure modes and limits

Electron 43.2.0's
[`fetchWithSession`](https://github.com/electron/electron/blob/v43.2.0/lib/browser/api/net-fetch.ts)
starts `req.body.pipeTo(writable).then(() => r.end())` without handling rejection.
The public fetch promise can reject and be caught while the upload promise also
rejects unhandled. Connection resets, suspended I/O, offline transitions, DNS,
proxy and TLS failures all use the same broken promise ownership; maintaining
an error-code list at the process boundary cannot fix it.

The bridge owns HTTP upload and response failures, including native error
listeners on HEAD and null-body responses. Last-resort process recovery matches
the Chromium network-error family and real loader origin as described in
[telemetry](telemetry.md); programming errors remain fatal. Custom-protocol
fetches and embedded-page navigation remain Electron-owned. Review this workaround when upgrading Electron
and remove it only after proving upstream handles the upload rejection.

Electron Updater 6.8.9 has a separate response-ownership gap: its HTTP 404/204
early returns and some piped differential-download responses omit an error
listener. A later reset destroys that native response and produces a direct
uncaught exception with the same loader stack. The process-level rejection
handler cannot contain it. Keep the updater patch until its response consumers
own all error paths; re-run the native regression when upgrading the dependency.

## Testing

`pnpm --filter @rally/electron-network test` exercises real Web streams and Node
Readable responses against a typed native-request capability double. Tests cover
JSON and multipart serialization, headers, null-body responses, failures during
and after upload, response-read failures, cancellation, and an arbitrary future
transport error. Vitest reports detached unhandled rejections as suite failures.
`pnpm --filter @rally/electron-network test:native [electron-executable]` runs
Electron itself against a loopback HTTP server. It verifies native blocked and
reset connections, JSON and multipart uploads, HEAD responses, cancellation
after response headers, and an errored source stream. The comparison
reproduces the upstream detached rejection; the bridge returns the original
source error without an orphaned rejection. Linux uses Electron's headless
Ozone backend and requires no X server.
The same command also exercises the installed updater transport against reset
responses: a rejected feed, a rejected download, and an interrupted body read.
It verifies that the original request still fails, each reset is delivered once
to the request, and no exception or rejection escapes to the process. The fixture
drains rejected responses to advance Chromium's data-pipe backpressure before
resetting the loopback socket; it does not install a response error handler.

## Changelog

### 2026-10-21 — Contain updater response resets during sleep

**What changed:** A pinned Electron Updater patch installs a response error
listener before dispatching to consumers. Native regression coverage exercises
both rejected HTTP responses and an interrupted successful response.

**Why:** A sleep-time `ERR_CONNECTION_RESET` reached Rally 1.648.0 as a direct
main-process exception despite the upload bridge and rejection recovery. The
updater's early HTTP-error return reproduced the exact Electron loader stack:
the request rejection was handled but its response stream had no error owner.

**Considered and rejected:** Recovering direct exceptions globally would expand
the process boundary and conceal the missing owner. Forwarding the response
error again duplicates the failure Electron already sends to the request.

**Consequences:** Preserve the updater's existing request error, session, retry,
and signing behavior. Review the patch and run the native fixture on upgrades;
this containment does not establish which background request failed on a device.

Pull request: [#1362](https://github.com/juno-ai-labs/avalon/pull/1362).

### 2026-10-20 — Own Electron upload failures at the request boundary

**What changed:** Both Electron applications route HTTP requests through a shared
Chromium request bridge that observes the entire upload promise.

**Why:** Repeated network failures exposed the fragility of per-code process
recovery. Investigation found and reproduced an unhandled upload promise in
Electron 43.2.0's fetch implementation. Catching the public fetch promise cannot
catch this independent promise, and null-body native responses also need an
error owner.

**Considered and rejected:** Expanding a global error-code allowlist leaves the
unhandled promise in place. Node fetch changes session and proxy behavior, and
automatic write retries can duplicate mutations with uncertain outcomes.

**Consequences:** Every upload failure returns to its request owner regardless
of code. Preserve cancellation, response streaming, and the one-attempt rule;
re-evaluate the workaround when Electron's implementation changes.
