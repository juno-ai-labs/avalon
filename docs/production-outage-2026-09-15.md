# Production outage: unreviewed Durable Object schemas ahead of `main`

**Date:** 2026-09-15  
**User-visible outage:** 12:07–12:40 UTC (33 minutes)  
**Affected service:** Global Rally API (`avalon-api-global`)  
**Status:** Service restored by rollback; the next deployment from `main` remains unsafe

## Summary

At 12:07 UTC, the continuous-deployment workflow promoted `main` at
`bd1adcf8f7264e3541371bf811ba709771a6cf9f` to the Global API. Six manual
Wrangler deployments earlier that morning had already opened production Durable
Objects with migrations that did not exist on `main`. At minimum, WorkspaceDO
had applied migration 57 and SubstreamAgent had applied migration 58; the final
manual deployment and its later operator record also indicate that WorkspaceDO
migration 58 was applied to all stored workspace objects.

The `main` build knew WorkspaceDO migrations only through 56 and SubstreamAgent
migrations only through 57. On construction, the append-only migration runner
found a receipt newer than the build's latest known migration and raised
`*_schema_ahead`. Durable Object initialization failed, `/health` returned 503,
and the Global API returned 503s for member requests. The deployment workflow
detected the unhealthy Durable Object check but did not automatically restore
the preceding version.

At 12:40 UTC, production was manually rolled back to Worker version
`a7b1266b-1283-4343-bc58-725c0dc7fec7`. Service recovered because that version
understands the schemas it had applied. This rollback restored code/schema
compatibility; it did not undo any migration or restore deleted data.

## Impact

- The Global Rally API was unavailable for 33 minutes. Requests that initialized
  an affected Durable Object failed with 503.
- The CI deployment failed its regional health gate after five consecutive 503
  responses between 12:07:26 and 12:09:10 UTC. The gate prevented later deploy
  steps but ran after the incompatible API version had already received 100% of
  traffic.
- Meeting-note data was deliberately deleted by the unreviewed production code.
  Rolling back the Worker did not recover those rows or objects.
- No 503 request count was preserved in the evidence reviewed for this report;
  the impact window and failure mode are established, but a precise request
  count is not.

## Timeline

All times are UTC on 2026-09-15. “Uploaded” is when Cloudflare created the
version; “promoted” is when the deployment assigned it 100% of traffic.

| Time | Event |
| --- | --- |
| 05:39:00 | Manual Wrangler upload created version 533, `8630ee97-19be-4119-a631-e486e91587d3`, tagged `meeting-retirement-stage1`. |
| 05:44:16 | Version 533 was promoted with “Retire built-in meeting notes and begin scoped cleanup; preserve dictation.” |
| 05:46:47 | Manual upload created version 534, `9812fdb6-efd5-4299-b3da-95bad9dca024`, tagged `meeting-retirement-repair`. |
| 05:47:12 | Version 534 was promoted to repair an adopted-workspace migration prerequisite without changing the already-shipped migration hash. |
| 05:57:35 | Manual upload created version 535, `a33a798e-42a8-4cf0-a8ce-82d39253e166`, tagged `meeting-retirement-audit`. |
| 05:58:21 | Version 535 was promoted to add an all-table retirement inventory. |
| 06:01:09 | Manual upload created version 536, `c2074d9c-4247-4c13-b2e8-1f17f16bdd4b`, reusing the audit tag. |
| 06:01:45 | Version 536 was promoted to exclude platform-owned hidden tables from that inventory. |
| 06:14:03 | Manual upload created version 537, `aba044ed-7c96-4b97-a423-d34a45659ff3`, tagged `meeting-retirement-cache`. |
| 06:14:58 | Version 537 was promoted to fence and purge retired meeting authorization copies. |
| 06:21:19 | Manual upload created version 538, `a7b1266b-1283-4343-bc58-725c0dc7fec7`, tagged `meeting-retirement-final`. |
| 06:21:50 | Version 538 was promoted with “Finalize meeting-note table retirement after all-workspace cleanup verification.” |
| 12:07:04 | CI promoted version 539, `787ab21b-6702-4afe-b4b7-1af9b8a1d0e3`, built from `main` at `bd1adcf8f7264e3541371bf811ba709771a6cf9f`. The outage began. |
| 12:07:26 | CI's first post-deploy health attempt returned 503 with `durableObjects` unavailable. |
| 12:09:10 | The fifth health attempt returned 503 and the deployment workflow failed. The incompatible version remained active. |
| 12:40:21 | An operator used the Cloudflare dashboard to restore version 538 to 100% of traffic. Service returned. |

## What happened

The migration runner in
`apps/api/src/durable-objects/sqlite-migrations.ts` treats the migration ledger
as append-only. Before applying anything, it compares every receipt in
`_sql_schema_migrations` with the migrations compiled into the Worker. If an
object contains a version above `latestKnownVersion`, it throws
`<component>_schema_ahead:<version>`. This is the correct safety behavior: an
older binary cannot safely infer the contract of a newer schema.

