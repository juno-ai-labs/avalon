# Assumptions

These choices resolve low-level ambiguity without changing the product contract.

1. The prototype uses one workspace per initial Google-authenticated user. Invitations and additional memberships are supported by the schema/API, but workspace switching is deferred.
2. Global and EU deployments run identical code with separate bindings. Local development uses one emulated region at a time and a header-gated development identity only when `AVALON_DEV_AUTH=true`.
3. The Hono API is the only public application backend. Electron loads a bundled renderer and never loads an arbitrary hosted page into its privileged window.
4. UUIDv7 identifiers are generated at the service boundary for sortable uniqueness.
5. D1 stores searchable metadata and complete short text messages. R2 stores uploads, large connector payloads, snapshots, and artifacts.
6. OpenRouter model names are configuration, with conservative defaults documented in `.env.example`; no model selector appears in product UI.
7. Google APIs are implemented directly over their documented REST endpoints so connector behavior remains Worker-compatible and the dependency surface stays small.
8. A development seed is explicit and test-only. Production startup never creates demo records and the desktop does not silently fall back to hardcoded data.
9. The supplied screenshots define density, proportions, typography, color, transcript alignment, run-history treatment, and right-rail behavior. Their product-specific labels are examples, not data to hardcode into production.
10. The contextual right rail is 360px by default, hidden on initial work-stream entry, resizable from 320–420px, and becomes an accessible overlay below 960px. Its active content can be `People & resources`, `Background tasks`, or `Run history` according to the current screen.
11. Background-task cards are derived from persisted harness/tool events. Transcript links focus the corresponding event; they do not open a second chat abstraction.
12. The provided `.env.local` remains untracked. Existing keys are preserved. Missing provider credentials produce explicit setup errors while their complete integration paths remain testable with fixtures.
13. Cloudflare resource creation/deployment is attempted only after local verification and only when the supplied account credentials satisfy Wrangler authentication. No existing named resource is deleted or replaced.
14. “Packageable Electron application” means a reproducible platform build configuration and successful unpacked packaging on the current host; code-signing/notarization credentials are outside the prototype prerequisites.
15. Application → Developer → **Debug enabled** is a per-device preference stored beside Lockdown mode in `application-settings.json`, not workspace state, because it describes how this installation behaves rather than what the workspace is. Its menu entries follow the product's spelling — **Copy work stream id** and **Copy automation id** — and sit with the non-destructive actions, above the separator that isolates Archive.
