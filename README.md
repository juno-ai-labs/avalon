# Rally

Rally is a work-stream-first desktop workspace where people and an agent collaborate in the same durable context. It combines an Electron desktop client with a regional Hono API on Cloudflare Workers, D1, R2, Durable Objects, Queues, and Workflows.

The product includes:

- Ad-hoc and automation-created work streams with multiplayer presence, participants, resources, messages, structured questions, and activity suggestions.
- A bounded Bind 10 adapter over OpenRouter with credential-scoped connector plugins, immutable run authority, streamed responses, durable tool receipts, and classified fallback routing.
- Versioned natural-language automations with calendar, interval, connector-activity, semantic-activity, and manual triggers.
- Google Mail + Calendar and Google Drive + Docs + Sheets presets backed by one incrementally scoped Google connector family; smart-routed public GitHub, Linear, and Slack apps; public Notion connection; and signed generic webhooks.
- Firecrawl-backed public web search and clean-markdown page fetch tools, available only from the server-side agent harness.
- Global and European Union workspace regions with separate deployment configurations.
- Hibernating work-stream WebSockets with bounded room replay, turn/epoch stream resets, duplicate suppression, and REST resynchronization.
- Electron organization signup, Resend-delivered regional invitations, and a native Settings window available with **Command-,**.
- A contextual right sidebar for people and resources, run history, and focused item details.

## Repository

```text
apps/desktop           Electron main/preload and React renderer
apps/api               Hono Cloudflare Worker and runtime components
apps/release-retention Scheduled R2 desktop-release archival Worker
packages/contracts     Shared Zod contracts
packages/db            D1 migration, repositories, and explicit local seed
packages/agent-harness Bind 10/OpenRouter adapter, prompts, classifiers, and tool execution
packages/connectors    Google, GitHub, Linear, Notion, Slack, and webhook adapters
docs                   Product, architecture, security, and operations
```

## Local setup

Prerequisites are Node.js 22 or newer and pnpm 11.

1. Keep local keys in `.env.local`. The file is ignored by Git and must never contain `VITE_`-prefixed secrets. Use [.env.example](.env.example) as the complete variable reference.
2. Install dependencies with `pnpm install`.
3. Create the local database with `pnpm db:migrate`.
4. Add the explicit development records with `pnpm db:seed`.
5. Start the API and desktop together with `pnpm dev`.
6. Sign in to the single Rally platform. After authentication, existing members enter their workspace, invited users can accept or decline pending invitations, and only users with neither choose an organization name and Global or European Union storage.

`pnpm env:sync` copies only the server allowlist from `.env.local` into an ignored, owner-readable Worker file. Missing development signing and encryption values are generated once and then retained across restarts.

The default primary model is `x-ai/grok-4.3` through OpenRouter. Classifier and structured-output work remains on `google/gemini-2.5-flash-lite`. Override the three `OPENROUTER_*_MODEL` values in `.env.local` when testing other models; the API key remains server-only.

## Desktop identity and settings

Fresh installs first sign in to the single Rally platform. Google authentication opens in the system browser, briefly passes through `https://with-avalon.com/auth/desktop/`, and returns one opaque, single-use ticket to `avalon://auth/complete`; the browser handoff validates and immediately removes its fragment. Each ticket is bound to a native S256 challenge and can be redeemed only with the verifier retained in Electron main-process memory. After sign-in, Rally discovers existing memberships and email-bound invitations across both regions. Existing members enter their workspace, invited users can accept or decline, and only users with neither see organization setup and the immutable Global/European Union selector.

Open **Rally → Settings…** or press **Command-,** on macOS. The native Settings window exposes account/session controls, application and regional diagnostics, the locked organization region, members, and role-gated invitation sending, copy, history, and revocation. Production invitations are sent through Resend from `invites@with-avalon.com`; the fragment-protected one-time link remains available as a copyable fallback.

Settings also offers **Google Mail + Calendar** and **Google Drive + Docs + Sheets** as separate consent presets. They use one Google adapter and can be connected independently for personal or workspace use. The second preset provides native Google Docs and Sheets read/write tools; Docs and Sheets change activity is derived from Drive change-token polling. Google push webhooks are not implemented. The connector documentation carries the exact capabilities and tools.

## Brand

