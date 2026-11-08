# Rally

Rally is a desktop and browser workspace in which people and an agent work in
the same durable context. It has two sections: **Canvases**, each a
conversation (its Chat) and the artifacts it generates, and **Sidekicks**,
natural-language automations that run on a schedule, on connector activity,
on an inbound email, or on demand. Avalon is the internal code name and still
appears throughout the tree.

The clients are a macOS Electron app and a browser SPA. The backend is a
regional Hono API on Cloudflare Workers, with D1, R2, Durable Objects, Queues
and Workflows; agent inference goes through OpenRouter from the server only.

## Repository

```text
apps/desktop            Electron main/preload and the React renderer both clients share
apps/browser            Browser host for the shared renderer
apps/api                Regional Hono Worker, its Durable Objects and runtime components
apps/site               Public site: landing page, help centre, blog, compare and trust pages
apps/ace                Internal administration Worker
apps/engineering-mcp    Internal engineering MCP server
apps/migration-tracker  Durable Object migration reporting site
apps/release-retention  Scheduled R2 desktop-release archival Worker
packages/contracts      Shared Zod contracts
packages/db             D1 migrations, repositories, and the explicit local seed
packages/agent-harness  OpenRouter adapter, prompts, classifiers, and tool execution
packages/connectors     Connector adapters (Google, GitHub, Linear, Notion, Slack, and others)
packages/electron-network  Chromium upload transport shared by the Electron apps
packages/ui             Shared desktop/browser components and themes
docs                    Product, architecture, security, and operations
```

## Local setup

Prerequisites are Node.js 22 or newer and pnpm 11.

1. Keep local keys in `.env.local`. The file is ignored by Git and must never contain `VITE_`-prefixed secrets. Use [.env.example](.env.example) as the complete variable reference.
2. Install dependencies with `pnpm install`.
3. Create the local database with `pnpm db:migrate`.
4. Add the explicit development records with `pnpm db:seed`.
5. Start the API and desktop together with `pnpm dev` (`pnpm dev:browser` serves the browser client).

`pnpm env:sync` copies only the server allowlist from `.env.local` into an ignored, owner-readable Worker file. Missing development signing and encryption values are generated once and then retained across restarts. The full procedure, including the sandbox and headless Electron, is in the development-environment document in the index below.

The models are the four `OPENROUTER_*_MODEL` values (primary, fallback, classifier, structured output) in the Worker configuration; override them in `.env.local` to test others. The OpenRouter key is server-only.

## Quality commands

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm docs:check
```

## Desktop builds and releases

```text
pnpm package:desktop
pnpm start:desktop:packaged
pnpm package:desktop:release
pnpm publish:desktop:release -- --dry-run
```

`pnpm package:desktop` builds a Developer ID-signed local QA app into `apps/desktop/release/local`; `pnpm start:desktop:packaged` launches it through macOS LaunchServices against the production Rally APIs. Do not invoke `Rally.app/Contents/MacOS/Rally` directly from a sandboxed terminal. Distribution builds use `pnpm package:desktop:release`, and a live publish requires `--confirm <exact-version>`. Signing, notarization, the Stable and Faster update channels, the version policy and release retention are owned by the operations runbook. The database seed never runs in production, and packaged builds disable development authentication regardless of local environment values.

## Brand

The mark is a tennis-ball seam on a sphere, drawn as one line. `scripts/generate-rally-mark.py` generates every vector copy from the seam equation, and `scripts/generate-brand-assets.py` renders the rasters; the macOS app icon is the Icon Composer asset at `apps/desktop/resources/icon.icon`. The desktop-icons document owns the pipeline; read it before changing the artwork.

## Documentation

[The documentation index](docs/README.md) is the single registry: it lists every product, architecture, agent, connector, development, and operations document with the scope each one owns, and which to read before touching an area. Start there rather than looking for a reading list here.

## Hosted deployment

Cloudflare deployment credentials remain local-only in `.env.local`; they are never uploaded as Worker variables. Provider credentials are stored only as encrypted Worker secrets. The operations runbook covers regional secret management, migrations, health verification, and deployment.
