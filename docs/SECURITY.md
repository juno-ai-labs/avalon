# Security model

## Trust boundaries

The renderer, inbound internet, connector providers, monitored URLs, model output, and connector payloads are untrusted. The Electron main process and regional Worker are trusted only within their narrow responsibilities. D1 and R2 are canonical storage services, not authorization layers.

## Electron

- `contextIsolation` is enabled, Node integration is disabled, and sandboxing is enabled.
- The packaged preload is emitted as CommonJS so Electron can load it inside the sandbox. Its bridge exposes a small named API and never exposes `ipcRenderer`, environment variables, filesystem paths, or arbitrary channel names.
- Every IPC argument is parsed before use.
- Navigation and popup creation are denied by default; OAuth opens in the system browser.
- A strict Content Security Policy allows bundled content and the configured regional API only.
- Refresh material is encrypted in the main process. By default the desktop uses an application-wide embedded key so a saved session survives signing-identity and keystore changes. Application → **Lockdown mode** replaces that with Electron `safeStorage`, binding the saved authentication state to the operating-system keystore. An in-app toggle re-encrypts every durable session component before committing the new preference. The plaintext preference lives in owner-readable `application-settings.json` under Electron's `userData` directory. If that file is edited to turn Lockdown off while a Lockdown credential envelope remains, Avalon removes only local credential-bearing files and requires sign-in instead of exporting the protected session. An unavailable keystore also turns Lockdown off and requires sign-in automatically. The renderer receives short-lived access only through the narrow session bridge.
- The custom `avalon://` callback carries only an opaque, expiring, single-use login ticket or a non-secret connector result—never provider codes or tokens.
- Unsent composer drafts—their text and the bytes of their attachments—are cached in the renderer's IndexedDB so a restart does not discard them. They are workspace content stored unencrypted under Electron's `userData` directory, they expire after 12 hours, and signing out deletes every one of them. Nothing else is written there, and no credential ever is. [`composer-drafts.md`](composer-drafts.md) owns the mechanism.
- The native Settings window uses the same sandbox, preload, CSP, navigation denial, and regional session bridge as the main window. **Command-,** opens a singleton window rather than a privileged remote page.
- Application → Developer → **Debug enabled** shares the same `application-settings.json` file but crosses no trust boundary: it only reveals debugging affordances the renderer already holds, such as copying a work stream's or automation's identifier from its right-click menu or reading the wiring rows of the right rail's **Details** section. It is off by default and turning it on grants no additional data, capability, or IPC surface. The section it sits in is offered only where the service's `developer-settings` flag says so, and the main process reports the stored preference as `false` while that flag is off, so a hand-edited `debugEnabled: true` reveals nothing — see [`FEATURE_FLAGS.md`](FEATURE_FLAGS.md). That gate scopes a staff tool to staff; it is not a confidentiality boundary, which is why a poll that cannot reach the service keeps its last answer rather than closing the section. Because the two preferences have separate owners that serialize on different primitives, every write to the file goes through one shared queue and re-reads before it merges: a lost update here would leave an off Lockdown preference beside a Lockdown envelope, which the next launch treats as an out-of-app edit and answers by deleting the stored credentials.

### macOS distribution and updates

Avalon's production identity is pinned to bundle ID `app.avalon.desktop` and Apple team `7ZLT6A8W25`. Squirrel.Mac cannot safely update across either boundary, so changing them requires a deliberate manual-reinstall migration. Release packaging never auto-selects a certificate.

The main app and Electron helpers use separate entitlement files. In particular, renderer/GPU/plugin helpers, Squirrel `ShipIt`, and `chrome_crashpad_handler` must contain exactly `com.apple.security.cs.allow-jit` and `com.apple.security.network.client`. Restricted `com.apple.developer.*` entitlements are forbidden there: a provisioning profile for the main bundle ID does not authorize helper bundle IDs, and macOS AMFI can otherwise kill those helpers only after the app reaches another machine. The release verifier parses the final signed entitlements, requires the pinned Developer ID team and an arm64 slice for every one of those executables, and then proves a renderer remains alive under a clean user-data profile.

Both `Avalon.app` and the DMG container are signed, submitted to Apple's notary service, and stapled. The DMG is blockmapped only after signing and stapling mutate its bytes; `latest-mac.yml` is generated from the final ZIP. Before R2 promotion, Gatekeeper, stapler, bundle ID/version, updater URL, final blockmaps, nested signatures, and a LaunchServices smoke all have to pass. The update transport is still treated as untrusted: electron-updater's macOS signature validation remains the execution trust boundary, while R2 publication uses immutable versioned objects and promotes the mutable feed last.

## Authentication and authorization

Google identity OAuth uses state and PKCE. The desktop starts it with POST, then opens only the provider URL containing opaque state. Every identity and connector callback is completed by the owning regional server before the temporary `/auth/desktop/` page receives an exact custom-protocol target in its URL fragment. The page applies `no-store`/`no-referrer`, removes the fragment immediately, and never renders or logs the target. Connector consent is a separate incremental flow whose durable attempt result lets the desktop reconcile success, denial, failure, or expiry even if the custom-protocol notification is lost. OAuth states and desktop tickets are expiring and atomically consumed. Refresh tokens are hashed for sessions or AES-GCM encrypted for providers.

