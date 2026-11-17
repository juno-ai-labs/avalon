# Rally

Rally is a desktop and browser workspace in which people and an agent work in
the same durable context. It has two sections: **Canvases**, each a
conversation (its Chat) and the artifacts it generates, and **Sidekicks**,
natural-language automations triggered on a calendar or interval schedule, by
connector or semantic activity, by a watched resource, a webhook or an inbound
email, or by hand. Avalon is the internal code name and still
appears throughout the tree.

The clients are a macOS Electron app and a browser SPA. The backend is a
Global and regional Hono API on Cloudflare Workers, with D1, R2, Durable Objects, Queues
and Workflows; agent inference goes through OpenRouter from the server only.

## Repository

```text
apps/desktop            Electron main/preload and the React renderer both clients share
apps/browser            Browser host for the shared renderer
apps/api                Global and regional Hono Worker, its Durable Objects and runtime components
apps/site               Public site: landing page, help centre, blog, compare and trust pages
apps/engineering-mcp    Internal engineering MCP server
apps/release-retention  Scheduled R2 desktop-release archival Worker
packages/contracts      Shared Zod contracts
packages/db             D1 migrations, repositories, and the explicit local seed
packages/agent-harness  OpenRouter adapter, prompts, classifiers, and tool execution
packages/connectors     Connector adapters (Google, GitHub, Linear, Notion, Slack, and others)
packages/electron-network  Chromium upload transport for the Electron main process
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

Before packaging locally, get the existing `RALLY_DESKTOP_SESSION_KEY` from a
desktop release maintainer and set it in the ignored `.env.local`. Both
packaging commands read this file and verify that the key matches existing
installs so the packaged app can open their saved sessions.

```text
pnpm package:desktop
pnpm start:desktop:packaged
pnpm package:desktop:release
pnpm publish:desktop:release -- --dry-run
```

`pnpm package:desktop` builds a Developer ID-signed local QA app into `apps/desktop/release/local`; `pnpm start:desktop:packaged` launches it through macOS LaunchServices against the production Rally APIs. Do not invoke `Rally.app/Contents/MacOS/Rally` directly from a sandboxed terminal. Distribution builds use `pnpm package:desktop:release`, and a live publish requires `--confirm <exact-version>`. Signing, notarization, the Stable and Faster update channels, the version policy and release retention are owned by the operations runbook. The local seed is never run by production startup, and packaged builds disable development authentication regardless of local environment values.

## Brand

The mark is a tennis-ball seam on a sphere, drawn as one line. `scripts/generate-rally-mark.py` generates every vector copy from the seam equation, and `scripts/generate-brand-assets.py` renders the rasters; the macOS app icon is the Icon Composer asset at `apps/desktop/resources/icon.icon`. Brand primary is `#CCFF00` (volt); secondary is `#47C7FC`. The desktop-icons document owns the pipeline; read it before changing the artwork.

## Documentation

[The documentation index](docs/README.md) is the single registry: it lists every product, architecture, agent, connector, development, and operations document with the scope each one owns, and which to read before touching an area. Start there rather than looking for a reading list here.

## License

Rally is dual licensed under the GNU AGPL v3 and a commercial license from
Juno AI Labs Inc. See [LICENSING.md](LICENSING.md) for the terms, what they do
not cover, and the Contributor License Agreement.

## Hosted deployment

Cloudflare deployment credentials remain local-only in `.env.local`; they are never uploaded as Worker variables. Provider credentials are stored only as encrypted Worker secrets. The operations runbook covers regional secret management, migrations, health verification, and deployment.

## Manual setup for a new hosted deployment

Standing Rally up on fresh Cloudflare, GitHub, Apple and Expo accounts still
takes the one-time steps below. The operations runbook has the exact values and
order for each. The goal is to automate this list away; remove an item here in
the change that automates it.

The deploy workflows already create these, so they are not on the list: R2
buckets a Worker binds (Wrangler creates them on deploy), Queues and their dead-letter queues, D1
databases and KV namespaces (found by name and their ids pinned into the
Wrangler files during the deploy), D1 migrations, Worker custom domains on
existing zones, the engineering MCP's Worker secrets and Access settings, the lakehouse
pipelines (reconciled, with the account's own stream IDs adopted, on a deploy to
any account other than the pinned one).

