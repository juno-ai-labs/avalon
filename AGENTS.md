# Agent instructions

This is the project-wide rule sheet for AI coding agents, exposed as `CLAUDE.md`
through a symlink. Keep it short: it is read in full at the start of every
session, so detail belongs in `docs/` behind a pointer.

## Environment

**Read [`docs/dev-environment.md`](docs/dev-environment.md) at the start of every
session, before running a setup, server, or browser-automation command.** It
covers dependency installation, the local D1 database, starting both regional
Workers, and running the Electron client headlessly. The container it assumes is
defined in [`docs/SANDBOX.md`](docs/SANDBOX.md).

- **Node.js 22 and pnpm 11.13.0.** The pnpm version is pinned by
  `packageManager`; run `corepack enable` rather than using whatever pnpm the
  image ships.
- **In a sandbox, start the API with `pnpm dev:api:local`, not `pnpm dev:api`.**
  The `ai` binding forces a remote proxy session that cannot be established
  without Cloudflare credentials, and its failure takes both regions down.
- When an outbound HTTPS request fails in a way that does not look like a
  network error, read [`docs/sandbox-proxy.md`](docs/sandbox-proxy.md) before
  retrying. Never disable TLS verification or unset `HTTPS_PROXY`.

## Quality gates

Every change must leave `pnpm lint` (zero warnings), `pnpm typecheck`, and
`pnpm test` green. CI additionally runs `pnpm test:scripts`, both Wrangler
dry-run builds, the desktop release invariants, and a Gitleaks scan over the full
history.

## Capturing command output

For any command with non-trivial output — tests, typecheck, lint, migrations,
Worker or Electron startup — write the full output to a file rather than reading
it through a truncating pipe:

```bash
pnpm test 2>&1 | tee /tmp/test.log   # inline preview plus the full file
pnpm test &> /tmp/test.log           # silent; read or grep the file afterwards
```

`2>&1` must come before the pipe, or stderr bypasses `tee`. A pipeline reports
the last command's exit code, so keep `tee` last. Delete the logs when done.

## Verifying visible changes

**Every change a user can see must be looked at in a real window before it is
called done.** A passing component test asserts on the DOM, which says nothing
about whether an element is visible, positioned, legible, or covered. Run the
desktop client under Xvfb, attach Playwright over the DevTools protocol, capture
the screens you changed, and read the images — the procedure is in
[`docs/dev-environment.md`](docs/dev-environment.md#driving-and-screenshotting-it).
Playwright is already installed globally on the sandbox image; do not add a
browser driver to the repository.

## Documentation

**Before planning or making a change, read [`docs/README.md`](docs/README.md)** —
it indexes every document and says which one owns which area. Find the ones whose
scope matches what you are touching, read them first, and update them in the same
change. When a change introduces a subsystem no existing document covers, add
`docs/<NAME>.md` and register it in that index — the index is the one registry
that has to stay complete. The Documentation list in [`README.md`](README.md) is
a curated reading path rather than a second registry; add an entry there only
when the new document belongs in front of a first-time reader.

## Pull requests

**Before opening a pull request, read
[`docs/pull-requests.md`](docs/pull-requests.md)** — it defines the required
description sections, the repository's merge style, and its rule that pull
requests are opened ready for review, never as drafts. Do not open a PR unless
you were asked to.

## Security

Never commit secrets. `.env.local` and `apps/api/.dev.vars.*` are ignored and
must stay that way, server secrets must never sit behind a `VITE_` name, and
Cloudflare administration credentials belong only to the local deployment
environment — never as Worker variables. [`docs/SECURITY.md`](docs/SECURITY.md)
owns the desktop client's isolation model.