Every API resource query includes `workspace_id`. Mutations additionally resolve membership role. Every connector tool checks its execution principal, connection scope, granted capability, and resource visibility. Workspace-scoped connector capabilities roll down to every work stream in that workspace and execute as the workspace principal; participants do not implicitly share their personal connectors.

WebSocket upgrades require an exact match against `ALLOWED_ORIGINS`; missing origins and suffix lookalikes are rejected before the short-lived socket ticket is forwarded to a room. Tickets bind user, workspace, work stream, region, and one-time ID, and the room atomically rejects reuse.

Renderer WebSockets may be constructed only from a URL returned by the authenticated work-stream or transcription ticket endpoints; ESLint enforces that provenance at each production constructor. Runtime URL schemas likewise name their accepted scheme contract explicitly—HTTP(S), HTTPS-only, `avalon:`, or the intentional HTTP(S)/Avalon handoff union. Bare Zod URL validation is forbidden because it accepts non-web schemes such as `javascript:` and `data:` while hiding the product boundary being enforced.

## Side effects and retries

Tool arguments are runtime-validated and canonically hashed. The system records a write as started before provider execution and reuses completed results on workflow retry. If a process stops after a provider write but before confirmation is stored, the invocation becomes `ambiguous`, the work stream becomes `needs_input`, and the write is not automatically repeated.

This is retry safety, not a broad approval gate.

## Connector credentials

Provider refresh tokens remain in the regional backend, encrypted with AES-GCM and additional authenticated data tied to the connection ID. Key version is stored beside ciphertext so rotation can decrypt with an old key and re-encrypt with the active key. Global and EU deployments use independent keys.

During rotation, `CONNECTOR_CREDENTIALS_KEY` contains the new active key, `CONNECTOR_CREDENTIALS_KEY_VERSION` is incremented, and the regional secret `CONNECTOR_CREDENTIALS_KEYS_JSON` temporarily maps every still-referenced old numeric version to its old key. Reads decrypt with the row version and opportunistically rewrite the row with the active key. Operators remove an old mapping only after confirming no regional `connector_connections.credential_key_version` rows still reference it.

Granola Workspace API keys and the signing secrets returned while registering Granola webhook endpoints use the same versioned credential envelope and connection-bound additional authenticated data. The admin setup form treats the key as a password and submits it once to the selected regional backend. Plaintext keys and signing secrets are excluded from connection configuration, API responses, provider identifiers, audit metadata, and logs. Personal Granola OAuth and refresh credentials remain user-scoped; workspace keys remain workspace-scoped.

Google scopes are requested incrementally. Sign-in does not grant Gmail, Calendar, or Drive access. Revoked/expired grants become an explicit reconnect state.

## Webhooks

Generic webhooks use an endpoint-specific secret, a timestamped HMAC-SHA256 signature, a bounded replay window, a stored receipt, schema validation, size limits, and provider dedupe keys.

Granola webhooks are verified using the Standard Webhooks `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers over the exact raw request body. Verification and size checks happen before JSON parsing, R2 persistence, receipt creation, or queueing.

## Model boundary

OpenRouter credentials and model context are server-only. The harness receives only context authorized for the execution principal. Tool calls are proposals: Avalon validates the name, schema, principal, capability, limits, and idempotency state before execution. Reasoning fields are ignored; private chain-of-thought is neither persisted nor broadcast.

## Logging and audit

Structured logs include correlation IDs and domain IDs needed for operations. Redaction removes authorization headers, tokens, OAuth codes, credential ciphertext, email/file bodies, raw provider payloads, and model context. User-visible failures are persisted in product state so recovery does not depend on provider logs.

Workspace invitation tokens are random bearer secrets stored only as SHA-256 hashes in D1. The plaintext token exists transiently in the regional Worker, the Resend transactional request, the recipient's email, and the fragment-protected browser/deep-link handoff. It is never placed in a query string, log, audit event, or Resend tag. Resend uses a send-only API key and a stable per-invitation idempotency key; an outbound provider failure revokes the new invitation before the API returns an error.

Work-stream inbound addresses are routing identifiers, never authenticators. Resend webhooks are verified against their untouched raw body before parsing and deduplicated by delivery ID. Received HTML, headers, attachments, sender identities, and quoted content are untrusted. Incoming mail is attached as a regional resource and system message; it never launches a write-capable agent run merely because the From address resembles a workspace member. Friendly addresses are immutable and permanently reserved so a stale sender can never reach a different work stream.

Automation email may start a read-only run, but the sender match remains defense in depth rather than authenticated identity. Those runs receive no external connector writes and no outbound web tools, and an atomic per-address hourly budget bounds model spend if an address leaks or a sender is spoofed.

Audit events cover sign-in/session changes, membership, connector authorization/revocation, external writes, automation changes, suggestion decisions, and administrative actions.

## Dependency advisories

The release gate upgrades patched transitive dependencies rather than suppressing advisories. As of August 2026, the package audit still reports [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) against React Router 7.18.2. The vulnerable path is React Server Components action handling; Avalon is a bundled Electron client using `HashRouter` and has no RSC server, action decoder, or React server endpoint, so that path is not present. Remove this documented exception as soon as React Router publishes a compatible patched stable release.

## Secrets

Local server keys live only in ignored `.env.local`. Renderer-safe values are an explicit `VITE_` allowlist containing API base URLs and the protocol name. Hosted secrets, including `RESEND_API_KEY`, use separate Cloudflare secrets per region. Cloudflare administrative credentials are local deployment inputs and never Worker bindings.
