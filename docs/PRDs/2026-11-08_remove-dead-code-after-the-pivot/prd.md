# Remove dead code after the pivot

> Created 2026-11-08.
>
> Delete the code that nothing reaches since Threads, Channels, Breakouts,
> Spaces, session import, digests, suggestions and meeting notes were deleted,
> so the tree describes the product that exists. The inventory under
> [Rollout](#rollout) is the list to work from. Follows
> [Canvases and Sidekicks](../2026-11-06_canvases-and-sidekicks/prd.md) and its
> [plan §9](../2026-11-06_canvases-and-sidekicks/plan.md#9-follow-ups-after-this-pull-request).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

The pivot to Canvases and Sidekicks deleted the surfaces, routes and most of
the services behind Threads, Channels, Breakouts and Spaces. It left a layer
that still compiles and is still tested though no production path reaches it:
a desktop-action protocol with no user, a browser realm and three skills that
name tools that no longer exist, exports only their own tests call, a queued
effect no receiver handles, and comments in about 85 files that describe
deleted things as live. This PRD removes that layer in phases ordered by risk.
People using Rally see almost nothing change; engineers and agents find only
code that does something. Stored data changes last, after the operator's
retirement run has finished in every Organization.

## Motivation

The owner asked on 2026-11-08 for "a PRD with a detailed description and list
so we don't lose track" of the dead code the pivot and the documentation audit
exposed. The cost is already visible:

- **The model is told about tools it cannot call.**
  `BROWSER_RUNTIME_ENTRY_INSTRUCTIONS` and the browser plugin's `NEXT_STEP`
  name `import_finish` and `import_fail`, the reading-an-AI-chat skills are in
  the built-in catalogue, and `submit_draft` still offers `resource_watch`.
  None reaches a run today; each is one change away from it.
- **Work that is never read.** AgentLoopDO queues an `activity_event` effect
  on every participant add and delivered turn, and nothing has acted on that
  kind since WorkspaceDO migration 139 dropped `workspace_activity_events`: a
  queue message per event that costs latency and does nothing.
- **Coverage looks larger than it is.** Several suites test exports only they
  call, and `test/provider-webhooks.test.ts` drives only a branch production
  never takes.
- **Every audit pays again.** The documentation audit's slice reports list the
  same dead code each time it is read.

## Goals

1. Every inventory item is deleted, with its tests, comments and documents, or
   recorded in the decision log as kept, with the reason.
2. A `git grep` for each named symbol finds no production caller and no test
   that exists only to exercise it.
3. No model-facing text names a tool, trigger or subject kind Rally cannot act
   on.
4. No code comment links a document that is not in `docs/`, or describes a
   Thread, Channel, Breakout or Space as something that runs.
5. Every desktop still in use keeps parsing every frame and answer through each
   phase, and every message already queued is still accepted.
6. Stored data changes only in the last phase, after `retire_threads` has run
   in every Organization.
7. The support-session Workers proof is restored against a Canvas Chat; the
   creator-only desktop-action proof is retired with its protocol.

## Non-goals

1. **Renaming storage** (`workstream`, `WorkstreamId`, `SUBSTREAM_AGENTS`,
   `automation`, `channels`), per
   [the rebrand inventory](../../rally-rebrand-inventory.md).
2. **Dropping columns a released CHECK names**, such as
   `artifact_registry.workstream_id`, which would rebuild the table.
3. **Editing a Durable Object migration or baseline that has run.** They are
   append-only.
4. **Live defects.** The guest's 403 pane on an unshared Canvas
   ([plan §9](../2026-11-06_canvases-and-sidekicks/plan.md#9-follow-ups-after-this-pull-request))
   is a bug in live code and gets its own change.
5. **The Trust Center's legal text**, which changes with a version bump that is
   the owner's or legal's call.
6. **Removing retired values from telemetry schemas** (`suggested_work`,
   `workstream_control`, `digest`, `new_meeting_note`): the lakehouse parses
   history against them. Only client code that could still emit one goes.
7. **Reviving a retired mechanism.** That is a new PRD, starting from the
   records in [`architecture.md`](../../architecture.md#retired-documents).

## Product behavior

Nothing a person does in Rally changes. Three differences are visible, all in
phase 4: a saved message export draws the brand primary `#CCFF00` rather than
`#CEDC00`; the GitHub App listing speaks of Canvases and Sidekicks; and Ace no
longer lists `suggested-work-enabled`.

Each phase fails where someone will notice: a deleted caller that was live
fails typecheck or its Workers test, a queued message in a shape this release
no longer accepts lands in the dead-letter queue, and the phase order exists to
keep an older desktop from meeting a frame it cannot parse.

## Impact on the product contract

None. The implementation brief already says Rally has no channels, threads,
session import or digests; this makes the code agree.

## Decision log

1. **2026-11-09: `withWorkspaceRuntimeDatabase` keeps its no-binding
   fallback.** Production never takes it, but 34 focused Node tests in 8 files
   build an environment without `WORKSPACE_DOS` and rely on it to run their
   SQL on the D1 stand-in. Removing it would make each of them build a binding
   that does the same thing. It stays as a declared test seam; every other
   `!WORKSPACE_DOS` branch in `services/` is gone.
2. **2026-11-09: every agent-only embedded-browser command goes, not only
   `script` and `script_reset`.** With the executor deleted, `snapshot`,
   `screenshot`, the input commands, `evaluate`, `cdp`, `network` and
   `response_body` had no sender either, and two of them put page script and
   DevTools on the main process's IPC surface.
3. **2026-11-09: the meeting-cleanup RPCs go now.** The production checkpoint
   recorded every WorkspaceDO at 58 or later, so the cleanup they drove is
   finished.

## Key design decisions

1. **Order by risk, not by subsystem**, so a phase with no risk merges on its
   own day. One pull request per subsystem would tie a comment fix to a table
   drop that waits for the operator.
2. **Delete each test with the code it proves**, per
   [testing.md](../../testing.md#what-to-test-and-what-not-to). Where a live
   behavior is proved only by such a suite, its proof moves first (phase 3).
3. **Stop producing before you stop accepting.** A wire or queue shape loses a
   member over two releases: producers stop first, readers once the oldest
   desktop in use has updated and the queue has drained. A strict object that
   loses a field in one change rejects every message already queued.
4. **Keep the agent-profile primitive, delete its one use.** `AgentProfile`,
   `agentProfileFor` and the `agent_profile_unknown` refusal stay, because the
   stored `agent_profile` column still holds `session_import` rows that must
   be refused rather than run with every tool.
5. **The migration phase is separate and last**, since the migration tracker
   is the only fleet signal and a WorkspaceDO migration runs only as each
   object wakes.

## Data model

Only phase 8 changes data, by appended migrations. `authorization_locations`
Thread rows and Thread `conversation_view_*` rows stay, since they cannot be
told apart safely, and a cleanup that drops Thread rows from D1 `workstreams`
bumps the Turbopuffer namespace first ([text-search.md](../../text-search.md)).
Values stored rows still carry stay readable until then: the `resource_watch`
trigger, `session_import` in `agent_profile`, the `space` and `workstream`
parent kinds, `activity_event` in the `parent_outbox.effect_kind` CHECK, and
the `thread`, `channel` and `breakout` memory subject kinds.

## Security and trust model

This work narrows the trust surface and opens nothing. Deleting the browser
plugin and realm removes a path that would run model-written script in a
signed-in browser; it is unreachable today and will not exist after. The
profile refusal stays (decision 4). Restoring the support-session proof puts
impersonation's guarantees back under a Workers test: no read state written,
every read audited, the staff member not counted as a viewer
([impersonation.md](../../impersonation.md)).

## Agent behavior

No tool is added. The browser plugin and `browser_js` go; the three
reading-an-AI-chat skills leave `BUILT_IN_SKILLS`; the `import_finish` and
`import_fail` labels leave `tool-activity.ts`; `submit_draft` stops offering
`resource_watch`; and the memory prompts stop naming the `channel` and
`breakout` kinds. Each is a model-behavior change: update the prompt pins in
the same change and run the addressing and premature-stop evals before and
after.

## Provider configuration

- **GitHub App description** (`config/provider-apps/github.json`) changes in
  every region's app settings.
- **`OPENROUTER_STRUCTURED_MODEL`** leaves `apps/api/src/env.ts`'s schema one
  deploy before it leaves `wrangler.global.jsonc`, because the schema requires
  it and a Worker without it fails start-up.
- **`suggested-work-enabled`** is deleted in Flagship by an operator after
  phase 4 ships; Ace's `ensureFlag` never deletes.

## Rollout

No flag. Phases 1 to 4 are independent. Phases 5 and 6 each have a second
step that waits one desktop release or a drained queue (decision 3). Phase 7 is
two deploys in order. Phase 8 waits for the operator's run everywhere. Each
item was found on 2026-11-08 with `git grep` over `apps/`, `packages/` and
`scripts/`; re-run that grep before deleting, and update the owning document in
the same change.

### Progress

Shipped in juno-ai-labs/avalon#1500: phases 1 to 4 in full (the runtime
database fallback kept, decision 1); phase 5's desktop-action server half, the
browser plugin and realm (decision 2), the `activity_event` producers and
`announceTo`'s writer; phase 7's first deploy. Phase 8's WorkspaceDO drops
shipped earlier in #1494 and #1495, with `schedules` and `digest_schedules`
kept by the #1495 hotfix.

Left, each waiting on something named:

- **One desktop release or a drained queue** (decision 3 of Key design
  decisions): the `answer_desktop_action` and `desktop_action_requested` frame
  schemas and `packages/contracts/src/desktop-actions.ts`;
  `WorkstreamActivityEffectSchema`; `announceTo` in the review notice schema;
  the AgentLoopDO `desktop_actions` tables (phase 8).
- **Phase 7's second deploy:** `OPENROUTER_STRUCTURED_MODEL` out of
  `wrangler.global.jsonc`, `scripts/sync-dev-env.mjs` and the
  inference-boundaries lint rule, then `pnpm lint:fresh`.
- **Open questions 1 to 3:** the artifact-pins route, the digest deep-link
  section, `SubstreamInitialContext`, the `resource_watch` trigger type and
  the metered activities.
- **Not started:** digestibility as one list, `membershipVersion`, the
  four-kind parent enums and the memory subject kinds (phase 6), and the
  `memory_facts` rebuild and D1 Thread authority tables (phase 8). The
  support-session Workers proof against a Canvas Chat is not yet restored.
- **Operator:** change the GitHub App description in every region's app
  settings to match `config/provider-apps/github.json`.

### Phase 1: comments, test names and orphaned CSS

- Code comments that link a deleted document (in `retired-workspace-schema.ts`,
  `workspace-do.ts`, `workstream-identity-storage.ts`, `app.css` and about ten
  more files): repoint each to its record in
  [`architecture.md`'s Retired documents](../../architecture.md#retired-documents),
  or delete the link where the document has no record.
- Comments describing deleted surfaces (the meeting window, the substream
  launcher, the import window, "a conversation-import run drives a signed-in
  browser" in `agent-profiles.ts`), and the remaining comments in about 85 files
  that describe Threads, Channels, Spaces or Breakouts as live. Leave a comment
  that explains a storage name.
- Test names that still name deleted concepts, renamed without other change.
- The `.account-trigger` and `.meeting-titlebar` CSS, which no source uses;
  check the sidebar footer in a real window in both appearances.

### Phase 2: dead exports

- `resolveFrozenDeliveryIdentity` (`services/user-delivery.ts`) and
  `acknowledgeConnectorAgentActivation` (`packages/connectors/src/types.ts`),
  called only by their tests.
- The four meeting-cleanup RPCs (`retiredMeetingInventory`,
  `purgeMeetingSearchAuthorization`, `purgeMeetingNoteObjects`,
  `finalizeMeetingRetirement`) and their retirement-gate permits. **Keep** the
  migration-57 shim and the migration-58 guard, which run on every cold start.
- `digestibleActivityTypes` in the connector manifest transform.
- The `kind: 'choice'` variant of `ComposerModelControl`, which nothing builds.
- The renderer's `'workstream_control'` socket telemetry parameter and the
  `scheduled_digest` origin branches in run-outcome and tool-usage telemetry;
  the contract enum values stay (non-goal 6).

### Phase 3: legacy branches whose only test must move first

- The `!WORKSPACE_DOS` branch of `services/provider-webhook-service.ts`.
  `WORKSPACE_DOS` is a required binding, so production never takes it; first
  move `test/provider-webhooks.test.ts` onto WorkspaceDO and prove it can fail
  there.
- The other `!WORKSPACE_DOS` branches (`connection-service.ts`,
  `slack-agent-service.ts`, `workspace-runtime-database.ts`,
  `workstream-wakeup-service.ts`, `integrations.ts`), with the Node tests that
  build an environment without the binding to reach them.

### Phase 4: visible leftovers

- `#cedc00` and its `#b6c400` border in `apps/desktop/src/main/message-export.ts`,
  an earlier brand primary; check the export in a real window.
- The GitHub App description, which says "work streams and automations".
- `suggested-work-enabled`: Ace's `ensureFlag`, protocol and default
  selection, `SUGGESTED_WORK_FLAG_KEY`, and the key in
  `ProductFeatureFlagKeySchema`. No desktop code outside tests reads it; the
  contract field defaults to false, so it may stay one release.

### Phase 5: dormant protocols with a wire or queue shape

- **The desktop-action protocol's server half**: `requestDesktopAction`,
  `answerDesktopAction`, `answersDesktopActions`, `offerPendingDesktopActions`
  and the `desktopAction` authority (`agent-loop-do.ts`,
  `runtime/local-authorities.ts`, `integrations.ts`,
  `services/desktop-actions/executor.ts`,
  `workstream-desktop-action-storage.ts`). `AGENT_PROFILES` is empty, so
  nothing reaches it. Then the `answer_desktop_action` and
  `desktop_action_requested` frames (the server stops sending and still parses
  and drops an answer; the schemas go a release later), and
  `packages/contracts/src/desktop-actions.ts`.
- **The browser plugin and realm**: `createBrowserPlugin`,
  `browser-runtime.ts`'s model text, `READING_AI_CHATS_SKILLS`, the import tool
  labels, and on the desktop the browser-script bootstrap, protocol, runtime
  and driver, `common/desktop-actions/`, the `script` and `script_reset`
  embedded-browser commands and `agentDriven`. That command union is internal
  to one desktop build, so it carries no compatibility constraint.
- **The `activity_event` conversation effect**: stop its producers in
  `workstream-object-product.ts`, keep the union members until the queue has
  drained with no dead letters for the kind, then remove
  `WorkstreamActivityEffectSchema`. The `parent_outbox` CHECK keeps the value.
- **Digestibility in connector manifests**: the `{ digestible, operational }`
  partition in `defineConnectorActivityTriggers` becomes one list, and the
  descriptor's `digestible` field goes optional, then away once no client
  parses the manifest strictly.
- **`/navigation/artifact-pins` and `ArtifactPinListSchema`**, which always
  answer empty: the artifact window reads today's pin source first, then the
  route goes a release later.
- **`announceTo`** on the Sidekick review notice, written and never read.
- **`membershipVersion`** on socket tickets and admission, always `0` on the
  hosted path; confirm the decision path is `0` too, or drop this item.
- **The `digest` Settings deep-link section**, which digest emails already in
  inboxes still carry; decide where an old link lands first.
- **The metered activities `suggestion_draft` and `session_import`**, once
  the usage queue has drained and no lakehouse reader needs them.

### Phase 6: stored row shapes

- **The `resource_watch` trigger type**: the model stops being offered it,
  then stored definitions carrying it are migrated or refused, once a count
  says how many exist. **Keep** `resource_watches` and its polling, the live
  resource-watch mechanism.
- **`SubstreamInitialContext`** and its local-cache slot: send readiness for a
  non-zero substream still waits on the slot, so gate it on the snapshot first,
  then stop reading cached rows a release later.
- **The three four-kind parent enums** (`RetirementParentKindSchema`,
  `EffectParentKindSchema`, `StoredConversationParentKindSchema`), collapsed
  after phase 8 removes the last `space` and `workstream` rows.
- **The `channel` and `breakout` memory subject kinds** and the prompts that
  name them. `thread` is live: it is how a Canvas's facts are stored.

### Phase 7: a deploy-affecting Worker variable

- `OPENROUTER_STRUCTURED_MODEL`, with no reader in `apps/api/src`: deploy one
  removes it from `env.ts` and the test environments, deploy two from
  `wrangler.global.jsonc`, `scripts/sync-dev-env.mjs` and the
  inference-boundaries lint rule (then `pnpm lint:fresh`).

### Phase 8: migrations after the operator's run everywhere

- WorkspaceDO: `channels`, `spaces`, `breakouts`, their viewer tables,
  `parent_*` and their memory-digest and search triggers, `digest_schedules`
  (the `schedules` foreign key first), `slack_agent_sessions`,
  `slack_agent_feedback`, `slack_agent_pending_prompts` (no writer since the
  Slack App Home change), `external_registration_generations` and
  `workspace_workstream_effect_receipts`; D1's Thread authority tables once
  Canvas and Sidekick creation stop reading them.
- AgentLoopDO: `desktop_actions` and `desktop_actions_pending`, after phase 5.
- The `memory_facts` rebuild that narrows the subject-kind CHECK, keeping
  `thread`.

### Tests to restore or retire

- **Retire** the creator-only desktop-action answer proof with phase 5's
  protocol: the guarantee has nothing left to protect.
- **Restore** the support-session proof (reads and the socket leave the
  person's read state alone, are audited, and are not counted as a viewer)
  against a Canvas Chat in `apps/api/test-workers/`, proved by writing the
  read state for an impersonated read and watching it fail.

### Checked and left out

- **`resource_watches` and its polling**, live (only the trigger type goes).
- **`meeting-notes-retirement.ts`'s migration code**, which runs on every cold
  start (only the RPCs go).
- **`workspace_activity_events.digestible`**: its table is already dropped and
  its `CREATE` is in an append-only baseline.
- **`systemKind?: 'digest'`** on the desktop's directory row type: confirm no
  row is sent with it before listing it.

## Open questions

1. **Which desktop release is the oldest in use?** Step two of each phase 5
   item and of `SubstreamInitialContext` waits on it. Nothing in the tree can
   measure it, so it is the owner's call; it does not block step one.
2. **Where does an old digest link land?** On Notifications, as now, or on the
   deep-link failure page.
3. **How many stored Sidekick definitions carry a `resource_watch` trigger?**
   That decides whether they are migrated or refused.
