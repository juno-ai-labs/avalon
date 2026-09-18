#!/usr/bin/env bash
# Cursor Cloud install step for Rally.
#
# Idempotent by design: it refreshes dependencies, the generated development
# Worker environment, and the local D1 databases so that a fresh Cloud Agent — or
# an environment rebuilt from a snapshot — comes up ready to run both regional
# Workers and the Electron desktop client. A warm re-run finishes in seconds.
#
# Lifecycle: this runs as `install`. The regional Workers and the product-fixture
# seed run as `terminals` (see .cursor/environment.json), because the authority
# walk needs the Worker up and a server does not belong in install.
#
# See docs/cursor-cloud-environment.md for the full picture, and
# docs/dev-environment.md for the day-to-day commands behind each step.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$repo_root"

# --- Node version -------------------------------------------------------------
# The Cloud Agent exec-daemon puts its own Node 22.14 first on PATH. That minor
# predates two APIs the suites depend on — tls.getCACertificates (Node >= 22.15,
# used by the desktop realtime socket broker) and node:sqlite's FTS5 module (used
# by the @rally/db and @rally/api migration tests) — so on it `pnpm test` fails
# with `getCACertificates is not a function` and `no such module: fts5`. Point
# `node`/`npx` at the newest installed nvm 22.x (the image ships the repo's
# documented 22.22.2 parity) through a writable directory that sits ahead of the
# exec-daemon on PATH, so install, the terminals, and the agent's own shell all
# resolve the Node the project is built and gated against.
shim_dir="/usr/local/cargo/bin"
node_bin=""
for candidate in $(ls -d "$HOME"/.nvm/versions/node/v22.* 2>/dev/null | sort -V -r); do
  if [ -x "$candidate/bin/node" ]; then
    node_bin="$candidate/bin"
    break
  fi
done
if [ -n "$node_bin" ] && [ -d "$shim_dir" ] && [ -w "$shim_dir" ]; then
  ln -sf "$node_bin/node" "$shim_dir/node"
  ln -sf "$node_bin/npx" "$shim_dir/npx"
  export PATH="$node_bin:$PATH"
fi
echo "[install] node $(node -v)"

# The image ships a pnpm that predates the `packageManager` pin; corepack honours
# it so dependency resolution matches the pnpm CI gates on.
corepack enable
pnpm install --frozen-lockfile

# pnpm's electron postinstall does not always land the 125 MB binary, and once it
# is missing a plain reinstall reports "Already up to date" and never refetches —
# electron-vite dev then fails at startup with "Electron uninstall". Run the
# package's own installer when the binary is absent. (docs/dev-environment.md §1)
if ! ls node_modules/.pnpm/electron@*/node_modules/electron/dist/electron >/dev/null 2>&1; then
  node node_modules/.pnpm/electron@*/node_modules/electron/install.js
fi

# The desktop renderer reads configured VITE_API_<binding-prefix>_URL values from
# .env.local. The API does not need the file — env:sync defaults APP_ENV and
# RALLY_DEV_AUTH and generates its own signing material — but seeding it from the
# example costs nothing and makes the desktop path work.
if [ ! -f .env.local ] && [ -f .env.example ]; then
  cp .env.example .env.local
fi

pnpm env:sync

# Migrate before seeding; both write the same .wrangler/state SQLite files a
# running `wrangler dev` would hold open, so both run here in install rather than
# racing a live Worker.
pnpm db:migrate
pnpm db:seed

echo "[install] ready — Workers and fixtures start via .cursor/environment.json terminals"