### Cloudflare account and zones

- Create the account and add the zones `rallywith.ai`, `with-avalon.com` and
  `rallyusercontent.com`.
- Create the deploy API token, scoped to the account and those zones, with the
  permissions the runbook lists. Rotate any broader bootstrap token afterwards.
- Add `*.api.rallywith.ai` to an Advanced Certificate Manager pack (a paid
  add-on) and wait until it is active.
- DNS: a proxied wildcard `AAAA *.rallyusercontent.com -> 100::` for artifact
  hosting, and the `probe-redirect` and `probe-private` records the terminal
  network probes use.
- Zone settings: Always Use HTTPS on, and HSTS with a one-year max-age,
  `includeSubDomains` and `nosniff`.
- Turn on Email Sending and verify `rallywith.ai`, keeping its MX, SPF and DKIM
  records.
- Create the desktop release archive bucket with its location and storage
  class, and attach `downloads.rallywith.ai` as an R2 custom domain on
  `avalon-desktop-releases`.
- Deploy the release-retention Worker with `pnpm deploy:release-retention`, and
  again after each change to it. No workflow deploys it.
- Set up a Zero Trust team and identity provider, and create the Access
  application and policy for `mcp.internal.rallywith.ai` before its first deploy.
- Make sure Workers Paid, Containers, Browser Run, Images, Workers AI and
  Analytics Engine are available on the account.
- Run `pnpm cloudflare:observability` once for Logpush and the saved
  Observability views. No workflow runs it.

### GitHub repository

Create the environments `api-production`, `site-production`, `desktop-release`
and `mobile-production`, without required reviewers on `api-production`. Each
needs the `CLOUDFLARE_API_TOKEN` secret and the `CLOUDFLARE_ACCOUNT_ID` variable
its workflows read, plus:

- `api-production`: the engineering MCP's Cloudflare tokens, and the Daytona key,
  URL, target and snapshot pull-request token the weekly terminal snapshot
  rebuild uses.
- `desktop-release`: the Apple notarization key, Developer ID certificate and
  password, provisioning profile, desktop session key, a release GitHub token,
  the zone id, and the release and telemetry bucket names.
- `mobile-production`: `EXPO_TOKEN`.

The workflows name every secret and variable they read.

### Third-party providers

Register each by hand and store its credentials as Worker secrets:

- Google: the sign-in and connector OAuth clients, the consent screen and scope
  verification.
- Sign in with Apple: the Services ID, key, domains, return URLs and private
  relay senders.
- The GitHub App, Linear OAuth app, Slack app and Notion connection, from the
  manifests in `config/provider-apps/` (`pnpm notion:webhook:prepare` prepares
  Notion's webhook URL). Apollo, Ashby and Fireflies need registration
  but no server secret.
- Stripe: products, prices, tax settings and the webhook.
- API keys for OpenRouter, Typesafe, Turbopuffer, Firecrawl, twitterapi.io,
  Azure OpenAI and Azure AI Inference, PostHog, and Daytona (then
  `pnpm --filter @rally/api terminal:ensure-webhook` installs the Daytona webhook
  secrets).

### Worker secrets

Set with `wrangler secret put` on the Global API Worker: the locally generated
session, OAuth-state and connector-credential keys; every provider credential
above; the APNs and Web Push keys; and the Stripe keys and billing config.
`apps/api/src/env.ts` declares every secret the Worker reads.

### Apple, Expo and mobile

- An Apple developer team with the desktop and mobile bundle ids (Push and
  Associated Domains on desktop), a Developer ID certificate, an App Store
  Connect API key, an APNs key, and the App Store Connect app record with its
  TestFlight groups.
- An Expo project; store its build credentials with `eas credentials` and
  register test devices with `eas device:create`. Store submission is an explicit
  `eas workflow:run submit.yml`.

### Values a fork must change

The hostnames and senders in the `vars` block of
`apps/api/wrangler.global.jsonc`, the engineering MCP's Access team domain,
`config/regions.json`, the Apple team and App Store Connect ids, the Expo owner,
project id and update URL, and the Worker names that service bindings expect.
