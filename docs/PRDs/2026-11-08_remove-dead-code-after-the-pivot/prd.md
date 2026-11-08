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

The pivot to Canvases and Sidekicks deleted the surfaces, the routes and most
of the services behind Threads, Channels, Breakouts and Spaces. It left behind
a layer of code that still compiles, is still tested, and is still described by
comments as live, though no production path reaches it: a desktop-action
protocol with no user, a browser realm and four model skills that tell the model
to call tools that no longer exist, Slack and connector exports that only their
own tests call, a queued effect kind that no receiver handles, and comments in
about 85 files that describe deleted things as if they still run.

This PRD removes that layer in phases, starting with the lowest risk. People
using Rally see almost nothing change: the email accent colour becomes the brand
colour, Slack App Home stops offering things Slack refuses, and Ace stops
listing the Suggested Work flag. The people who see the change are engineers and
agents working in the tree. After this work, grep, a reviewer and a new agent
session find only code that does something. Changes to stored data come last,
in a phase that waits for the operator's retirement run to finish in every
Organization.

## Motivation

The owner asked for this on 2026-11-08: "Draft a PRD with a detailed
description and list so we don't lose track" of the dead code the pivot and the
audits exposed.

The cost is already visible, in four ways.

- **Documents described dead code as live.** The 2026-11-08 documentation
  audit read about 600 claims in five slices. It retired seventeen documents
  and corrected about 120 more. The pruning pass then retired four more
  (desktop-actions, browser-script-runtime, connector-digestibility and
  meeting-notes), because the code each one described has no caller. Each
  slice report ends with a section of code defects the audit found and did not
  fix. The code is still there, so the next audit will find the same defects
  again.
- **The model is told about tools it cannot call.** `BROWSER_RUNTIME_ENTRY_INSTRUCTIONS`
  (`packages/contracts/src/browser-runtime.ts`) and `NEXT_STEP` in
  `apps/api/src/services/desktop-actions/browser-plugin.ts` both name
  `import_finish` and `import_fail`. Three reading-an-AI-chat skills
  (`packages/agent-harness/src/reading-ai-chats-skills.ts`) are still in the
  built-in catalogue. The submit-draft schema
  (`packages/agent-harness/src/index.ts:2756`) still offers `resource_watch`.
  Its own description of that value says it "does not start Sidekick runs".
  Today none of these reaches a run, because nothing loads the browser plugin
  and the drafting text steers the model away. Each is one change away from
  reaching one, and each makes a reader wonder which parts are real.
- **Work that is never read.** Three AgentLoopDO writers queue an
  `activity_event` effect on every participant add and every delivered turn
  (`workstream-object-product.ts:2253`, `:3085`, `:4459`). Nothing has acted on
  that effect kind since WorkspaceDO migration 147 dropped
  `workspace_activity_events`. That is a queue message per event that costs
  latency and money and does nothing. The latency goal in
  [the agent rule sheet](../../../AGENTS.md) applies here.
