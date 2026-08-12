# Security model

This document owns Avalon's trust boundaries: what is treated as untrusted, what
each trusted component is trusted *for*, and the mechanisms that keep the two
apart — renderer isolation, OAuth and session handling, connector credential
encryption, webhook verification, the model boundary, audit logging, and secret
handling.

Read it before changing any of those, before adding a surface that receives
outside input, and before adding anything to `application-settings.json`, the
preload bridge, or the `VITE_` allowlist. Everything here is a boundary someone
outside this document can break without their own tests failing.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/main/index.ts` | Window creation, sandbox and `contextIsolation` flags, navigation denial, IPC handler registration. |
| `apps/desktop/src/preload/index.ts` | The whole renderer-facing API. Nothing else crosses. |
| `apps/desktop/src/renderer/index.html` | The Content Security Policy. |
| `apps/desktop/src/main/session-encryption.ts`, `stored-auth.ts`, `stored-session.ts`, `session-file.ts` | The versioned credential envelope and the serialized session-mutation boundary. |
| `apps/desktop/src/main/lockdown-mode.ts` | The `safeStorage` mode and its migration. |
| `apps/desktop/src/main/application-settings.ts` | The shared write queue every preference goes through. |
| `apps/desktop/src/main/debug-settings.ts`, `developer-settings-flag.ts` | Debug enabled, and the flag that suppresses it. |
| `apps/api/src/middleware/auth.ts` | Session, workspace, role, and principal resolution on every request. |
| `apps/api/src/middleware/validation.ts` | Request parsing at the HTTP boundary. |
| `apps/api/src/lib/crypto.ts` | AES-GCM credential envelopes and key-version handling. |
| `apps/desktop/scripts/mac-signature-policy.mjs`, `apple-notarization.mjs`, `finalize-macos-release.mjs` | Entitlement rules, notarization, and the release verifier. |
| `.gitleaks.toml`, `scripts/gitleaks-allowlist.test.mjs` | The scan's bounded exceptions and the test that keeps them honest. |

## How it works

### Trust boundaries

The renderer, inbound internet, connector providers, monitored URLs, model
output, and connector payloads are untrusted. The Electron main process and
regional Worker are trusted only within their narrow responsibilities. D1 and R2
are canonical storage services, not authorization layers.

### Electron

- `contextIsolation` is enabled, Node integration is disabled, and sandboxing is
  enabled.
- The packaged preload is emitted as CommonJS so Electron can load it inside the
  sandbox. Its bridge exposes a small named API and never exposes `ipcRenderer`,
  environment variables, filesystem paths, or arbitrary channel names.
- Every IPC argument is parsed before use.
- Navigation and popup creation are denied by default; OAuth opens in the system
  browser.
- A strict Content Security Policy allows bundled content and the configured
  regional API only.
- Refresh material is encrypted in the main process. By default the desktop uses
  an application-wide embedded key so a saved session survives signing-identity
  and keystore changes. Application → **Lockdown mode** replaces that with
  Electron `safeStorage`, binding the saved authentication state to the
  operating-system keystore. An in-app toggle re-encrypts every durable session
  component before committing the new preference. The plaintext preference lives
  in owner-readable `application-settings.json` under Electron's `userData`
  directory. If that file is edited to turn Lockdown off while a Lockdown
  credential envelope remains, Avalon removes only local credential-bearing files
  and requires sign-in instead of exporting the protected session. An unavailable
  keystore also turns Lockdown off and requires sign-in automatically. The
  renderer receives short-lived access only through the narrow session bridge.
- The custom `avalon://` callback carries only an opaque, expiring, single-use
  login ticket or a non-secret connector result — never provider codes or tokens.
- Unsent composer drafts — their text and the bytes of their attachments — are
  cached in the renderer's IndexedDB so a restart does not discard them. They are
  workspace content stored unencrypted under Electron's `userData` directory, they
  expire after 12 hours, and signing out deletes every one of them. Nothing else
  is written there, and no credential ever is.
  [`composer-drafts.md`](composer-drafts.md) owns the mechanism.
- The macOS menu bar status item is built entirely in the main process, from
  values the regional API returned, and the renderer's only reach into it is
  `application-settings:set-menu-bar-enabled` and
  `application-settings:set-launch-at-login`, each of which accepts a boolean and
  nothing else. The menu itself holds no control for state the operating system
  owns independently — whether Avalon opens at login is a Settings toggle, read
  back from macOS on every read rather than from Avalon's preference file. Its
  content requests reuse the stored access token and regional endpoint through the
  same coalescing refresh as the feature-flag poll, add no credential storage, and
  reach only `/workstreams` and `/work-opportunities`. The work-stream titles they
  return are workspace content held in main-process memory only, never written to
  disk, and dropped on sign-out. Because Avalon registers itself to open at login
  and starts hidden there, this runs with no window and no renderer;
  [`menu-bar.md`](menu-bar.md) owns the mechanism. Its preference shares
  `application-settings.json` with Lockdown mode and therefore the same shared
  write queue described below.
