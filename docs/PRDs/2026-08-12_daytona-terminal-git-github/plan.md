# Daytona terminal, Git, and GitHub pull requests plan

> Phased implementation plan for [`prd.md`](./prd.md). Every phase ends at a
> separately demonstrable gate; advancing the first implementation phase also
> advances [`state.md`](./state.md) to `in progress`.

## Phase 0 — Validate the external boundary

- Complete Daytona security, DPA, region, deletion, subprocessor, audit-log,
  incident, and availability review for the Global deployment.
- Build throwaway proofs for lazy sandbox creation, toolbox process and PTY
  control, stop/start, archive/restore, secret rotation, Basic-auth Git clone, and
  network block-all plus exact-domain allowlists.
- Prove that the regional Git publishing bridge can validate and stream Git
  smart HTTP within bounded memory and time, or select the minimal regional
  service runtime that can.
- Measure create, restore, clone, stop, archive, and cold-reconstruction latency
  and cost against the initial lifecycle thresholds.
- Resolve the first-release public package-registry egress profile or explicitly
  ship GitHub-only validation.

**Acceptance gate:** a written threat review and executable spike demonstrate that
plaintext credentials never enter the sandbox, forbidden egress stays blocked,
Git policy is enforced by the bridge, and the selected Global Daytona deployment
meets the vendor gate. No product code or GitHub permission change is required to
pass this phase.

## Phase 1 — Add the regional workspace control plane

- Add `agent-repository-workspace` resolution with a fail-closed `off` default and
  checked-in value schema.
- Add regional workspace/task/publication migrations and repository services.
- Implement stable-name create convergence, state transitions, optimistic locking,
  leases, idle stop, archive, cold deletion metadata, and cancellation.
- Build and pin the first immutable Daytona snapshot.
- Add sandbox, task, latency, cost, stop, archive, restore, and orphan metrics with
  no command or repository-content dimensions.
- Write the durable Daytona workspace subsystem document and update the data model,
  regionalization, security, feature-flag, runbook, and cost documents.

**Acceptance gate:** synthetic concurrent requests create exactly one sandbox per
work stream; cancellation and every lifecycle transition converge after injected
Worker/Daytona failures; unrelated work streams never share a sandbox; the feature
remains off in production.

## Phase 2 — Ship bounded file and terminal tools internally

- Add the plugin descriptor and activation checks without GitHub publication.
- Implement repository-root-confined `list_dir`, `glob`, `grep`, `read_file`,
  `edit_file`, `write_file`, and `apply_patch`.
- Implement `run_terminal_cmd`, `get_task_output`, `send_task_input`, and
  `kill_task` over Daytona processes and PTYs with durable receipts and limits.
- Implement output streaming, R2 spill, control-sequence normalization, redaction,
  task deadlines, and ambiguous-command reconciliation.
- Add transcript activity for startup, commands, file changes, failures,
  cancellation, stop, archive, and restore.
- Test hostile paths, symlinks, output, terminal input, process trees, background
  tasks, timeouts, network, and repository instructions.

**Acceptance gate:** an internal fixture repository can be inspected, edited, and
validated across multiple turns and a stop/resume cycle; every limit fails with a
stable model-actionable result; no sandbox starts until the first tool call.

## Phase 3 — Add private GitHub clone, fetch, and local commits

- Resolve one exact repository from an attached resource or elicited selection.
- Mint single-repository, read-scoped installation access tokens in the owning
  region and attach them through per-workspace Daytona secrets.
- Configure literal Basic-auth header substitution for Git and `GH_TOKEN` for
  read-only GitHub CLI use; add rotation and revocation handling.
- Bootstrap canonical fetch remotes, base SHA, deterministic branch, and Avalon
  bot commit identity.
- Implement medium-idle archive and 30-day Git-bundle/patch cold reconstruction.
- Run credential exfiltration tests covering environment, args, Git config,
  history, echo, redirect, alternate hosts, response reflection, and logs.

**Acceptance gate:** selected internal Global workspaces can clone a private
fixture, fetch, commit locally, stop/archive/cold-restore, and produce a durable
diff without exposing a plaintext token or receiving publication authority.

## Phase 4 — Add controlled push and pull requests

- Upgrade the GitHub App Contents permission to write and surface installation
  reapproval status; keep Workflows permission absent.
- Deploy the regional Git publishing bridge, capability issuer, branch policy,
  expected-SHA checks, receipts, and reconciliation.
- Admit `repository:publish` only from explicit request intent and current frozen
  connection/resource grants.
- Add pull-request-write `gh` tokens only to publication runs; implement head/base
  convergence and PR verification.
- Add ready-for-review PR copy that records reason, changes, and validation, plus
  canonical transcript/activity links.
- Exercise default-branch, alternate-ref, force, delete, workflow-file,
  revoked-installation, lost-response, and duplicate-PR attacks.

**Acceptance gate:** a publish-authorized request creates exactly one verified PR
from the deterministic branch; every forbidden ref or permission path fails closed;
a read/edit request cannot perform either external write.

## Phase 5 — Roll out and tune

- Enable `read_edit` for the internal cohort, then selected Global workspaces;
  compare start latency, successful edit rate, validation coverage, cancellation,
  active minutes, stopped disk, archive storage, R2 artifacts, and restore rate.
- Enable `publish` only for installations that approved Contents write, first on
  synthetic and internal repositories and then selected Global workspaces.
- Tune warm, stop, archive, and cold thresholds from measured total cost and
  resume latency without weakening the hard task deadline.
- Publish operator dashboards and runbooks for provider outage, orphan cleanup,
  revocation, snapshot rollback, bridge rollback, and regional disablement.
- Update the standing implementation brief with the agreed bounded-terminal
  clause and complete all subsystem changelogs.
- Keep EU targeting off until its independent vendor residency gate passes.

**Acceptance gate:** the Global cohort meets the agreed reliability, latency,
security, and unit-cost targets through at least one full cold-retention window;
turning the flag off prevents new work and safely drains/stops existing work; all
PRD acceptance flows and repository quality gates are green.
