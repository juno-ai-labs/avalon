# Claude Code remote sandbox

Rally's agent sessions run in an ephemeral Linux container with no persistent
state and no Cloudflare credentials. This document is the authoritative
definition of that environment: the setup script, the network policy, and the
version parity we expect against CI and production. For the day-to-day commands
that bring the application up inside it, read
[the development environment guide](dev-environment.md).

Set up one environment. Rally needs no database server, so unlike a
PostgreSQL-backed project there is no second environment to maintain.

### Network access

`Full`.

The Worker talks to a long list of provider APIs, and a restricted policy denies
each of them at the CONNECT tunnel with an opaque `403`, which surfaces as an
unrelated-looking client error rather than a network message. If the policy must
be narrowed, the hosts Rally actually reaches are:

| Host | Used by |
| --- | --- |
| `registry.npmjs.org` | `pnpm install` |
| `github.com`, `objects.githubusercontent.com` | Electron binary download during `pnpm install` |
| `api.cloudflare.com` | `wrangler` remote bindings, deploys, remote D1 |
| `openrouter.ai` | Agent harness inference |
| `api.firecrawl.dev` | Agent web search and page reading |
| `*.openai.azure.com` | Realtime dictation |
| `api.resend.com` | Invitations and inbound conversation email |
| `api.linear.app`, `slack.com`, `api.github.com`, `api.notion.com`, `www.googleapis.com`, `oauth2.googleapis.com` | Connectors |

A local-only session — the common case — needs only the first two rows.

### Environment variables

```env
BASH_ENV=/etc/profile.d/zz-avalon-noproxy.sh
```

Provider keys are optional and only required when a session must reach a real
provider. Add them here rather than committing them:

```env
OPENROUTER_API_KEY=***
FIRECRAWL_API_KEY=***
```

`pnpm env:sync` generates its own development signing and encryption material,
so no secret is required to run the API, the database, or the desktop client
locally.

Keys set here reach the Workers through `scripts/session-start.sh`, which runs
`scripts/seed-sandbox-env.mjs` to fill every blank assignment in `.env.example`
from the environment as it seeds `.env.local`. `sync-dev-env.mjs` reads only
`.env.local`, so a variable that is set in the environment but blank in that file
never reaches `apps/api/.dev.vars.*` — and would overwrite a working value there
on the next sync. Adding a provider key to this environment therefore needs no
change to the hook, but it does need the variable to exist in `.env.example`.

A value is written only when it reads back unchanged through the line-based
parser in `sync-dev-env.mjs`. A multi-line value such as a GitHub App PEM, or one
wrapped in quotes, cannot be represented there at all, so it is **skipped with a
warning in the session log** rather than written in a mangled form that parses
cleanly and is no longer the key. Those belong in `.env.local` directly.

### Setup script

```bash
#!/bin/bash

# The image ships pnpm 10.x while the repository pins 11.13.0 through
# `packageManager`. Without this, dependency resolution in an agent session
# differs from the pnpm that gates the pull request in CI.
sudo -E corepack enable
corepack prepare pnpm@11.13.0 --activate

# -E is required to pass proxy info to apt-get.
sudo -E apt-get update

# Headless Electron. The standard image already carries Xvfb and most of these
# libraries; the install is a cheap safety net for a barer base image. `unzip`
# is needed only when the Electron binary has to be unpacked by hand.
sudo -E apt-get install -y --no-install-recommends \
  xvfb unzip libnss3 libdrm2 libgbm1 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libxkbcommon0 libpango-1.0-0 libcairo2 libatspi2.0-0

# `scripts/generate-brand-assets.py` renders flat brand assets and resizes
# supplied app artwork into previews with Pillow. It is not in the base image, and
# PEP 668 marks the system interpreter externally managed — there is no virtual
# environment here and one script is not worth one.
sudo -E pip3 install --break-system-packages pillow

# Route the hosts whose clients break on the proxy's CONNECT tunnel around it.
# `undici` — which Node, wrangler, and Electron's installer all use — aborts
# mid-stream on that tunnel with an internal assertion, while a direct TLS dial
# to the same host succeeds because the proxy CA is trusted. HTTPS_PROXY stays
# set, so everything else keeps the proxy and its injected auth. See
# docs/sandbox-proxy.md before adding a host.
sudo tee /etc/profile.d/zz-avalon-noproxy.sh >/dev/null <<'PROFILE'
# Append only if absent, so nested shells re-sourcing this file do not grow the
# lists with duplicate entries.
for host in github.com objects.githubusercontent.com; do
  case ",$no_proxy," in
    *",$host,"*) ;;
    *) export no_proxy="${no_proxy:+$no_proxy,}$host" ;;
  esac
  case ",$NO_PROXY," in
    *",$host,"*) ;;
    *) export NO_PROXY="${NO_PROXY:+$NO_PROXY,}$host" ;;
  esac
done
unset host
PROFILE
sudo chmod 0644 /etc/profile.d/zz-avalon-noproxy.sh

# Login shells source /etc/profile.d/*; interactive non-login shells (the agent
# tool shell) source bashrc instead.
if ! grep -qF zz-avalon-noproxy.sh /etc/bash.bashrc 2>/dev/null; then
  printf '[ -r %s ] && . %s\n' \
    /etc/profile.d/zz-avalon-noproxy.sh /etc/profile.d/zz-avalon-noproxy.sh \
    | sudo tee -a /etc/bash.bashrc >/dev/null
fi
. /etc/profile.d/zz-avalon-noproxy.sh
```

Dependency installation, environment sync, migrations, and the seed are
deliberately **not** in this script. They belong to the repository checkout
rather than the image, and `scripts/session-start.sh` runs them through the
`SessionStart` hook on every session.

Playwright is already installed globally on the image and is the supported way
to drive the desktop client; it attaches to a running Electron process over the
Chrome DevTools Protocol and needs no browser download. Do not install Puppeteer.

## Version parity

Snapshot taken 2026-08-10. Only the major Node version and the exact pnpm
version are parity requirements; the rest tracks the lockfile.

| | Production / CI | Sandbox |
| --- | --- | --- |
| Node.js | 22 (`engines`, `setup-node`) | 22.22.2 |
| pnpm | 11.13.0 (`packageManager`, `pnpm/action-setup`) | 10.33.0 on the image, 11.13.0 after `corepack prepare` |
| wrangler | from the lockfile (4.118.0) | same |
| workerd | from the lockfile | same |
| Electron | 43.2.0 | same, Linux x64 build instead of macOS |

CI runs the same `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`,
and both Wrangler dry-run builds, all of which pass in the sandbox. The macOS
desktop packaging, signing, and notarization jobs have no sandbox equivalent.