- The native Settings window uses the same sandbox, preload, CSP, navigation
  denial, and regional session bridge as the main window. **Command-,** opens a
  singleton window rather than a privileged remote page.
- Application → Developer → **Debug enabled** shares the same
  `application-settings.json` file but crosses no trust boundary: it only reveals
  debugging affordances the renderer already holds, such as copying a work
  stream's or automation's identifier from its right-click menu or reading the
  wiring rows of the right rail's **Details** section. It is off by default and
  turning it on grants no additional capability or IPC surface. One affordance
  does fetch something the renderer was not already holding — the new-automation
  card's read-only system-prompt viewer — and it changes nothing here:
  `POST /automations/draft/system-prompt` is an ordinary authenticated route that
  writes nothing and reads the named draft through the same check that lets the
  caller reopen it, so the preference decides whether the section is offered,
  never whether the account may ask and never what it may see. The section
  it sits in is offered only where the service's `developer-settings` flag says
  so, and the main process reports the stored preference as `false` while that
  flag is off, so a hand-edited `debugEnabled: true` reveals nothing — see
  [`feature-flags.md`](feature-flags.md). Who the flag reaches is a Flagship
  targeting rule rather than a condition in the Worker, which is sound precisely
  because this is a product scope on a staff tool and not a confidentiality
  boundary — the same reason a poll that cannot reach the service keeps its last
  answer rather than closing the section. **Nothing that protects data may be
  scoped this way.**
- Because the two preferences have separate owners that serialize on different
  primitives, **every write to `application-settings.json` goes through one shared
  queue and re-reads before it merges**: a lost update here would leave an off
  Lockdown preference beside a Lockdown envelope, which the next launch treats as
  an out-of-app edit and answers by deleting the stored credentials.

### macOS distribution and updates

Avalon's production identity is pinned to bundle ID `app.avalon.desktop` and Apple
team `7ZLT6A8W25`. Squirrel.Mac cannot safely update across either boundary, so
changing them requires a deliberate manual-reinstall migration. Release packaging
never auto-selects a certificate.

The main app and Electron helpers use separate entitlement files. In particular,
renderer/GPU/plugin helpers, Squirrel `ShipIt`, and `chrome_crashpad_handler` must
contain exactly `com.apple.security.cs.allow-jit` and
`com.apple.security.network.client`. Restricted `com.apple.developer.*`
entitlements are forbidden there: a provisioning profile for the main bundle ID
does not authorize helper bundle IDs, and macOS AMFI can otherwise kill those
helpers only after the app reaches another machine. The release verifier parses
the final signed entitlements, requires the pinned Developer ID team and an arm64
slice for every one of those executables, and then proves a renderer remains alive
under a clean user-data profile.

Both `Avalon.app` and the DMG container are signed, submitted to Apple's notary
service, and stapled. The DMG is blockmapped only after signing and stapling
mutate its bytes; `latest-mac.yml` is generated from the final ZIP. Before R2
promotion, Gatekeeper, stapler, bundle ID/version, updater URL, final blockmaps,
nested signatures, and a LaunchServices smoke all have to pass. The update
transport is still treated as untrusted: electron-updater's macOS signature
validation remains the execution trust boundary, while R2 publication uses
immutable versioned objects and promotes the mutable feed last.

### Authentication and authorization

Google identity OAuth uses state and PKCE. The desktop starts it with POST, then
opens only the provider URL containing opaque state. Every identity and connector
callback is completed by the owning regional server before the temporary
`/auth/desktop/` page receives an exact custom-protocol target in its URL
fragment. The page applies `no-store`/`no-referrer`, removes the fragment
immediately, and never renders or logs the target. Connector consent is a separate
incremental flow whose durable attempt result lets the desktop reconcile success,
denial, failure, or expiry even if the custom-protocol notification is lost. OAuth
states and desktop tickets are expiring and atomically consumed. Refresh tokens
are hashed for sessions or AES-GCM encrypted for providers.

Every API resource query includes `workspace_id`. Mutations additionally resolve
membership role. Every connector tool checks its execution principal, connection
scope, granted capability, and resource visibility. Workspace-scoped connector
capabilities roll down to every work stream in that workspace and execute as the
workspace principal; participants do not implicitly share their personal
connectors.

