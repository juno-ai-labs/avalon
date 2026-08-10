#!/bin/bash
# Prepare a remote agent sandbox for work on Avalon: activate the pinned pnpm,
# install dependencies, generate the development Worker environment, and create
# and seed the local D1 databases.
#
# Best-effort by design. Every step reports and continues on failure, because a
# session that starts with one broken step is worth more than a session that
# fails to start. Idempotent: a warm container re-runs this in a few seconds.

# Only run in remote environments; a workstation owns its own setup.
if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$repository_root" || exit 0

log() {
  echo "[session-start] $*"
}

run_step() {
  local description="$1"
  shift
  if "$@" >/tmp/avalon-session-start.log 2>&1; then
    log "$description: ok"
    return 0
  fi
  log "$description: FAILED — see /tmp/avalon-session-start.log"
  tail -n 15 /tmp/avalon-session-start.log
  return 1
}

# The image ships a pnpm that predates the `packageManager` pin, which would
# resolve dependencies differently from the pnpm CI gates on.
if command -v corepack >/dev/null 2>&1; then
  run_step "corepack enable" corepack enable
fi

run_step "pnpm install" pnpm install --frozen-lockfile || exit 0

# The desktop renderer reads VITE_API_GLOBAL_URL and VITE_API_EU_URL from
# .env.local. The API does not need the file — sync-dev-env.mjs defaults
# APP_ENV and AVALON_DEV_AUTH and generates its own signing material — but
# seeding it from the example costs nothing and makes the desktop path work.
#
# Every blank assignment in the example is filled from the environment when the
# sandbox supplies that variable. Copying the example verbatim would otherwise
# strand a configured OPENROUTER_API_KEY or FIRECRAWL_API_KEY: sync-dev-env.mjs
# reads .env.local and never process.env, and its merge lets a blank value in
# .env.local override a real one already written to apps/api/.dev.vars.*.
if [ ! -f .env.local ] && [ -f .env.example ]; then
  filled=$(node -e '
const { readFileSync, writeFileSync } = require("node:fs");
let filled = 0;
const lines = readFileSync(".env.example", "utf8").split(/\r?\n/u).map((line) => {
  const match = /^([A-Z0-9_]+)=[ \t]*$/u.exec(line);
  if (!match) return line;
  const supplied = process.env[match[1]];
  if (typeof supplied !== "string" || supplied.length === 0) return line;
  filled += 1;
  return `${match[1]}=${JSON.stringify(supplied)}`;
});
writeFileSync(".env.local", lines.join("\n"), { mode: 0o600 });
process.stdout.write(String(filled));
' 2>/dev/null) && log "seeded .env.local from .env.example (${filled:-0} value(s) taken from the environment)"
fi

run_step "pnpm env:sync" pnpm env:sync

# Migrate before seeding, and both before any Worker starts: the tooling writes
# to the same .wrangler/state SQLite files a running `wrangler dev` holds open.
run_step "pnpm db:migrate" pnpm db:migrate
run_step "pnpm db:seed" pnpm db:seed

log "ready — start the API with 'pnpm dev:api:local' (see docs/dev-environment.md)"
exit 0