The six manual deployments bypassed the repository's release boundary. They
carried meeting-note retirement code from a working tree rather than a reviewed
commit on `main`, woke production objects, and committed their migrations.
Durable Object SQLite state is independent of Worker version state, so later
deploying an older schema vocabulary did not roll the objects back. It merely
made the serving binary unable to open them.

The CI workflow uploaded and promoted the verified `main` artifact before it ran
the regional health gate. The gate correctly observed the incompatibility, but
its failure only stopped subsequent workflow steps. It had no automatic
rollback, and it could not undo the Durable Object migrations in any event.

## Root cause

Production write credentials allowed a developer workstation to upload and
promote arbitrary local Worker bundles to `avalon-api-global`. There was no
enforced provenance boundary requiring a production version to be built by the
GitHub deployment workflow from a commit reachable from `main`.

That allowed an unreviewed, unmerged migration chain to become production's
durable schema authority. Continuous deployment later did exactly what it was
configured to do—deploy the newest `main`—and encountered schemas newer than the
code it shipped.

## Contributing factors

- **Manual deployment and schema migration were one operation.** A local
  `wrangler` deploy both changed traffic and let newly constructed Durable
  Objects apply migrations. There was no production preflight comparing the
  candidate's migration heads with the heads already observed in production.
- **Migration state outlived Worker rollback state.** Cloudflare can move
  traffic back to an earlier Worker version, but that does not reverse Durable
  Object SQLite transactions.
- **The health gate ran after promotion.** It detected the outage within
  seconds but did not prevent the incompatible version from taking traffic.
- **Failure did not restore the preceding version.** The workflow stopped at
  the failed health check and left version 539 serving until an operator
  intervened 31 minutes later.
- **Deployment annotations were not provenance.** CI versions carry a commit
  SHA in their tag and message. The six manual versions carried descriptive
  free-form tags and no immutable repository revision.
- **Destructive cleanup was performed before review.** The migration deleted
  user content and external copies while its implementation, evidence, and
  recovery implications existed only in a working branch.

## Source provenance gap

Cloudflare records six distinct script etags for versions 533–538, proving that
these were six different uploaded bundles. Five etags match no commit available
in the repository. The surviving branch `codex/remove-meeting-notes` contains
the migration definitions and a later representation of the final state, but it
has no pull request, its commit messages do not match the deployment messages,
and it cannot reconstruct the five intermediate bundles.

Cloudflare's version metadata retains each etag, upload time, author identifier,
tag, and message, but the available historical-version API does not return the
corresponding source bundle. Consequently, we cannot now review exactly what
five production versions executed. The later branch is useful evidence for the
intended final behavior; it is not a source-of-truth substitute for the missing
artifacts.

This is a production source-retention incident as well as an availability
incident. For part of the morning, production ran code whose exact source is no
longer present in Git.

## Data deletion and recovery status

The following is the best available reconstruction from the migration SQL, the
content-free manifests it left behind, Cloudflare deployment metadata, and the
production checkpoint recorded later on `codex/remove-meeting-notes`. Because
five intermediate bundles are missing, counts attributed to the operator
checkpoint are evidence of the final audit, not independently reproducible
build provenance.

### Current serving data deleted

- **Workspace note content:** WorkspaceDO migration 57 deleted every built-in
  meeting `notes` row and every `note_transcript_segments` row. This removed note
  titles, manual and generated note Markdown, transcript text, speaker labels,
  timestamps, recording state, and note ownership/scope metadata.
- **Workspace resources and relationships:** The same migration deleted the
  matching `resources` rows and removed those resource IDs from pending
  attachment reservations, automation resources, and project defaults. It also
  cleared note privacy, object-deletion, and batch-target outboxes.
- **R2 note objects:** The cleanup pass used the retained resource IDs and object
  references to remove the note files under each resource prefix and any legacy
  referenced objects.
- **Conversation attachments:** SubstreamAgent migration 58 found resources
  whose serialized provider was `avalon_note`, then deleted their participant
  transcript attachments, attachment-tool receipts, pending attachment recovery
  rows, and work-stream resource links. Conversation turns themselves were not
  deleted. Text copied without provenance was deliberately not classified by
  content matching.
- **Search and authorization copies:** The cleanup removed attributable search
  authorization KV keys, their WorkspaceDO decisions and dependencies, and
  matching resource search revisions. It fenced stale publications so a queued
  write could not recreate them.
- **Analytics copies:** The operator record says the current analytics catalog's
  meeting lifecycle rows and the corresponding D1 accepted-event and receipt
  rows were deleted.

### Recorded cardinalities

- 16 stored WorkspaceDOs were inspected, including closed workspaces.
- The content-free WorkspaceDO manifests identify 26 retired resources.
- 52 current and historical R2 note files were deleted. A subsequent scan of
  159,351 objects under workspace prefixes found no remaining note files.
- 6,693 stored conversation objects were inspected after SubstreamAgent
  migration 58. The recorded verification found no surviving attributable note
  attachments, terminal imports, or tool-input copies. The migration did not
  preserve per-table pre-delete row counts, so the exact number of deleted
  attachment/link/receipt rows cannot be reconstructed from current state.
- 74 attributable authorization KV keys and their SQLite decisions were deleted.
- All 28 production search namespaces were checked and had zero matching source
  IDs after cleanup.