WebSocket upgrades require an exact match against `ALLOWED_ORIGINS`; missing
origins and suffix lookalikes are rejected before the short-lived socket ticket is
forwarded to a room. Tickets bind user, workspace, work stream, region, and
one-time ID, and the room atomically rejects reuse. The ticket travels in
`Sec-WebSocket-Protocol` — the one handshake header a browser will set, through
the `WebSocket` constructor's `protocols` argument — as the sentinel
`avalon.ticket.v1` followed by the ticket. It is deliberately not in the query
string: Cloudflare records whole request URLs into the invocation log, the Logpush
export, and trace spans, and no redaction in this repository can reach them. The
server echoes only the sentinel, never the ticket, because a selected subprotocol
is a response header. [`realtime-sockets.md`](realtime-sockets.md) owns the
admission path.

Renderer WebSockets may be constructed only from a URL returned by the
authenticated work-stream or transcription ticket endpoints; ESLint enforces that
provenance at each production constructor. Runtime URL schemas likewise name their
accepted scheme contract explicitly — HTTP(S), HTTPS-only, `avalon:`, or the
intentional HTTP(S)/Avalon handoff union. Bare Zod URL validation is forbidden
because it accepts non-web schemes such as `javascript:` and `data:` while hiding
the product boundary being enforced.

### Side effects and retries

Tool arguments are runtime-validated and canonically hashed. The system records a
write as started before provider execution and reuses completed results on
workflow retry. If a process stops after a provider write but before confirmation
is stored, the invocation becomes `ambiguous`, the work stream becomes
`needs_input`, and the write is not automatically repeated.

This is retry safety, not a broad approval gate.

### Connector credentials