- **Coverage looks larger than it is.** Several Node and Workers suites test
  exports that only those suites call: `slackChannelResolutionDenial`,
  `slackEventSearchAuthorization`, `resolveFrozenDeliveryIdentity`,
  `acknowledgeConnectorAgentActivation`, the four meeting-cleanup RPCs, and the
  Slack pending-prompt RPCs. `test/provider-webhooks.test.ts` drives only the
  `!WORKSPACE_DOS` legacy branch, which production never takes. Meanwhile two
  real Workers proofs were lost with deleted test files and have not been
  replaced (see [Tests to restore or retire](#tests-to-restore-or-retire)).

If this is left alone, every later audit pays again for the same findings. Every
agent session reads past the same dead branches. And the four places where a
model is told about tools that do not exist each stay one change away from
reaching a run.

## Goals

1. Every item in the inventory below is either deleted, together with its
   tests and the comments and documents that describe it, or recorded in this
   PRD's decision log as kept, with the reason.
2. A `git grep` for each symbol named in the inventory finds no production
   caller and no test that exists only to exercise it.
3. No model-facing text (prompts, skills, tool schemas or tool descriptions)
   names a tool, trigger or subject kind that Rally cannot act on.
4. No code comment links a document that is not in `docs/`, and no comment
   describes a Thread, Channel, Breakout or Space as something that runs.
5. Every desktop released before this work, back to the oldest one still in
   use, keeps working through each phase. That means it keeps parsing every
   frame and answer it receives, and every queued message already in flight is
   still accepted.
6. Stored data changes only in the last phase, and only after the operator's
   `retire_threads` run has finished in every Organization.
7. The two lost Workers proofs are resolved. The support-session proof is
   restored against a Canvas Chat. The creator-only desktop-action proof is
   retired together with the protocol it covered.

## Non-goals

1. **Renaming storage.** `workstream`, `WorkstreamId`, `SUBSTREAM_AGENTS`,
   `automation`, `channels` and the `workstream:…:substream:…` ids stay as they
   are, per [the rebrand inventory](../../rally-rebrand-inventory.md). This
   PRD deletes code. It does not rename anything. Rejected for this PRD; a rename
   needs its own case.
2. **Dropping released columns.** `artifact_registry.workstream_id`,
   `automation_runs.workstream_id` and the other columns named in released
   CHECK constraints stay as ignored columns
   ([plan §7](../2026-11-06_canvases-and-sidekicks/plan.md#7-risks)). Rejected:
   a column that a released CHECK names cannot be dropped without rebuilding
   the table.
3. **Editing Durable Object migrations or baselines that have already run.**
   `WORKSPACE_PRODUCT_SCHEMA_STATEMENTS` still creates
   `workspace_activity_events` with its `digestible` column, and migration 147
   then drops the table. Both stay exactly as written. Durable Object
   migrations are append-only. Rejected outright.
4. **Fixing the live defects the audits found.** Some audit findings are bugs
   in live code, not dead code. These are left to their own changes:
   - the delegation re-entry model id `rally_skill_recommendations`
     (`integrations.ts:7842`);
   - the Terminal provider-observation alarm that went away with the Thread
     host;
   - the guest 403 pane;
   - Settings offering Email and Slack for kinds that only push;
   - the demo persona's `.invalid` address;
   - the missing `sidekick_requester_files_unavailable` guard;
   - `attention()` returning zeros.
   Deferred to their own changes. They are listed here so that nobody folds
   them into a deletion.
5. **The Trust Center's legal text.** Its stale vocabulary changes with a
   version bump, and that decision belongs to the owner or legal. Deferred.
6. **Removing retired values from telemetry schemas.** `suggested_work`,
   `workstream_control`, `digest` and `new_meeting_note` stay in
   `packages/contracts/src/telemetry.ts`. The file defines a value's presence
   as "has been emitted by some shipped build", and the lakehouse parses
   history against it. Rejected. Only the client-side code that could still
   emit a retired value is removed.
7. **Reviving any retired mechanism.** If the desktop-action protocol, the
   browser realm or digests come back, that is a new PRD. It starts from the
   retirement records in
   [workstream-durable-object.md](../../workstream-durable-object.md),
   [embedded-browser.md](../../embedded-browser.md) and
   [connectors.md](../../connectors.md), not from code kept here. Rejected for
   this PRD.

## Product behavior

Nothing a person does in Rally changes. The visible differences are these four,
each in phase 4:

- **Email.** Mention emails and participant-added emails draw their accent bar,
  their "Rally" label and their **Open in Rally** button in the brand primary
  `#CCFF00`, not `#CEDC00`. A saved message export
  (`apps/desktop/src/main/message-export.ts`) does the same.
- **Slack App Home.** The unlinked view stops offering "Start
  workspace-authorized tasks directly from Slack" and its **Try now** prompts,
  which Slack refuses. The linked view drops **Start a task** and the
  always-empty "Needs attention & recent tasks" section. It names Sidekicks,
  not Automations. The reply to a mention or a DM stays the one recorded in
  [plan §9](../2026-11-06_canvases-and-sidekicks/plan.md#9-follow-ups-after-this-pull-request).
- **GitHub App listing.** The description reads in Canvas and Sidekick terms,
  not "work streams and automations". This is applied in the provider console
  (see [Provider configuration](#provider-configuration)).
- **Ace.** The flag list no longer offers `suggested-work-enabled`. The flag
  page opens on the first flag that remains.

When anything fails, each phase fails in a way someone will notice. A deleted
caller that was in fact live fails typecheck or its Workers test. A queued
message in a shape this release no longer accepts lands in the dead-letter
queue. An older desktop that cannot parse a frame shows its offline state. The
phase order exists to keep that last case from happening (goal 5).

## Impact on the product contract

None. Everything in this PRD refines behavior inside the existing contract. The
implementation brief already says that Rally has no channels, no threads, no
session import and no digests. This work makes the code agree with it.

## Decision log

None yet.

## Key design decisions

1. **Order by risk, not by subsystem.** Each phase is one level of risk, and
   items are grouped by subsystem inside it. A phase with no risk can merge on
   its own day without waiting for anything else. Rejected: one pull request
   per subsystem. That would tie a comment fix to the desktop-action table
   drop, so the safe half would wait for the operator.
2. **Delete each test with the code it proves.** A suite that tests a function
   only that suite calls is not coverage, per
   [testing.md](../../testing.md#what-to-test-and-what-not-to). When a live
   behavior is proved only by such a suite, its proof moves first. That is why
   phase 3 waits on `test/provider-webhooks.test.ts` moving onto WorkspaceDO.
3. **Stop producing before you stop accepting.** A wire or queue shape loses
   a member in two releases. In the first, producers stop writing it and
   readers still accept it, as an optional field or a union member that is
   received and dropped. In the second, the reader stops accepting it, once
   the oldest desktop in use has updated and the queue has drained. Rejected:
   removing both in one change. A strict object that loses a field rejects
   every message an older version had already queued.
4. **Keep the agent-profile primitive. Delete its one use.** `AgentProfile`,
   `agentProfileFor` and the `agent_profile_unknown` refusal
   (`apps/api/src/services/agent-profiles.ts`) are a generic narrow-surface
   building block. The stored `agent_profile` column still needs that refusal
   for rows written with `session_import`. Only the `desktop` executor
   parameter and the browser plugin go. Rejected: deleting the registry. The
   column would remain, and nothing would stop an unknown value from running
   with every tool.
5. **The migration phase is separate and last.** Every table drop waits for
   the operator's run everywhere. Per
   [plan §7](../2026-11-06_canvases-and-sidekicks/plan.md#7-risks), the
   migration tracker is the only fleet signal, and a WorkspaceDO migration runs
   only as each Organization's object wakes.

## Data model

Only phase 8 changes data. Its list is in the [phase 8 table](#phase-8-migrations-after-the-operators-run-everywhere-risk-irreversible).
Three rules apply to all of it:

- New WorkspaceDO and AgentLoopDO migrations are appended. No baseline or
  earlier version is edited (non-goal 3).
- `authorization_locations` Thread rows and Thread `conversation_view_*` rows
  stay, because they cannot be told apart safely.
- Any cleanup that drops Thread rows from D1 `workstreams` bumps the
  Turbopuffer namespace first ([text-search.md](../../text-search.md)).

Values that stored rows still carry stay readable until phase 8, and in some
cases for good:

- the `resource_watch` trigger in stored Sidekick definitions;
- `session_import` in `agent_profile`;
- the `space` and `workstream` parent kinds;
- `activity_event` in the `parent_outbox.effect_kind` CHECK;
- the `thread`, `channel` and `breakout` memory subject kinds.

## Security and trust model

This work narrows the trust surface. It opens nothing.

- **Browser.** The browser plugin and realm deletions remove a path that would
  run model-written script in a signed-in browser over page content that may
  carry instructions ([agent-profiles.ts](../../../apps/api/src/services/agent-profiles.ts)
  says that was the point of the narrow profile). Today that path is
  unreachable. After this work it does not exist.
- **The profile refusal stays.** The `agent_profile_unknown` refusal stays
  (decision 4), so a stored `session_import` row is still refused and is never
  run with the full tool surface.
- **Support sessions.** Restoring the support-session proof (goal 7) puts
  impersonation's three guarantees back under a Workers test: no read state
  is written, every read is audited, and the staff member is not counted as a
  viewer ([impersonation.md](../../impersonation.md)).

## Agent behavior

No tool or plugin is added. The model-facing changes are all removals:

- The browser plugin (`createBrowserPlugin`) and its `browser_js` surface are
  deleted. No run has been given them since `AGENT_PROFILES` became empty.
- `READING_AN_AI_CHAT_SKILL`, `READING_CHATGPT_CONVERSATIONS_SKILL` and
  `READING_CLAUDE_CONVERSATIONS_SKILL` leave `BUILT_IN_SKILLS`. Their owner
  plugin is the deleted browser plugin, so no catalogue offers them today.
- The `import_finish` and `import_fail` labels leave
  `packages/agent-harness/src/tool-activity.ts`.
- `submit_draft` stops offering `resource_watch`, and its `resourceId`
  property goes with it.
- The memory digest and memory sweep prompts stop naming the `channel` and
  `breakout` subject kinds. A Canvas's facts are labelled as a Canvas's.

Each of these changes is a model-behavior change. Where a prompt is pinned by
`packages/agent-harness/src/prompts.test.ts` (the memory sweep is), update the
pin in the same change. Run the addressing and premature-stop evals before and
after, as [plan §7](../2026-11-06_canvases-and-sidekicks/plan.md#7-risks)
requires for prompt edits.

## Provider configuration

- **GitHub App description.** The description in
  `config/provider-apps/github.json:4` changes in the GitHub App settings for
  every region's app. If it is not applied, only the listing's wording is wrong.
- **Wrangler variable.** Removing `OPENROUTER_STRUCTURED_MODEL` (phase 7)
  removes a variable from `apps/api/wrangler.global.jsonc`. It must leave
  `apps/api/src/env.ts`'s schema in an earlier deploy than the variable leaves
  the Worker. `env.ts:505` requires it as a non-empty string, so a deploy that
  drops the variable first fails Worker start-up.
- **Flagship flag.** `suggested-work-enabled` remains as a flag in Flagship.
  Ace's `ensureFlag` creates flags and never deletes them. An operator deletes
  the flag in Flagship after phase 4 ships.

## Rollout

No flag, and no staged audience. Each phase ships to everybody on merge. Phases
1 to 4 are independent of each other. Phases 5 and 6 each have a second step
that waits one desktop release (decision 3). Phase 7 is two deploys in order.
Phase 8 waits for the operator's `retire_threads` run in every Organization.

Each row is one item. **Evidence** is what was found on 2026-11-08 at
`a7a7cd009` with `git grep -n` over `apps/`, `packages/` and `scripts/`.
**Goes with it** lists the tests, contracts, documents and comments that leave
in the same change, plus anything that must not be touched. **Risk** is one of:

- none;
- coverage, where a live behavior's only test has to move first;
- visible;
- wire, which means an older desktop or a queued message;
- stored row shape;
- deploy-affecting;
- irreversible.

Each change updates its owning document in the same change, as
[the agent rule sheet](../../../AGENTS.md) requires.

### Phase 1: comments, test names and orphaned CSS (risk: none)

| # | Item: files and symbols | What it was for | Evidence it is dead | Goes with it | Risk |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Code comments linking deleted documents. There are 27 references in 14 files. `retired-workspace-schema.ts` has 7: `:425`, `:442`, `:487`, `:557`, `:595`, `:619` and `:966`. `workspace-do.ts` has 7: `:3877`, `:3896`, `:3917`, `:3935`, `:3979`, `:4046` and `:4066`. `workstream-identity-storage.ts` has 3: `:263`, `:267` and `:306`. `packages/ui/src/styles/app.css` has 3: `:766`, `:3178` and `:6776`. The other seven files have one each: `authorization-storage.ts:65`, `workstream-object-schema.ts:3500`, `apps/api/src/env.ts:328`, `conversation-surface.tsx:539`, `packages/contracts/src/projects.ts:8`, `index.ts:516` and `citations.ts:609`. | They pointed a reader at the document that owned a mechanism. | Each target is gone from `docs/`: spaces, space-access-sources, projects, conversation-merge, conversation-suggestions, session-import, digests, channel-access-requests, substream-creation and five workstream-* documents. The `docs/bind.md`, `docs/new.md` and `docs/plan.md` hits are fixture paths, not links, and stay. | Repoint each comment to the retirement record in the owning document's changelog. If the comment says nothing else, delete it. | none |
| 1.2 | Comments describing deleted surfaces: the `.meeting-titlebar` list item (`app.css:948-955`), "the meeting window" (`App.tsx:251`), the **New substream** action (`workstream-blocks.tsx:1709`), "per work stream" (`ui-store.ts:50`), `applyVersionedWorkstreamState` (`workstreams-cache.ts:29`), the substream launcher (`composer-input.tsx:51-52`), `device-timezone.ts:21`, and the import window (`apps/desktop/src/main/index.ts:900`, `embedded-browser.ts:110`, `common/desktop-actions/store.ts:6`, `tool-activity.ts:296`). | Each described code that existed when it was written. | The named surface, rule or function is absent from the tree. | Nothing else. | none |
| 1.3 | The remaining comments that describe Threads, Channels, Spaces or Breakouts as live, in about 85 files. The largest are `workspace-do.ts`, `workspace-memory-facts-storage.ts`, `workspace-pin-storage.ts`, `agent-loop-do.ts` and `workspace-memory-facts-protocol.ts`. | Pre-pivot description. | Counted in [plan §9](../2026-11-06_canvases-and-sidekicks/plan.md#9-follow-ups-after-this-pull-request), "Code kept until a later pass". None of them changes behavior. | Leave alone any comment that explains a storage name (non-goal 1). | none |
| 1.4 | Test names naming deleted concepts: `test-workers/conversation-tools.test.ts:541` (`a Breakout's access to its Channel`) and `test-workers/resource-listing-visibility.test.ts:338`. | Their names come from the scenarios they first covered. | Each test now runs against a Canvas or Sidekick conversation. | Rename the tests and change nothing else. | none |
| 1.5 | `.account-trigger` CSS (`packages/ui/src/styles/app.css:1639`, `:1654`, `:7199` and `:7210`). | The style for the old account trigger. The impersonation document cited a `packages/ui/src/components/account-trigger.tsx` that is not in the tree. | No `.ts` or `.tsx` file uses the class name. | Check the sidebar footer in a real window at 2x, in light and dark, before and after. | none |

### Phase 2: dead exports and unreachable server entry points (risk: none)

| # | Item: files and symbols | What it was for | Evidence it is dead | Goes with it | Risk |
| --- | --- | --- | --- | --- | --- |
| 2.1 | `slackChannelResolutionDenial` (`apps/api/src/services/slack-agent-service.ts:2414`, exported as `__slackAgentTesting` at `:2845`). | Turned a failed Slack channel lookup into the reply for a prompt that started a Thread. | One reference besides its definition: `test/slack-agent-ingress.test.ts:234-238`. | Those test cases. [slack-integration.md](../../slack-integration.md). | none |
| 2.2 | `slackEventSearchAuthorization` (`slack-agent-service.ts:2723`, exported at `:2843`). | Carried a Real-time Search `action_token` into a Slack-started run. | Only `test/slack-agent-ingress.test.ts:277-282` calls it, so no run carries an `action_token`. | Those test cases. Note the removal in slack-integration.md. | none |
| 2.3 | Slack pending prompts: the `rememberSlackPendingPrompt`, `pendingSlackPrompt` and `clearSlackPendingPrompt` RPCs (`workspace-do.ts:10303-10330`), their helpers in `workspace-slack-storage.ts:455-511`, the pending-prompt branch of the routable check (`:441`), and the expiry sweep (`:391`). | Kept a denied prompt so that "try again" could replay it into a Thread. | No production caller for any of the three RPCs. Only `test-workers/workspace-slack-ingress.test.ts:424` and `:462` and the list in `test/helpers/workspace-object-rpcs.ts:123-124` use them. The routable check reads a table that nothing writes. | Those tests and list entries. The table goes in 8.3. | none |
| 2.4 | `resolveFrozenDeliveryIdentity` (`apps/api/src/services/user-delivery.ts:79`). | Resolved a digest or notification recipient's identity as it stood when the delivery was frozen. | Only `test/user-delivery.test.ts` calls it. | Those test cases. | none |
| 2.5 | `acknowledgeConnectorAgentActivation` (`packages/connectors/src/types.ts:529`, re-exported at `packages/connectors/src/index.ts:116`). | Added the activation reaction when a connector mention started work. | Only `slack.test.ts:1460-1491` and `linear-agent.test.ts:166` call it. | Those test cases. [connectors.md](../../connectors.md). | none |
| 2.6 | The four meeting-cleanup RPCs: `purgeMeetingNoteObjects`, `purgeMeetingSearchAuthorization`, `finalizeMeetingRetirement` and `retiredMeetingInventory` (`workspace-do.ts:9597-9666`), and their entries in the retirement gate's `permit` list (`:12037-12040`). | Operator steps for retiring meeting notes. The procedure finished at the 2026-09-15 checkpoint. | No caller anywhere in `apps/` (the Ace and engineering MCP included). Only `test-workers/meeting-notes-retirement.test.ts` calls them. | That test, and any helpers in `meeting-notes-retirement.ts` that only the RPCs use. **Keep** the migration-57 shim and the migration-58 guard: they still run on every cold start ([architecture.md](../../architecture.md), 2026-11-08 records entry). | none |
| 2.7 | `digestibleActivityTypes`, derived in the connector manifest transform (`packages/contracts/src/index.ts:3505`). | Answered "may this event type reach a digest". | No reader anywhere. | Its comment. Nothing else. | none |
| 2.8 | The `kind: 'choice'` variant of `ComposerModelControl` (`apps/desktop/src/renderer/components/composer-input.tsx:70-74`), and the comment block above it. | Let the Thread and substream composers pin a model ahead of the `agent-model-workstream` flag. | Nothing constructs `choice`. Only the `settled` variant has a host. | The `choice` branch of the control's rendering, and its component tests. [feature-flags.md](../../feature-flags.md) already says the choosable shape is offered nowhere. | none |
| 2.9 | The renderer's `'workstream_control'` socket parameter type (`apps/desktop/src/renderer/lib/socket-telemetry.ts:13`). | Telemetry for the Thread control socket. | The only callers of `realtimeSocketTelemetry` pass `'substream_feed'` (`use-workstream-socket.ts:909`) and `'workspace'` (`workspace-socket.tsx:290`). | The test fixtures in `realtime-socket-broker.test.ts:92` and `telemetry-reporter.test.ts:545` and `:604`. **Keep** the value in `packages/contracts/src/telemetry.ts` (non-goal 6). | none |
| 2.10 | The `scheduled_digest` origin branches in `apps/api/src/telemetry/run-outcome.ts:79` and `:86`, and in `tool-usage.ts:149`. | Labelled digest runs as `system` and `digest`. | No code path creates a run with origin `scheduled_digest`. The only references are these three reads. | Their test cases. **Keep** the `digest` value in the telemetry enum (non-goal 6). | none |

### Phase 3: legacy branches whose only test must move first (risk: coverage)

| # | Item: files and symbols | What it was for | Evidence it is dead | Goes with it | Risk |
| --- | --- | --- | --- | --- | --- |
| 3.1 | The `!WORKSPACE_DOS` legacy branch of the provider webhook service (`apps/api/src/services/provider-webhook-service.ts:486` `legacyRegionalAuthority`, `:585-617`, `:1116`). | Wrote connector activity, lifecycle and resource rows straight to D1 before WorkspaceDO owned them. | `WORKSPACE_DOS` is a required binding (`env.ts:78`, `:466`), so production never takes the branch. **Blocked:** `test/provider-webhooks.test.ts` drives only this branch, so its cases move onto WorkspaceDO first ([plan §9](../2026-11-06_canvases-and-sidekicks/plan.md#9-follow-ups-after-this-pull-request), "Tests and lanes"). | The moved test, proved able to fail against the WorkspaceDO path. | coverage |
| 3.2 | The other `!WORKSPACE_DOS` branches: the non-producer route branches in `connection-service.ts:3763` and `:3811`, `slack-agent-service.ts:1698`, `:1961` and `:1989`, `workspace-runtime-database.ts:395`, `workstream-wakeup-service.ts:623`, and the else side of `integrations.ts:9121`. | The same unbound-namespace mode, for unit environments. | The same required binding. The comment at `connection-service.ts:3807` says these exist only for "focused unit/legacy environments". | Every Node test that builds an env without `WORKSPACE_DOS` to reach one of these branches, moved or deleted. | coverage |

### Phase 4: visible leftovers (risk: visible)

| # | Item: files and symbols | What it was for | Evidence it is dead or wrong | Goes with it | Risk |
| --- | --- | --- | --- | --- | --- |
| 4.1 | `#CEDC00` hard-coded in `apps/api/src/services/mention-email-service.ts:127`, `:138` and `:142`, in `participant-email-service.ts:150`, `:161` and `:165`, and in `apps/desktop/src/main/message-export.ts:159`, `:299` and `:311` (the last with a `#b6c400` border). | An earlier brand primary. | The brand primary is `#CCFF00` (`scripts/generate-brand-assets.py:29`). `participant-email-service.ts` was found while verifying this list; the audit had not named it. | Each email checked in a rendered client, and the export checked in a real window. [theming.md](../../theming.md) and [message-export.md](../../message-export.md). | visible |
| 4.2 | Slack App Home: the unlinked copy and **Try now** prompts (`slack-agent-service.ts:2546` and `:2552`), **Start a task** (`:2564`, `action_id: "rally_start_task"`) together with its modal and handler, the "Needs attention & recent tasks" section (`:2569`), and the "Automations" label. | Started Threads from Slack and listed them. | Slack starts no work. The tasks section is always empty. | The modal and slash-command paths that only that section feeds, and their tests. [slack-integration.md](../../slack-integration.md). | visible |
| 4.3 | GitHub App description (`config/provider-apps/github.json:4`). | Listing copy. | It says "work streams and automations". | The provider console (see [Provider configuration](#provider-configuration)). [provider-apps.md](../../provider-apps.md). | visible |
| 4.4 | `suggested-work-enabled`: `apps/ace/scripts/deploy.mjs:157` (`ensureFlag`), `apps/ace/src/protocol.ts:137`, the default selection in `apps/ace/src/client/main.tsx:239`, `SUGGESTED_WORK_FLAG_KEY` and its resolution (`apps/api/src/services/client-feature-flags.ts:52` and `:166`). | Gated the Suggested Work surfaces. | No desktop code outside tests reads `suggestedWorkEnabled`. | `apps/ace/test/app.test.ts` and `workspace-socket.test.tsx:648` and `:1632` switch to a live flag as their fixture. The contract field (`packages/contracts/src/index.ts:456`) is `.default(false)`, so it may stay for one release and then go. [feature-flags.md](../../feature-flags.md) and [ace.md](../../ace.md). | visible (an operator surface) |

### Phase 5: dormant protocols with a wire or queue shape (risk: wire)

For each row here, step one stops the producer and leaves the reader accepting
the shape. Step two removes the reader one desktop release later, or once the
queue has drained (decision 3).

| # | Item: files and symbols | What it was for | Evidence it is dead | Goes with it | Risk |
| --- | --- | --- | --- | --- | --- |
| 5.1 | **The server half of the desktop-action protocol.** In `agent-loop-do.ts`: `requestDesktopAction` (`:6185`), `answerDesktopAction` (`:6228`), `answersDesktopActions` (`:6171`), `offerPendingDesktopActions` (`:6258`, called at `:8153`), and the `desktopAction` authority wiring (`:5591`). Also the `desktopAction` authority in `apps/api/src/runtime/local-authorities.ts:79` and `:91` and its profile wiring in `integrations.ts:3013`, `apps/api/src/services/desktop-actions/executor.ts`, and `apps/api/src/durable-objects/workstream-desktop-action-storage.ts`. | Let a profile run ask the person's desktop to act (session import) and wait for the answer. | `AGENT_PROFILES` is empty (`agent-profiles.ts:42`). The authority goes only to a profile run, so `requestDesktopAction` cannot be reached. No file under `apps/desktop/src` or `packages/ui/src` handles `desktop_action_requested`. | `test-workers/desktop-action-storage.test.ts`, `test/desktop-action-tools.test.ts`, and the creator-only answer proof (see [Tests to restore or retire](#tests-to-restore-or-retire)). The `desktop` parameter of `AgentProfile.plugins`. **Keep** the profile primitive (decision 4). The table goes in 8.2. Update the desktop-actions record in [workstream-durable-object.md](../../workstream-durable-object.md). | wire |
| 5.2 | **The desktop-action socket frames.** `answer_desktop_action` (client to server, `packages/contracts/src/index.ts:2182-2186`) and `desktop_action_requested` (server to client, `:2750`). | Carried 5.1's requests and answers. | No producer after 5.1. An older desktop answers only a request it was sent. | Step one: the server stops sending, and still parses and drops `answer_desktop_action`. Step two: both schemas go. [realtime-sockets.md](../../realtime-sockets.md). | wire |
| 5.3 | **The contracts for desktop actions.** `packages/contracts/src/desktop-actions.ts`, which includes the `session_import.*` action kinds (`:140-198`) and `verifySessionImport` (`:67`). | Types for 5.1 and for import verification. | The only importers are 5.1, 5.4, 5.5 and `session-import-verification.test.ts`. | That test, and the `./desktop-actions` export in `packages/contracts/package.json`. 5.5 must move `StoredItem` and `StoredRef` first if `common/embedded-browser.ts:3` still needs them. | none once 5.1, 5.4 and 5.5 have gone |
| 5.4 | **The browser plugin and its model text.** `apps/api/src/services/desktop-actions/browser-plugin.ts` (`createBrowserPlugin`, `NEXT_STEP` at `:51-52`). `BROWSER_RUNTIME_ENTRY_INSTRUCTIONS` and `BROWSER_RUNTIME_DOCUMENTATION` (`packages/contracts/src/browser-runtime.ts`). `READING_AI_CHATS_SKILLS` (`packages/agent-harness/src/reading-ai-chats-skills.ts`, spread at `built-in-skills.ts:569`, exported at `index.ts:134`). The `import_finish` and `import_fail` labels (`tool-activity.ts:311-312`). | The `browser_js` tool surface for the import run, and the procedure for reading an AI chat. | Only `test/desktop-action-tools.test.ts` calls `createBrowserPlugin`. The skills' `ownerPlugin` is that plugin. The model text names two tools that no longer exist. | The `./browser-runtime` export. Skill catalogue snapshots and prompt pins (see [Agent behavior](#agent-behavior)). [embedded-browser.md](../../embedded-browser.md) and [agent-harness.md](../../agent-harness.md). | none (model text no run receives) |
| 5.5 | **The desktop browser realm.** `apps/desktop/src/common/browser-script-bootstrap.ts` and `browser-script-protocol.ts`, `common/desktop-actions/` (`executor`, `store`, `page-files`, `page-script`, `page-text`, `ax-outline`), `main/browser-script-runtime.ts` and `main/browser-script-driver.ts`. Also the `script` and `script_reset` embedded-browser commands (`common/embedded-browser.ts:53-54` and `:88`, `main/embedded-browser.ts:408`), the run-to-realm map, and `agentDriven` (`main/embedded-browser.ts:114`, `:178` and `:228`). | Ran 5.4's scripts in a signed-in tab and recorded its network. | A realm is created only by a `{action:'script'}` command. Only the desktop executor sends one, for a `browser.script` action, and nothing issues that action. Nothing sets `agentDriven`. | `browser-script-bootstrap.test.ts`, `browser-script-runtime.test.ts`, `browser-script-driver.test.ts`, and the renderer tests under `renderer/lib/desktop-actions/`. The `agentDriven` cases in `embedded-browser.test.ts`. The command union is a desktop-internal IPC between the main and renderer processes of the same build, so it carries no compatibility constraint. [embedded-browser.md](../../embedded-browser.md). | none |
| 5.6 | **The `activity_event` conversation effect.** Its three producers in `workstream-object-product.ts` (`:2253`, `:3085`, `:4459`, each with `digestible: true`), `WorkstreamActivityEffectSchema` (`packages/contracts/src/conversation-effects.ts:165`, with a required `digestible` at `:176`), and its places in `ConversationEffectSchema` and `ParentEffectSchema`. | Fed `workspace_activity_events` for digests and the old Activity feed. | Migration 147 dropped `workspace_activity_events`. Apart from the producers, the two unions and the `parent_outbox.effect_kind` CHECK, no code in `apps/api/src` mentions `activity_event`. Today's Activity rows come from the mention, participant, new-message and run notices. | Step one: stop producing, and leave the union members so that queued effects still parse and are dropped. Step two, once the effect queue has drained, with no dead letters for the kind: remove the schema. **Keep** `'activity_event'` in the `parent_outbox` CHECK (stored). Prove the deletion can fail by checking that no Activity row is lost. [activity.md](../../activity.md) and [workstream-durable-object.md](../../workstream-durable-object.md). | wire (in-flight queue messages) |
| 5.7 | **Digestibility in connector manifests.** The `{digestible, operational}` partition in `defineConnectorActivityTriggers` (`packages/connectors/src/types.ts:80-114`) and its eleven callers. The descriptor's `digestible` field (`packages/contracts/src/index.ts:3317`, strict object). The evaluator copy (`automation-evaluators.ts:463`). The generic-webhook literal (`apps/api/src/lib/connector-activity-triggers.ts:89`). The stream-level `digestible` (`types.ts:262`) and the `ACTIVITY_STREAM_NOT_DIGESTIBLE_METADATA_KEY` stamp (`index.ts:2799`, `types.ts:43`). | Classified an event type as fit for a digest. | No consumer since `activityIsDigestible` was deleted. The harness strips the field before an author sees it (`agent-harness/src/index.ts:3183`). | The partition becomes a single list. The test cases that check the classification (`connectors/src/index.test.ts:306` and `:331`, `fireflies.test.ts:106`, `canva.test.ts:119`, `index.test.ts:722` in the harness). Step one makes the descriptor field optional. Step two removes it, after checking whether any client parses the manifest strictly. [connectors.md](../../connectors.md) and [semantic-activity-triggers.md](../../semantic-activity-triggers.md). | wire (descriptor shape) |
| 5.8 | **`/navigation/artifact-pins` and `ArtifactPinListSchema`.** `apps/api/src/routes/navigation.ts:19` answers `[]`. `apps/desktop/src/main/artifact-window-actions.ts:26` and `main/index.ts:4310` call it for the artifact window's `pin-state`, and `packages/contracts/src/navigation.ts:39` defines the schema. | The artifact pin list from before Canvas pins. | The route always answers `[]`, so the artifact window's pin state is always false. | Step one: the desktop reads pin state from today's pin source, or drops the action. Step two, one release later: the route and the schema go. [pinning.md](../../pinning.md). | wire (older desktop) |
| 5.9 | `announceTo` on the Sidekick review notice (`packages/contracts/src/automation-agent.ts:180`, written at `hosted-sidekick.ts:2186`). | Named the conversation a review notice was announced to. | It is only written. `sidekick-review-notice.ts:35` says it is not read. | Step one: stop writing it, and make the field optional. Step two: remove it. [automation-lifecycle.md](../../automation-lifecycle.md). | wire |
| 5.10 | `membershipVersion` on socket tickets and conversation admission (`socket-service.ts:65`, `:156` and `:221-224`, `conversation-service.ts:27`, `:78`, `:136` and `:205-278`, and `agent-loop-do.ts:350`, `:374`, `:398`, `:1606`, `:7632` and `:7754`). | Fenced a socket against a Channel membership change. | The hosted path always writes `0` (`conversation-service.ts:78`). **Confirm** that the decision path at `:136` is also always `0` before deleting. If it is not, the field is live and this row is dropped. | Socket tickets live a short time, so step two can follow step one by one ticket lifetime instead of a desktop release. [realtime-sockets.md](../../realtime-sockets.md). | wire (tickets in flight) |
| 5.11 | The subscribe answer's always-empty `workstreams` page and `notes: []`. | Kept for one release so that a desktop from before the pivot still parses the answer. | [realtime-sockets.md](../../realtime-sockets.md) records this as a one-release measure. | Remove them once every desktop in use is post-pivot. [websocket-architecture.md](../../websocket-architecture.md). | wire (older desktop) |
| 5.12 | The `digest` Settings section in `DesktopDeepLinkIntent` (`packages/contracts/src/desktop-deep-link-intent.ts:25`, `:26` and `:191`), and its mapping to Notifications (`apps/desktop/src/common/settings.ts:17`, `renderer/lib/app-session.tsx:1063`). | The landing for a digest email's button. | Digests are gone, but digest emails already in inboxes still carry the link. | Decide whether an old link lands on Notifications (keep the mapping) or on the deep-link failure page ([deep-link-failures.md](../../deep-link-failures.md)). Record the decision in the log. | wire (links in sent email) |
| 5.13 | The metered activities `suggestion_draft` and `session_import` (`packages/contracts/src/usage.ts:36`, `:51`, `:72` and `:84`). | Billing roles for suggestion drafts and import runs. | Nothing produces either value. `usage-consumer.ts` parses queued `UsageEventSchema` messages. | Remove once the usage queue has drained. Check [usage-metering.md](../../usage-metering.md) and the lakehouse for any stored reader before removing. | wire (queued usage events) |

### Phase 6: stored row shapes (risk: stored row shape)

| # | Item: files and symbols | What it was for | Evidence it is dead | Goes with it | Risk |
| --- | --- | --- | --- | --- | --- |
| 6.1 | The `resource_watch` **trigger type**: the union member (`packages/contracts/src/index.ts:1159`), the `submit_draft` enum value and the `resourceId` property (`agent-harness/src/index.ts:2756`, `:2784` and `:3338`), and the directory mapping (`sidekick-directory-sql.ts:175`). | Started a run when a watched resource changed. | Nothing arms it (`hosted-sidekick.ts:2885-2905`). The tool's own description calls it legacy. | Step one: the model is no longer offered it, but stored definitions still parse. Step two: a stored definition that carries it either fails to parse or is migrated, once a count across Organizations says how many exist. **Keep** the `resource_watches` table and its polling (`workspace-schedule-execution.ts`). That is the live resource-watch mechanism, separate from this trigger type. [potential-bugs.md](../../potential-bugs.md) records the gap. | stored row shape |
| 6.2 | `SubstreamInitialContext` (`packages/contracts/src/substream-creation.ts:128` and the rest of that file), its cache slot (`apps/desktop/src/renderer/lib/conversation-cache.ts:26`, `:88-95` and `:280-292`, and `use-workstream-socket.ts:732`, `:889` and `:1512`), and the observer in `conversation-surface.tsx:1232`. | The seed a Breakout was created with. | The server dropped `substream_initial_context` (`workstream-object-schema.ts:3827`) and sends no context. The client sets the slot to `null` when a snapshot arrives. **Live coupling:** `sendReady` for a non-zero substream waits for the slot (`use-workstream-socket.ts:1015` and `:1218`), and the local cache will not write a row without it. | Step one: gate send readiness on the snapshot itself, and stop writing `initialContext` into the local cache. Step two, one release later: stop reading it from cached rows, and delete the schema and the rest of `substream-creation.ts` that has no importer. [local-cache.md](../../local-cache.md) and [conversation-surfaces.md](../../conversation-surfaces.md). | stored row shape (the desktop's local cache) |
| 6.3 | `RetirementParentKindSchema` (`packages/contracts/src/workspace-retirement.ts:20`), `EffectParentKindSchema` (`conversation-effects.ts:330`) and `StoredConversationParentKindSchema` (`workstream-object-storage.ts:110`), each a separate four-kind enum that still admits `workstream` and `space`. | Parent kinds from before the pivot. | They are kept for stored rows and for the operator's walk ([plan §9](../2026-11-06_canvases-and-sidekicks/plan.md#9-follow-ups-after-this-pull-request)). | Collapse them into one enum after phase 8 has removed the last `space` and `workstream` parent rows. Until then they stay. | stored row shape |
| 6.4 | Memory subject kinds `channel` and `breakout`, and the model-facing text that names them: `MEMORY_SUBJECT_KINDS` (`workspace-memory-facts-protocol.ts:20`), the producers in `workspace-memory-facts-storage.ts:277` and `:281` (reached only from `workstream` and `space` parents), `memory-review-service.ts:83-85`, `memory-sweep-service.ts:304` and `:547`, and `agent-harness/src/prompts/memory-digest.ts:12`, `:38` and `:46-50`. | Subjects for Channel and Breakout facts. | No live parent produces them: a Canvas is `canvas`, and it maps to `thread`. **`thread` is live.** It is how a Canvas's facts are stored, and it stays. | Step one: the prompts label a `thread` fact as a Canvas's, and a `channel` or `breakout` fact as one about an earlier conversation. The prompt pins are updated (see [Agent behavior](#agent-behavior)). Step two, the `memory_facts` rebuild for its CHECK, goes in 8.4. [agent-memory.md](../../agent-memory.md). | stored row shape |

### Phase 7: a deploy-affecting Worker variable (risk: deploy-affecting)

| # | Item: files and symbols | What it was for | Evidence it is dead | Goes with it | Risk |
| --- | --- | --- | --- | --- | --- |
| 7.1 | `OPENROUTER_STRUCTURED_MODEL`: `apps/api/src/env.ts:199` and `:505` (`z.string().min(1)`), and `apps/api/wrangler.global.jsonc:49`. | The model for structured classification calls. | No reader in `apps/api/src`. The remaining references are the env schema, test envs (`test-workers/queue-dispatch.test.ts:53` and three Node helpers) and the lint rule. | Deploy one: remove it from the env schema and the test envs. Deploy two: remove the Wrangler variable. Also remove it from `scripts/eslint-rules/inference-boundaries.mjs:58` and `scripts/inference-boundaries.test.mjs:43-44`, then run `pnpm lint:fresh`. [api-worker-deployment.md](../../api-worker-deployment.md). | deploy-affecting |

### Phase 8: migrations after the operator's run everywhere (risk: irreversible)

This phase starts only after `dump_thread_transcripts`,
`convert_threads_to_canvases` and `retire_threads` have run in every
Organization, as the migration tracker shows
([durable-object-migration-tracking.md](../../durable-object-migration-tracking.md)).
Every drop is a new, appended migration.

| # | Item: files and symbols | What it was for | Evidence it is dead | Goes with it | Risk |
| --- | --- | --- | --- | --- | --- |
| 8.1 | WorkspaceDO: `channels`, `spaces`, `breakouts`, their viewer tables, `parent_*`, and their memory-digest and search triggers (`memory-digest-sync.ts:98` and `:103`), `digest_schedules` (drop the foreign key from `schedules` first), `slack_agent_sessions`, `slack_agent_feedback`, `external_registration_generations` and `workspace_workstream_effect_receipts`. | Thread-era storage. | Listed in [plan §9](../2026-11-06_canvases-and-sidekicks/plan.md#9-follow-ups-after-this-pull-request), "A later migration". `workspace_workstream_effect_receipts` and `external_registration_generations` are each named in one file only. | The readers that 6.3 and 6.4 leave. [data-model.md](../../data-model.md) and [workspace-retirement.md](../../workspace-retirement.md). | irreversible |
| 8.2 | AgentLoopDO: `desktop_actions` and `desktop_actions_pending` (`workstream-object-schema.ts:3436` and `:3450`). | 5.1's request store. | No writer after 5.1. | `test-workers/desktop-actions-migration.test.ts` becomes the proof of the drop migration. | irreversible |
| 8.3 | WorkspaceDO: `slack_agent_pending_prompts` (`workspace-domain-schema.ts:378`, and its place in the table list at `workspace-do.ts:1196`). | 2.3's store. | No writer after 2.3. | The expiry sweep, if 2.3 left it. | irreversible |
| 8.4 | WorkspaceDO: `workspace_workstream_suggestion_feedback` (`workspace-do.ts:1501`, `CHECK (source IN ('contextual_routing', 'suggested_work'))`), and the `memory_facts` rebuild that narrows the subject-kind CHECK (6.4). | Feedback on suggestions, and Channel and Breakout memory subjects. | The feedback table appears only where it is created. Suggestions are deleted. | Only drop the D1 Thread authority tables once Canvas and Sidekick creation no longer read them. Bump the Turbopuffer namespace before any D1 `workstreams` Thread rows are removed ([text-search.md](../../text-search.md)). | irreversible |

### Tests to restore or retire

| Test | Was in | Decision |
| --- | --- | --- |
| Only a conversation's creator may answer a desktop action (`answersDesktopActions`) | `session-import-run.test.ts`, deleted | **Retire with its code** (5.1). The guarantee has nothing left to protect. Record that in the desktop-actions record in workstream-durable-object.md. |
| A support session's reads and socket leave the person's read state alone, are audited, and do not count as a viewer | `unseen-workstream-state.test.ts` and `workspace-reach-changed.test.ts`, deleted | **Restore** against a Canvas Chat in `apps/api/test-workers/`. Impersonation is live (`agent-loop-do.ts:330-334`, `:3250-3264`). Break it by writing the read state for an impersonated read, and watch the test fail. [impersonation.md](../../impersonation.md) names the gap. |

### Checked and left out

These were named as sources for this PRD and are live, or not shown to be dead:

- **`resource_watches` and its polling.** This is the live resource-watch
  mechanism. Only the trigger type goes (6.1).
- **`meeting-notes-retirement.ts`'s migration code.** It runs on every
  WorkspaceDO cold start. Only the RPCs go (2.6).
- **The `workspace_activity_events.digestible` column.** Its table was already
  dropped by WorkspaceDO migration 147. The column's `CREATE` is in an
  append-only baseline and stays (non-goal 3). D1's `activity_events` was
  dropped in `0090_drop_legacy_product_tables.sql`. So there is no column left
  to remove. What remains live is the effect field (5.6) and the descriptor
  field (5.7).
- **The memory subject kind `thread`.** A Canvas's facts are stored under it
  (6.4).
- **`systemKind?: 'digest'`** (`apps/desktop/src/renderer/lib/types.ts:185`).
  The server still carries `system_kind` on directory rows
  (`workstream-identity-storage.ts:80`). Before listing it, the implementer has
  to confirm that no row is sent with it.
- **`account-trigger.tsx`.** The file is not in the tree. Its CSS is in 1.5.

## Open questions

1. **Which desktop release is the oldest in use?** Step two of each
   phase 5 row and of 6.2 waits on it. Nothing in the tree can measure it, so
   this is the owner's call. The answer changes only when step two lands. It
   does not block step one.
2. **Where does an old digest link land?** On Notifications, as it does now,
   or on the deep-link failure page (5.12)? Either is cheap. Keeping the
   mapping costs three lines.
3. **Are there stored `resource_watch` triggers?** How many Sidekick
   definitions carry one across Organizations decides whether 6.1's step two
   migrates them or refuses them.