- No attributable meeting inference records were found in the current catalog
  or among 348 raw records not yet cataloged; no inference rows were therefore
  recorded as deleted.
- Two current analytics-catalog lifecycle rows, 13 D1 accepted events, and 13 D1
  receipts were deleted.

### What remains or may be recoverable

- Content-free resource IDs remain in the retirement manifests and attachment-ID
  inventories. They preserve deletion provenance, not note content.
- Thirteen PostHog lifecycle events remain because the available deletion
  mechanism would also remove unrelated person or project data.
- Historical Iceberg snapshots retain earlier analytical rows while snapshot
  expiration is disabled.
- Cloudflare Durable Object point-in-time recovery may retain pre-deletion state
  for 30 days. This report does not claim that a restore was attempted or that
  recoverable state is complete.
- Offline desktop caches are outside the production database deletion. The
  unmerged client change clears them when an updated application runs; clients
  that have not run that build may still retain cached copies.
- No content backup was created before the production cleanup.

The discrepancy in the recorded WorkspaceDO head must be resolved before the
next API deployment. The initial incident record identifies WorkspaceDO 57 as
the production head; version 538's annotation and the later operator checkpoint
say WorkspaceDO 58 completed on all 16 objects. Both are ahead of `main`'s 56,
so either state reproduces the outage. The migration tracker should be treated
as authoritative for the exact applied head.

## Detection and response

The post-deploy health gate detected the failure 22 seconds after version 539
was created and exhausted its five attempts in under two minutes. Detection was
fast; remediation was manual and slow relative to detection. The workflow's
failed status did not page an operator or restore the previous version, and the
service remained down for another 31 minutes.

The rollback was the correct availability action because version 538 understood
the production schema. Rolling back farther, redeploying `main`, or replaying
migrations would have failed again or increased uncertainty. No migration was
reversed during recovery.

## Corrective actions

### Before any API deployment

1. Keep API deployment from `main` paused. Any current `main` artifact will
   reproduce the schema-ahead failure.
2. Read the migration tracker and preserve its per-class, per-region heads as
   incident evidence, resolving WorkspaceDO 57 versus 58.
3. Recover or reconstruct the exact source for versions 533–537 if any local
   build artifacts still exist. Preserve them read-only with their Cloudflare
   version IDs and etags.
4. Review the meeting-retirement change, its destructive effects, and the
   recovery decision before merging any forward-compatible code. Do not treat
   the already-deployed schema as approval of the branch.
5. Decide explicitly whether to retain or restore recoverable meeting content.
   Do not let the 30-day point-in-time-recovery window expire by accident.

### Prevent recurrence

1. **Remove standing production `Workers Scripts Write` credentials from human
   workstations and accounts.** The only ordinary principal able to upload or
   promote `avalon-api-global` should be the GitHub Actions deployment identity,
   with its token stored in the protected `api-production` environment.
2. **Make break-glass access temporary and auditable.** Issue a short-lived,
   service-scoped credential only for a declared incident, require a second
   operator to authorize it, and revoke it immediately afterward. A local
   production deploy must not be an everyday capability.
3. **Preserve immutable build provenance.** Every uploaded production version
   must carry the full Git commit SHA and CI run identifier, and the workflow
   must reject a candidate not built from the resolved reviewed revision.
   Archive the exact uploaded bundle and its digest with the workflow run.
4. **Add a production migration-head preflight.** Before traffic promotion,
   compare each candidate Durable Object class's latest known migration with the
   highest head reported by production. Refuse a candidate behind production.
   This is a compatibility check, not a migration command.
5. **Separate upload from promotion and validate before 100%.** Exercise the
   uploaded candidate against a non-serving preview or dedicated canary object
   whose schema head mirrors production. Do not use a real customer object as a
   canary and do not let the check apply a new migration.
6. **Define automatic availability recovery.** If the immediate regional health
   gate fails after promotion, restore the previously serving compatible
   version and notify operations. Automatic Worker rollback cannot reverse a
   migration, so it supplements rather than replaces the migration-head
   preflight.
7. **Require reviewed destructive-migration evidence.** A destructive migration
   needs a committed inventory, pre-delete cardinalities, recovery decision,
   and source-retention plan before it can receive production credentials.

The control that would have stopped this incident is the first one: if no human
principal or workstation held `Workers Scripts Write` for the production Worker,
unmerged local code could not have been uploaded or promoted. Git hooks, wrapper
scripts, branch-name checks, and deployment-message conventions are useful
guardrails but are bypassable by invoking Wrangler or the API directly; they do
not enforce the boundary.

## Evidence

- Cloudflare Worker version and deployment metadata for versions 533–539 and
  the 12:40 dashboard rollback.
- GitHub Actions run 34965784545 for `bd1adcf8f7264e3541371bf811ba709771a6cf9f`.
- The migration runner and schema heads on `main` at that commit.
- The migration definitions and production checkpoint on
  `codex/remove-meeting-notes`.
- Repository history and GitHub pull-request search, which found no pull request
  for that branch and no commits bearing the six manual deployment messages.

