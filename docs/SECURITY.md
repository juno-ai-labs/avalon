# Security model

## Trust boundaries

The renderer, inbound internet, connector providers, monitored URLs, model output, and connector payloads are untrusted. The Electron main process and regional Worker are trusted only within their narrow responsibilities. D1 and R2 are canonical storage services, not authorization layers.

## Electron

- `contextIsolation` is enabled, Node integration is disabled, and sandboxing is enabled.
- The packaged preload is emitted as CommonJS so Electron can load it inside the sandbox. Its bridge exposes a small named API and never exposes `ipcRenderer`, environment variables, filesystem paths, or arbitrary channel names.
- Every IPC argument is parsed before use.
- Navigation and popup creation are denied by default; OAuth opens in the system browser.
- A strict Content Security Policy allows bundled content and the configured regional API only.
- Refresh material uses `safeStorage` in the main process. The renderer receives short-lived access only through the narrow session bridge.
- The custom `avalon://` callback carries one opaque, expiring, single-use ticket—never Google or connector tokens.
- The native Settings window uses the same sandbox, preload, CSP, navigation denial, and regional session bridge as the main window. **Command-,** opens a singleton window rather than a privileged remote page.

### macOS distribution and updates

Avalon's production identity is pinned to bundle ID `app.avalon.desktop` and Apple team `7ZLT6A8W25`. Squirrel.Mac cannot safely update across either boundary, so changing them requires a deliberate manual-reinstall migration. Release packaging never auto-selects a certificate.

The main app and Electron helpers use separate entitlement files. In particular, renderer/GPU/plugin helpers, Squirrel `ShipIt`, and `chrome_crashpad_handler` must contain exactly `com.apple.security.cs.allow-jit` and `com.apple.security.network.client`. Restricted `com.apple.developer.*` entitlements are forbidden there: a provisioning profile for the main bundle ID does not authorize helper bundle IDs, and macOS AMFI can otherwise kill those helpers only after the app reaches another machine. The release verifier parses the final signed entitlements, requires the pinned Developer ID team and an arm64 slice for every one of those executables, and then proves a renderer remains alive under a clean user-data profile.

Both `Avalon.app` and the DMG container are signed, submitted to Apple's notary service, and stapled. The DMG is blockmapped only after signing and stapling mutate its bytes; `latest-mac.yml` is generated from the final ZIP. Before R2 promotion, Gatekeeper, stapler, bundle ID/version, updater URL, final blockmaps, nested signatures, and a LaunchServices smoke all have to pass. The update transport is still treated as untrusted: electron-updater's macOS signature validation remains the execution trust boundary, while R2 publication uses immutable versioned objects and promotes the mutable feed last.

## Authentication and authorization

Google identity OAuth uses state and PKCE. The desktop starts it with POST, then opens only the provider URL containing opaque state. The temporary `/auth/desktop/` page validates the exact custom-protocol target, keeps the ticket in the URL fragment, applies `no-store`/`no-referrer`, removes the fragment immediately, and never renders or logs it. Connector consent is a separate incremental flow. OAuth states and desktop tickets are expiring and atomically consumed. Refresh tokens are hashed for sessions or AES-GCM encrypted for providers.

Every API resource query includes `workspace_id`. Mutations additionally resolve membership role. Every connector tool checks its execution principal, connection scope, granted capability, and resource visibility. Workspace-scoped connector capabilities roll down to every work stream in that workspace and execute as the workspace principal; participants do not implicitly share their personal connectors.

WebSocket upgrades require an exact match against `ALLOWED_ORIGINS`; missing origins and suffix lookalikes are rejected before the short-lived socket ticket is forwarded to a room. Tickets bind user, workspace, work stream, region, and one-time ID, and the room atomically rejects reuse.

## Side effects and retries

Tool arguments are runtime-validated and canonically hashed. The system records a write as started before provider execution and reuses completed results on workflow retry. If a process stops after a provider write but before confirmation is stored, the invocation becomes `ambiguous`, the work stream becomes `needs_input`, and the write is not automatically repeated.

This is retry safety, not a broad approval gate.

## Connector credentials

Provider refresh tokens remain in the regional backend, encrypted with AES-GCM and additional authenticated data tied to the connection ID. Key version is stored beside ciphertext so rotation can decrypt with an old key and re-encrypt with the active key. Global and EU deployments use independent keys.

Google scopes are requested incrementally. Sign-in does not grant Gmail, Calendar, or Drive access. Revoked/expired grants become an explicit reconnect state.

## Webhooks and outbound fetches

Generic webhooks use an endpoint-specific secret, a timestamped HMAC-SHA256 signature, a bounded replay window, a stored receipt, schema validation, size limits, and provider dedupe keys.

Web monitoring allows only HTTP(S), rejects obvious local/private targets, bounds redirects, time, bytes, and content types, and hashes readable content before semantic processing. Hosted egress policy should additionally perform DNS/IP enforcement to prevent rebinding.

## Model boundary

OpenRouter credentials and model context are server-only. The harness receives only context authorized for the execution principal. Tool calls are proposals: Avalon validates the name, schema, principal, capability, limits, and idempotency state before execution. Reasoning fields are ignored; private chain-of-thought is neither persisted nor broadcast.

## Logging and audit

Structured logs include correlation IDs and domain IDs needed for operations. Redaction removes authorization headers, tokens, OAuth codes, credential ciphertext, email/file bodies, raw provider payloads, and model context. User-visible failures are persisted in product state so recovery does not depend on provider logs.

Workspace invitation tokens are random bearer secrets stored only as SHA-256 hashes in D1. The plaintext token exists transiently in the regional Worker, the Resend transactional request, the recipient's email, and the fragment-protected browser/deep-link handoff. It is never placed in a query string, log, audit event, or Resend tag. Resend uses a send-only API key and a stable per-invitation idempotency key; an outbound provider failure revokes the new invitation before the API returns an error.

Audit events cover sign-in/session changes, membership, connector authorization/revocation, external writes, automation changes, suggestion decisions, and administrative actions.

## Secrets

Local server keys live only in ignored `.env.local`. Renderer-safe values are an explicit `VITE_` allowlist containing API base URLs and the protocol name. Hosted secrets, including `RESEND_API_KEY`, use separate Cloudflare secrets per region. Cloudflare administrative credentials are local deployment inputs and never Worker bindings.
