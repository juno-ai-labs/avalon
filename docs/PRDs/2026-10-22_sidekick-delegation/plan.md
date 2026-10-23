# Implementation plan

The PRD and design define the current acceptance contract. Validation evidence,
review triage and CI status belong to the pull request.

## Authority and enrollment

- [x] Store allowed users in the Sidekick's WorkspaceDO, independently of human access.
- [x] Enroll the creator immediately, including autonomous creation.
- [x] Support self-service enrollment and withdrawal; agent tools can target any
  current Organization user during direct or autonomous work.
- [x] Keep discovery and mutations within the current Organization.
- [x] Retain durable consent receipts so response loss and stale replay do not
  undo a later withdrawal.

## Execution

- [x] Apply the same eligibility policy to events, schedules and manual runs.
- [x] Admit personal connector events when their source owner is eligible,
  including Organization-, Thread- and private Breakout-owned Sidekicks.
- [x] Reconcile configured sources after connection and delegation changes.
- [x] Replace an unavailable coordinator with another eligible delegate on continuation.
- [x] Let the harness try eligible accounts after definite access refusals, while
  retaining exact-effect recovery for uncertain provider writes.
- [x] Keep account checkpoints in durable debugging data.
- [x] Give blocked runs actionable permission-reporting guidance and attention state.

## User experience and validation

- [x] Show allowed users and self-service controls on the shared desktop/web screen.
- [x] Cover loading, saving, offline, unavailable and uncertain outcomes.
- [x] Validate with real workerd, provider doubles and production-code negative controls.
- [x] Inspect real windows and manually exercise two-user workflows and Google Sheet
  event ingestion into Organization-, Thread- and private Breakout-owned Sidekicks.
- [x] Run scoped tests, full branch validation, lint, typecheck and documentation gates.

## Scope boundaries

No creator disclosure, manager-removal UI, Account withdrawal screen,
`rallyAccount` selector, task-account binding, mounted-secret revocation system,
normal-user operation-account activity, cross-Organization delegation or native
iOS UI. Authorization propagation may be eventually consistent.