The public site's pages render the redesigned vector mark (`apps/site/public/brand/rally-mark.svg`, plus a thicker-stroke small cut), and `assets/brand/rally-mark.png` plus the provider-manifest URL `/brand/rally-mark.png` were re-rendered from that vector. The generator `scripts/generate-brand-assets.py` still holds the earlier woven mark in its source mask — do not rerun it until the mask is redrawn from the new vector, or it will regress both PNGs; the desktop icons, favicon, and social card carry the woven mark until that regeneration. The macOS app uses the native Icon Composer asset at `apps/desktop/resources/icon.icon`, allowing the system to own its enclosure, effects, and appearance treatment; a generated ICNS remains only for the DMG volume. Read the desktop application icon documentation before changing the artwork. Brand primary is `#CCFF00`; secondary is `#47C7FC`.

## Quality commands

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm package:desktop
pnpm start:desktop:packaged
pnpm package:desktop:release
pnpm publish:desktop:release -- --dry-run
```

`pnpm package:desktop` builds a Developer ID-signed local QA app into `apps/desktop/release/local` and verifies its complete bundle before publishing it. `pnpm start:desktop:packaged` launches that app through macOS LaunchServices against the production Rally APIs. Do not invoke `Rally.app/Contents/MacOS/Rally` directly from a sandboxed terminal.

Distribution builds use `pnpm package:desktop:release`. Local releases require an explicit `CSC_NAME` whose Developer ID identity is already on the user Keychain search list, plus one complete Apple notarization credential set in `.env.local`; the release packager deliberately rejects `CSC_LINK`. For a stable local notary profile, store it in an explicit Keychain (for example `xcrun notarytool store-credentials "Rally Notary Local" --apple-id <email> --team-id 7ZLT6A8W25 --keychain "$HOME/Library/Keychains/login.keychain-db"`) and configure both `APPLE_KEYCHAIN_PROFILE` and `APPLE_KEYCHAIN`. CI may receive a base64 PKCS#12 as `CSC_LINK`, but the workflow imports it into a temporary user-search-list Keychain before invoking the packager so electron-builder and the final DMG-signing hook see the same identity. The release pipeline notarizes the application and DMG, verifies Gatekeeper and both stapled tickets, exercises a clean-profile renderer launch, and only then publishes `apps/desktop/release/release`. The database seed is never run automatically by production startup. Packaged builds also disable development authentication regardless of local environment values.

Desktop releases use the dedicated `avalon-desktop-releases` R2 bucket and `downloads.with-avalon.com` custom domain, never a regional workspace-data bucket. Run `pnpm publish:desktop:release -- --dry-run` to validate the complete local transaction without cloud credentials or mutations. A live publish requires `--confirm <exact-version>` and uploads versioned DMG, ZIP, blockmaps, and `SHA256SUMS` objects first; verifies their R2 hashes and public HEAD/Range behavior; promotes the purged `Rally.dmg` recovery alias; and uploads `latest-mac.yml` last. Only after that manifest verifies does it activate the site release config. Normal site deploys rediscover the committed public manifest and canonical DMG, so the stable download remains active without persisting a CI-only source edit.

Version policy: every new Rally release advances the minor version by exactly one and resets the patch to zero. The one stable-promotion exception permits a `0.x` release to advance to `1.0.0`; releases then continue by minor version (`1.0.0` → `1.1.0`). After publishing, set the root and desktop package versions to the next development release. Patch releases, prereleases, skipped minor versions, and other major-version jumps are rejected by the release tooling. Keep `apps/site/release.config.json` on the last verified, published version until the release publisher promotes the next build.

## Documentation

[The documentation index](docs/README.md) is the single registry: it lists every product, architecture, agent, connector, development, and operations document with the scope each one owns, and which to read before touching an area. Start there rather than looking for a reading list here.

## Hosted deployment

`with-avalon.com`, `api.with-avalon.com`, and `eu.api.with-avalon.com` are deployed. The Global and EU D1 migrations are current, both regional infrastructure health checks pass, and Firecrawl, Resend invitation delivery, and inbound work-stream and automation email are configured. Base Google OAuth credentials and callbacks are configured; the expanded Google APIs, consent-screen review, and both preset acceptance flows remain release gates. The public `Rally With AI` GitHub App and public Linear app are deployed with their regional secrets, callbacks, and signed ingress. A user-started GitHub installation/OAuth acceptance run and the regional Notion registrations remain provider-acceptance gates. Follow the provider-app runbook before end-user acceptance.

Cloudflare deployment credentials remain local-only in `.env.local`; they are never uploaded as Worker variables. Google provider credentials are stored only as encrypted Worker secrets. Follow the operations runbook for regional secret management, migrations, health verification, deployment, and provider acceptance.