Provider refresh tokens remain in the regional backend, encrypted with AES-GCM and
additional authenticated data tied to the connection ID. Key version is stored
beside ciphertext so rotation can decrypt with an old key and re-encrypt with the
active key. Global and EU deployments use independent keys. Rotation itself is in
[Operations](#operations).

Granola Workspace API keys and the signing secrets returned while registering
Granola webhook endpoints use the same versioned credential envelope and
connection-bound additional authenticated data. The admin setup form treats the
key as a password and submits it once to the selected regional backend. Plaintext
keys and signing secrets are excluded from connection configuration, API
responses, provider identifiers, audit metadata, and logs. Personal Granola OAuth
and refresh credentials remain user-scoped; workspace keys remain
workspace-scoped.

Google scopes are requested incrementally. Sign-in does not grant Gmail, Calendar,
or Drive access. Revoked and expired grants become an explicit reconnect state.

### Webhooks

Generic webhooks use an endpoint-specific secret, a timestamped HMAC-SHA256
signature, a bounded replay window, a stored receipt, schema validation, size
limits, and provider dedupe keys.

Granola webhooks are verified using the Standard Webhooks `webhook-id`,
`webhook-timestamp`, and `webhook-signature` headers over the exact raw request
body. Verification and size checks happen before JSON parsing, R2 persistence,
receipt creation, or queueing.

### Model boundary

OpenRouter credentials and model context are server-only. The harness receives
only context authorized for the execution principal. Tool calls are proposals:
Avalon validates the name, schema, principal, capability, limits, and idempotency
state before execution. Reasoning fields are ignored; private chain-of-thought is
neither persisted nor broadcast.

### Logging and audit

Structured logs include correlation IDs and domain IDs needed for operations.
Redaction removes authorization headers, tokens, OAuth codes, credential
ciphertext, email and file bodies, raw provider payloads, and model context.
User-visible failures are persisted in product state so recovery does not depend
on provider logs.

Workspace invitation tokens are random bearer secrets stored only as SHA-256
hashes in D1. The plaintext token exists transiently in the regional Worker, the
Resend transactional request, the recipient's email, and the fragment-protected
browser/deep-link handoff. It is never placed in a query string, log, audit event,
or Resend tag. Resend uses a send-only API key and a stable per-invitation
idempotency key; an outbound provider failure revokes the new invitation before
the API returns an error.

Work-stream inbound addresses are routing identifiers, never authenticators.
Resend webhooks are verified against their untouched raw body before parsing and
deduplicated by delivery ID. Received HTML, headers, attachments, sender
identities, and quoted content are untrusted. Incoming mail is attached as a
regional resource and system message; it never launches a write-capable agent run
merely because the From address resembles a workspace member. Friendly addresses
are immutable and permanently reserved so a stale sender can never reach a
different work stream.

Automation email may start a read-only run, but the sender match remains defense
in depth rather than authenticated identity. Those runs receive no external
connector writes and no outbound web tools, and an atomic per-address hourly
budget bounds model spend if an address leaks or a sender is spoofed.

Audit events cover sign-in and session changes, membership, connector
authorization and revocation, external writes, automation changes, suggestion
decisions, and administrative actions.

### Secrets

Local server keys live only in ignored `.env.local`. Renderer-safe values are an
explicit `VITE_` allowlist containing API base URLs and the protocol name. Hosted
secrets, including `RESEND_API_KEY`, use separate Cloudflare secrets per region.
Cloudflare administrative credentials are local deployment inputs and never Worker
bindings.

Exceptions to the Gitleaks scan live in `.gitleaks.toml` as narrowly bounded
patterns rather than as suppressed paths or fingerprints, because those two fail in
opposite directions. A path exemption is permanent and total: it suppresses
**every** secret the scanner would ever find in the files it matches, including a
real credential pasted there later. A fingerprint is the reverse — it is
`commit:path:rule:line`, so it lapses as soon as the line moves, silencing one
finding while saying nothing about the next placeholder written beside it. A
bounded pattern is the only one of the three that keeps covering the file, survives
the line moving, and still refuses real key material.

**Prefer writing the fixture so it is not credential-shaped at all.** An exception
is a standing hole that every future secret is measured against; a placeholder that
avoids the marker a scanner keys on — the `eyJ` of a JWT header, a real PEM body —
costs one comment and widens nothing. Where an exception is genuinely warranted,
bound it on the thing a placeholder cannot fake, and add the bound to
`scripts/gitleaks-allowlist.test.mjs`.

## Invariants

- **The renderer never receives a secret.** No provider credentials, native PKCE
  verifiers, OpenRouter keys, Cloudflare administration keys, raw `ipcRenderer`,
  Node integration, or arbitrary navigation. A capability added to the preload
  bridge is a capability added to every page the renderer could ever be tricked
  into loading.
- **Every IPC argument is parsed before use**, and every exposed handler is
  validated against a live Avalon window and its pinned renderer origin.
- **A plaintext preference is never authority to unwrap a protected envelope.** An
  off Lockdown preference beside a Lockdown envelope deletes the local credentials
  and forces sign-in; it does not export the session.
- **Every write to `application-settings.json` goes through the one shared queue
  and re-reads before merging.** Two owners serializing on different primitives is
  how a lost update becomes a credential deletion on the next launch.
- **Nothing that protects data is scoped by a feature flag.** Flag targeting is a
  product scope; a flag that cannot be evaluated keeps its last answer, which is
  the wrong failure mode for a confidentiality boundary.
- **Every API resource query includes `workspace_id`; every mutation additionally
  resolves membership role.** Knowing an ID authorizes nothing.
- **Every connector tool checks execution principal, connection scope, granted
  capability, and resource visibility** — at execution, not only at admission.
- **A socket ticket never travels in a URL.** Cloudflare records whole request URLs
  into the invocation log, the Logpush export, and trace spans, and no redaction in
  this repository can reach them.
- **A WebSocket in the renderer is constructed only from a URL an authenticated
  ticket endpoint returned**, enforced by ESLint at each production constructor.
- **A URL schema names its accepted scheme contract explicitly.** Bare Zod URL
  validation accepts `javascript:` and `data:`.
- **A webhook is verified against its exact raw body before anything parses,
  stores, or queues it.**
- **A tool call is a proposal, never an instruction.** Name, schema, principal,
  capability, limits, and idempotency state are all checked before execution.
- **An inbound email address is a routing identifier, never an authenticator.** A
  From address that resembles a member buys a read-only run and nothing more.
- **An invitation token exists in D1 only as a SHA-256 hash**, and never in a query
  string, log, audit event, or Resend tag.
- **A Gitleaks exception is a bounded pattern**, never a path exemption or a
  fingerprint, and it ships with a case in
  `scripts/gitleaks-allowlist.test.mjs` proving it still rejects real material.

## Boundary

This document owns the trust boundaries and the mechanisms that enforce them. It
does not own the subsystems on either side of them:

| For | Read |
| --- | --- |
| The surfaces and how a request travels between them | [`architecture.md`](architecture.md) |
| Which region holds what, and what crosses | [`regionalization.md`](regionalization.md) |
| Tenancy columns and the visibility rule | [`data-model.md`](data-model.md) |
| Socket admission and the ticket format | [`realtime-sockets.md`](realtime-sockets.md) |
| Connector scopes, grants, and adapter invariants | [`connectors.md`](connectors.md) |
| The Slack scope inventory | [`slack-permissions.md`](slack-permissions.md) |
| Run admission, limits, and the inference ledger | [`agent-harness.md`](agent-harness.md) |
| The draft cache under `userData` | [`composer-drafts.md`](composer-drafts.md) |
| The windowless menu bar surface | [`menu-bar.md`](menu-bar.md) |
| Rotating a key or responding to an incident | [`runbook.md`](runbook.md) |

## Failure modes and limits

- **An ambiguous external write is never automatically repeated.** If a process
  stops after a provider write but before confirmation is stored, the invocation
  becomes `ambiguous`, the work stream becomes `needs_input`, and a person decides.
  This is retry safety, not a broad approval gate — a tool that has not been made
  idempotent has no protection here.
- **A lost custom-protocol notification is recoverable.** The durable connector
  attempt result lets the desktop reconcile success, denial, failure, or expiry
  regardless.
- **An unavailable keystore turns Lockdown mode off and requires sign-in**, rather
  than leaving an unreadable envelope in place.
- **Composer drafts are workspace content stored unencrypted** under `userData`,
  bounded by a 12-hour expiry and deleted on sign-out. No credential is ever
  written there.
- **A packaged helper carrying a restricted `com.apple.developer.*` entitlement is
  killed by AMFI only after the app reaches another machine.** The release verifier
  exists because that failure is invisible on the build host.
- **A credential-shaped string on any branch fails the `secrets` CI job
  everywhere.** The job checks out with `fetch-depth: 0`, so the history it scans
  spans every branch: the gate goes red on `main` and on every open pull request,
  including one that has never been merged and never will be. Because the scan
  reads commits rather than the working tree, editing the file afterwards does not
  clear it — only rewriting that branch's history does, which is the fix to reach
  for first.
- **One documented dependency advisory is accepted.** As of August 2026 the package
  audit still reports
  [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) against
  React Router 7.18.2. The vulnerable path is React Server Components action
  handling; Avalon is a bundled Electron client using `HashRouter` and has no RSC
  server, action decoder, or React server endpoint, so that path is not present.
  The release gate's rule is to upgrade patched transitive dependencies rather than
  suppress advisories — remove this exception as soon as React Router publishes a
  compatible patched stable release.

## Testing

Most of this is enforced by unit suites next to the code, plus two gates that have
no unit test standing in for them.

| Suite | Covers |
| --- | --- |
| `apps/desktop/src/main/*.test.ts` | Session encryption and the envelope versions, Lockdown migration, the settings write queue, the developer-settings flag suppression, launch-at-login, the menu bar's content fetch. |
| `apps/api/test/connector-credential-envelope.test.ts` | The AES-GCM envelope, its connection-bound additional authenticated data, and key-version rotation reads. |
| `apps/api/test/auth-session-lifecycle.test.ts` | Session minting, revocation, and single-use consumption. |
| `apps/api/test/rpc-contracts.test.ts` | That a cross-region rejection names field paths and never values. |
| `pnpm --filter @avalon/desktop test:release` | The entitlement rules, notarization, blockmap ordering, and the final verifier. CI runs this as a separate job — `pnpm test:scripts` does **not** cover `apps/desktop/scripts/`. |
| `scripts/gitleaks-allowlist.test.mjs` (`pnpm test:scripts`) | That every `.gitleaks.toml` pattern still rejects real key material. It fails when an exception is added without a case, because the scan itself only reports what it finds today and would not notice an exception that had been widened. |
| The `secrets` CI job | Gitleaks over the full history, all branches. |

The trap in the desktop suites is that they assert on the *stored* shape of a
credential. A test that constructs an envelope by hand rather than through
`session-encryption.ts` will keep passing after the envelope version moves, which
is exactly the change that needs the coverage.

## Operations

**Rotating `CONNECTOR_CREDENTIALS_KEY`.** During rotation, that secret contains
the new active key, `CONNECTOR_CREDENTIALS_KEY_VERSION` is incremented, and the
regional secret `CONNECTOR_CREDENTIALS_KEYS_JSON` temporarily maps every
still-referenced old numeric version to its old key. Reads decrypt with the row
version and opportunistically rewrite the row with the active key. Operators
remove an old mapping only after confirming no regional
`connector_connections.credential_key_version` rows still reference it. Global and
EU rotate independently. [`runbook.md`](runbook.md) owns the procedure and the
incident response that may prompt it.

## Changelog

No entries yet. This document predates the changelog rule in
[`module-documents.md`](module-documents.md#starting-one), and the reasoning behind
the boundaries above — beyond the reasons already written inline — was not recorded
here and was not reconstructed. `git log` and the PRDs under `docs/PRDs/` are what
exist. The next substantial change to a trust boundary starts the record, and that
entry is that change, written in full.
