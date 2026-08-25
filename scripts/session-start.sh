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

# One log for the whole run, truncated once here and appended to by each step.
# Truncating per step would leave the pointer printed by an early failure
# resolving to a later step's output, since the script continues past failures.
log_file="/tmp/avalon-session-start.log"
: >"$log_file"

run_step() {
  local description="$1"
  shift
  printf '\n=== %s ===\n' "$description" >>"$log_file"
  if "$@" >>"$log_file" 2>&1; then
    log "$description: ok"
    return 0
  fi
  log "$description: FAILED — see $log_file"
  tail -n 15 "$log_file"
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
# APP_ENV and RALLY_DEV_AUTH and generates its own signing material — but
# seeding it from the example costs nothing and makes the desktop path work.
# scripts/seed-sandbox-env.mjs explains why the values come from the
# environment rather than from a verbatim copy of the example.
if [ ! -f .env.local ] && [ -f .env.example ]; then
  run_step "seed .env.local" node "$repository_root/scripts/seed-sandbox-env.mjs"
fi

run_step "pnpm env:sync" pnpm env:sync

# Migrate before seeding, and both before any Worker starts: the tooling writes
# to the same .wrangler/state SQLite files a running `wrangler dev` holds open.
run_step "pnpm db:migrate" pnpm db:migrate
run_step "pnpm db:seed" pnpm db:seed

log "ready — start the API with 'pnpm dev:api:local' (see docs/dev-environment.md)"
exit 0
