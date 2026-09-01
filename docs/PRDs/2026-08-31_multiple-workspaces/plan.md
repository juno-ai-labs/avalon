# Multiple workspaces implementation plan

The implementation follows the acceptance order in the PRD and keeps each
phase independently reviewable. Every behavior slice starts with a focused test
that is observed failing for the claimed reason before the implementation is
written.

## Phase 1 — Plural control plane and durable setup replay

- Add the one regional migration for workspace abandonment, plural Global route
  bindings, and the setup-operation journal.
- Extend onboarding contracts additively with the plural workspace list while
  retaining the singular compatibility field.
- Reconcile complete cross-region discovery into active and inactive routes.
- Make create and invitation acceptance replay one client operation id to the
  same destination, and remove the single-membership guards.

Acceptance gate: the migrated schema holds Global and EU routes for one account
without rewriting either placement affinity; a lost create response followed by
the same operation id returns one workspace; a changed request under that id is
rejected; older singular onboarding parsing remains valid.

## Phase 2 — Workspace lifecycle and attention

- Fence abandoned workspaces from discovery, activation, refresh, ordinary
  authentication, invitations, and member addition.
- Add self-leave, sole-owner refusal, and atomic final-member abandonment with
  access revocation.
- Add the WorkspaceDO attention projection and authenticated regional endpoint.

Acceptance gate: leaving removes only the caller, a sole owner cannot strand
other members, final-member abandonment suspends the membership and revokes
pending invitations atomically, existing sessions stop authorizing, and the
attention response distinguishes addressed work from unread activity.

## Phase 3 — Versioned desktop credential and profile sets

- Migrate version-1 stored auth/profile values into version-2 sets.
- Retain the identity credential beside one credential per activated workspace,
  remember the active workspace locally, and make late activation results
  unable to steal focus.
- Refresh and remove one credential independently; clear every local copy on
  sign-out before best-effort revocation of each captured server session.
- Scope drafts by workspace and clear only the workspace that is left.

Acceptance gate: legacy one-session storage migrates without credential loss;
Global and EU sessions coexist; switching changes only the active selection;
terminal refresh failure removes one entry; Lockdown migration and sign-out
cover the complete set even when one regional revocation fails.

## Phase 4 — Switcher, invitations, creation, and leaving

- Serve and consume the `multiple-workspaces-enabled` client flag.
- Add the workspace and invitation rows to the existing account menu, including
  active, switching, offline, denied, count-loading, and stale states.
- Reuse onboarding for in-session creation, surface signed-in invitation deep
  links, and add leave/close confirmation in Workspace Settings.
- Rename visible organization copy to workspace while retaining browser and
  internal compatibility vocabulary.

Acceptance gate: component tests cover the state matrix and the end-to-end
flows are walked in a real desktop window across Global and EU local Workers.
The periodic background-count guard remains open (`LIMIT UNSET`) until the team
chooses a cadence; focus and menu-open refreshes are active.

## Phase 5 — Durable documentation and release verification

- Add `docs/multiple-workspaces.md`, register it, and update every owning
  document named by the PRD in the same commits as its behavior.
- Extend the manual acceptance matrix and complete this PRD's state.
- Run lint, typecheck, all tests, script/release gates, both Wrangler dry runs,
  visual verification, the requested review swarm, and pull-request CI.

Acceptance gate: every local gate is green, visible changes have inspected
screenshots, all P0/P1 review findings are fixed (and P2 findings are either
fixed or explicitly dispositioned), and GitHub reports every required check
green.
