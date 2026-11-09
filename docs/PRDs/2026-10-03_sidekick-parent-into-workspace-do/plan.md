# Sidekick parents move into WorkspaceDO: build plan

> Companion to [`prd.md`](prd.md). One phase per rollout step. A phase is done
> when its gate holds, not when its code is merged.

## Phase 1: hosted Sidekick parent and import (rollout step 1)

One pull request, one deploy.

**Gate:** lint, typecheck and the affected suites pass; the import test fails
when the re-arm is skipped; CI green.

## Phase 2: the production gate (rollout step 2)

Operator work after phase 1 is deployed. Nothing to build.

- [x] Every Organization at or past the import migration. All 23 at 91.
- [x] No `pending` ledger row outside retired Organizations. 46 of 48 imported;
  the two pending are in retired Organizations.
- [x] Every `SidekickDO` the migration tracker's sweep lists has a ledger row
  marked done. Confirmed by a person with tracker access.

**Gate:** the three checks above, run and recorded by a person.

## Phase 3: delete the class (rollout step 3)

Irreversible. Starts only after phase 2's gate, and only on a person's word.

- [x] Wrangler tag `v13` deleting `SidekickDO`; `WorkspaceDO` migration 92
  dropping the ledger. The directory stays: it is the definition row.
- [x] Remove the scaffolding listed in the PRD's rollout step 3. Merged on a
  person's word after the tracker check.

**Gate:** the API deploys and typechecks with no `SidekickDO` class or
`AUTOMATION_DOS` binding.
