# Canvases and Sidekicks: implementation plan

> Companion to [prd.md](prd.md). Written 2026-11-06 from a read-only survey of
> the tree. The product owner's answers to the PRD's open questions are in the
> PRD's decision log; this plan is written against them.

The two modes already exist in the codebase and are being pulled to the front.
The survey confirms that for Sidekicks almost entirely, and for Canvases in
every part except live co-editing by people, which the product owner has
removed from scope (see the decision log). The pivot is therefore mostly
deletion plus wiring, with no new subsystem.

## 1. What exists, what is missing

| Capability the PRD needs                                                                         | State today                                                                                                                                                                                                                                                   | Gap                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidekick library and detail page (status, Pause, delegation, schedule, runs)                     | Exists: `apps/desktop/src/renderer/screens/sidekicks-library.tsx`, `screens/automation.tsx`, `components/automation-header.tsx`, `components/sidekick-delegation.tsx`. In the browser host they already render inside the main shell.                         | Move out of the separate `BrowserWindow` on desktop; drop the socket relay.                                                                                       |
| One shared Sidekick conversation                                                                 | Exists as substream `"0"` under the automation id (the authoring chat). Any authorized viewer is seated as a participant before a ticket is issued.                                                                                                           | Audience is managers and viewers of the Sidekick, not everyone it is shared with. Every message runs the wizard; no addressing gate.                              |
| Runs as children of the Sidekick                                                                 | Exists: a run is a `SubstreamAgent` with `substreamId = runId` under `parentKind: "automation"`. Run `channels` rows were dropped in WorkspaceDO migration 32.                                                                                                | Runs are siblings of `"0"`, not rows in it. Nothing writes a per-run row into the shared transcript. `conversation_post` refuses any target that is not a Thread. |
| Sidekick "Needs input"                                                                           | Exists: `conversationNeedsViewer`, run state `needs_input`, `delegationAttention` on the directory row.                                                                                                                                                       | Needs a sidebar group and per-viewer unread for the shared conversation.                                                                                          |
| Live web artifact: publish, version, serve at its own origin, viewer sessions, Data tab, pop-out | Exists: Terminal `publish_resource`, `services/terminal/site-resource-bridge.ts`, `ArtifactHostDO`, the `avalon-artifacts-global` Worker, `components/site-resource-detail.tsx`, `main/artifact-viewers.ts`. Flagged off by default (`liveArtifactsEnabled`). | Access inherits the publishing Thread (`artifact_registry.workstream_id NOT NULL`, `artifact_state.workstream_id NOT NULL`).                                      |
| Canvas list                                                                                      | Partial: the Artifacts section lists pinned artifacts only. `workspace_resource_version_changes` already tracks republishes for unread.                                                                                                                       | No workspace-wide directory of artifacts; no "live now", "from Sidekicks", "shared with me".                                                                      |
| Canvas Chat with Rally                                                                           | The conversation engine is parent-agnostic (`SubstreamAgent` plus a hosted parent in WorkspaceDO; kinds `workstream`, `automation`, `space`). A quoted selection is today's `artifact_annotations` message content.                                           | No `canvas` parent kind. Rally's context assembly for a Canvas does not exist.                                                                                    |
| Comments                                                                                         | Exists as annotations: in-page script, locators, resolution against versions, feed excerpts.                                                                                                                                                                  | None of their own; they stay message content, now in the Canvas Chat.                                                                                             |
| Who is in a Canvas                                                                               | Partial: organization-level presence keyed by `foregroundWorkstreamId`.                                                                                                                                                                                       | Needs a Canvas id.                                                                                                                                                |
| Pinned group per list                                                                            | Exists: `workspace_pins.item_kind` already admits `artifact`; drag-to-pin primitives.                                                                                                                                                                         | Add `canvas` and `sidekick` kinds; drop thread, channel and breakout.                                                                                             |
| Rally edits a Canvas                                                                             | Exists: `publish_resource` republishes the directory and records a version.                                                                                                                                                                                   | Scope it to a Canvas id instead of `(work stream, path)`. No in-place typed edits, cursors or shimmer are built (decision log).                                   |

Everything else in the PRD's "What each feature becomes" table is deletion.

## 2. Decisions this plan is built on

Recorded in the PRD's decision log on 2026-11-06. In short:

- Existing Threads, Breakouts and Channels are deleted at cutover through the workspace-retirement walk.
- A Canvas has its own participant list; default is creator-only; an organization-wide option exists; guests can be invited.
- Anyone a Sidekick is shared with can talk to it. Delegate access is used only for runs its triggers start or that a delegate asks for; a non-delegate's request runs under the requester's own access, and a tool that would need a delegate is refused with a reason.
- Editing stays as it is: Rally republishes; people comment. Live co-editing, cursors, selections and the pending-edit shimmer are out of scope.
- No feature flag; one cutover train.
- Slack mentions and inbound email stop creating conversations. Slack and email stay as Sidekick triggers and delivery, with run-child bindings kept.
- Suggested Work, routing suggestions, digests and the browser session import are deleted. Push stays for Canvas Chat mentions, "Needs input" and finished runs.
- Sideline is deleted; its destination model is Threads.
- All iOS code is deleted.
- Help center and site copy change in the same train.
- Thread-scoped Sidekicks convert to organization scope.

## 3. Target shape

Two conversation parent kinds remain, both hosted inside WorkspaceDO the way
Sidekicks already are: `automation` (the Sidekick; the wire name stays, per the
storage-name rule in `AGENTS.md`) and `canvas` (new). Every conversation stays
a `SubstreamAgent`; the engine, transcript, loops, tools, compaction, memory
copies, feed socket and composer are untouched.

- **Sidekick** = `automation_directory` row + shared conversation `"0"` + run children. The directory row gains a share list and a per-viewer unread cursor for `"0"`.
- **Canvas** = `artifact_registry` row + `ArtifactHostDO` + a `canvas`-kind conversation (`"0"`) for Chat. The Canvas, not a Thread, is the artifact's owner and audience. Comments are the Chat turns that carry annotations.
- **Sidebar** = one `WorkspaceSidebarSchema` with `canvases`, `sidekicks`, pins, unread, presence. The Channel, Thread, Space, Activity, channel-rail and conversation-view topics go.

## 4. Phases

Each phase is a train of reviewable PRs. Line counts come from the survey.

### Phase A: groundwork, no user-visible change

Server, Sidekicks.

- A-1. Addressing gate for the shared conversation: run `classifyAddressing` for `parentKind: "automation"` substream `"0"` (today only Threads). Gate `rally:sidekicks` authoring tools on management rights so a non-manager's message does not run the wizard (`services/integrations.ts`, `packages/agent-harness/src/automation-creator-tools.ts`).
- A-2. Run rows in the shared transcript: on `provisionRun` and on run completion, `HostedSidekick` appends a collapsed run row into `"0"` (reuse the `automation_activation` message type with `runId`, status and step count). `sidekick_runs_read` backs expansion.
- A-3. `conversation_post` default target becomes the Sidekick's `"0"`; `SubstreamAgent.appendConversationPost` admits `parentKind: "automation"` and `canvas`; the `sidekick_conversation_attachments` CHECK admits `canvas` and drops `workstream`.
- A-4. Audience: `HostedSidekick.authorizeViewer` reads a share list (`personal`, `workspace`, or explicit people). Remove `homeAdmits`, `sidekickGrantViewer` and the owner rule at `services/authorization-service.ts:256`. Add a per-viewer unread row for `"0"` modelled on `channel_viewers`. "Needs input" = existing `conversationNeedsViewer` or `delegationAttention`. Delegation semantics per the decision log: a non-delegate's message runs under the requester's own principal; tools that need a delegate refuse with a named reason.
- A-5. Remove the `workstream` Sidekick scope, the `owning_workstream_id` cascades, Channel-rail bumps, Thread-attached and recommended Sidekicks and `GET /automations/workstream/:id`. A WorkspaceDO migration converts `workstream`-scoped Sidekicks to `workspace` scope.

Server, Canvases.

- A-6. Canvas identity: a WorkspaceDO migration adds `canvas_directory` (canvas id = artifact id, title, created by, updated at, last editor, writer Sidekick id, visibility `creator | participants | workspace`) and `canvas_participants` (built on the scope-grant and invitation tables re-keyed to a Canvas, so guests can be invited the way they are today). `artifact_registry.workstream_id` and `artifact_state.workstream_id` become ignored dead columns; new rows write a sentinel.
- A-7. `canvas` parent kind: a new hosted role in WorkspaceDO modelled on `HostedSidekick`, `ConversationParentKindSchema` gains `canvas`, `SocketService.resolveHostedParent` and the ticket `pk` learn it. `ArtifactOpenService` admission moves from "attached to an accessible conversation" to "Canvas participant or organization-wide Canvas".
- A-8. Canvas directory on the workspace socket: list, recency, unread (`workspace_resource_version_changes` plus Chat unread), live now (presence), from Sidekicks (writer id), shared with me (participant rows). `workspace_pins.item_kind` gains `canvas` and `sidekick`.
- A-9. Create a Canvas: `POST /canvases` creates the directory row, the `canvas` conversation and an empty static artifact version. `publish_resource` from a Canvas Chat republishes that Canvas; from a Sidekick run it creates a new Canvas with the Sidekick as writer. "Canvases it writes to" is a query on the directory. The "Start from a prompt" card creates a Canvas and sends the prompt to its Chat.
- A-10. Presence: `set_presence` carries `foregroundCanvasId`; `workspace_presence` fans out per Canvas for the sidebar dot and the header face pile.
- A-11. Rally in a Canvas Chat: a system-prompt variant with the Canvas's current files as context and `publish_resource` scoped to the Canvas. Each republish is a version attributed to Rally in the Canvas's history.

Client, built as routes the rail does not yet show.

- A-12. `/canvases` home and sidebar section, `/canvases/:id` open screen: artifact view (reuse `site-resource-detail.tsx` and the main-process `WebContentsView`), right panel with Chat and Comments tabs. The tabbed right panel is new; `rail-surface.tsx` mechanics are reused. Chat is `ConversationSurface` with `parentKind: "canvas"`. Comments is `use-annotation-pins` projected from the Chat transcript.
- A-13. `/sidekicks` home as rows (status, shared with, next run) and `/sidekicks/:id` with the shared conversation beside the existing details column, plus triggers, tools and writes-to.
- A-14. Sidebar section components for both lists with Pinned group, unread, live dot and a Needs input group. Reuse `RowLayout`, `SectionHeading`, `SidebarSkeleton` and pin drag.
- A-15. Draft-key family for Canvas chats (`canvas:<id>`); a local-cache slice for the Canvases and Sidekicks directory.

Exit criterion: both sections work end to end by URL on desktop and browser with the old shell untouched. Screenshots under Xvfb per `docs/dev-environment.md`.

### Phase B: cutover

One PR train merged within days.

- B-1. Rail becomes Canvases, Sidekicks, Settings. `SidebarSection`, `SECTIONS`, phone `MoreSections`, the landing fallback (`lib/workstream-landing.ts`) and `last-route` restore point at `/canvases`. Stale routes redirect as `/projects/*` does today.
- B-2. Sidekicks window removed: `createSidekicksWindow`, `system:open-sidekicks`, `lib/window-surface.ts`, `lib/window-escape.ts` and the workspace-sync relay. Settings is the relay's last consumer; move Settings in-window too and delete the relay.
- B-3. Delete client surfaces: Channels (~6,900 lines), Threads (~11,900), Breakouts, merge and suggestions (~2,400 dedicated plus ~380 inside `screens/conversation-surface.tsx`), Activity (~1,650), the Pinned section (~430), the section bodies of `components/navigation-sidebar.tsx`, `main/channel-directory-watch.ts`, the menu-bar content model, browser import, and the `lib/api.ts` methods and `lib/types.ts` shapes the survey lists. Strip breakout and merge props from `conversation-surface.tsx`, `message-feed.tsx` and `workstream-blocks.tsx`.
- B-4. `packages/ui`: delete `conversation-menus.tsx`, `breakout-marks.tsx`, `split-conversation.tsx`, `merge-message.tsx`, `merge-response-card.tsx`, `conversation-suggestion.tsx`, `conversation-card.tsx`, `conversation-identity-tip.tsx`, `space-icon.tsx`, `sideline-composer.tsx`, `sideline-sidebar.tsx` and the Channel parts of `navigation.tsx`; prune the `app.css` families `.channel*`, `.space*`, `.merge*`, `.suggestion*`, `.breakout*`, `.activity*`, `.substream*`.
- B-5. Browser host: Thread and Channel link rewriting in `apps/browser/src/session.ts`, link parsing and copy in `entry.tsx`, `BROWSER_ROUTE_FAMILIES` in `apps/api/src/routes/browser.ts`. Add a Canvas link form to `packages/contracts/src/workstream-links.ts`, the site handoff page (`apps/site/app/workstreams`, `src/workstream-link.ts`, `_redirects`) and site telemetry classification.
- B-6. Menu bar: rebuild its content from the Canvases and Sidekicks directory (Needs input, unread Canvases). Dock badge from the same source.
- B-7. Existing data: the workspace socket stops publishing Thread topics; a guarded operator operation runs the workspace-retirement walk for Threads, Breakouts and Channels per organization (`durable-objects/object-retirement.ts`, `workspace_retirement_graph`); their `SubstreamAgent` objects are retired one by one. Idle `parentKind: "space"` conversations go in the same walk.
- B-8. Contracts: delete Space, Thread, Breakout, Activity, merge and suggestion schemas; rewrite `WorkspaceSidebarSchema`; `ConversationParentKindSchema` = `automation | canvas`. Engineering MCP: delete the twelve Thread and Channel tools, add `list_canvases`, `read_canvas_chat` and `read_sidekick_conversation`; `send_message` targets those. Ace's model-role catalog loses `workstream_naming` and `workstream_description`.
- B-9. Delete `apps/ios`, `docs/ios-client.md`, its `docs/README.md` row and every "iOS" mention in docs. APNs transport in the desktop main process stays (the macOS app uses it).
- B-10. Delete `apps/sideline`, `apps/api/src/routes/sideline.ts`, `.github/workflows/release-sideline-macos.yml`, `packages/contracts/src/impersonation.ts` Sideline shapes and `docs/impersonation.md` Sideline sections (the impersonation relationship itself stays).
- B-11. Help center and site: new chapters for Canvases and Sidekicks, redirects for removed pages, landing sections, the `llms.txt` line in `apps/site/src/site-chrome.ts`, compare pages.
- B-12. Supersession notes on PRDs `2026-09-16_guest-sharing-browser` and `2026-10-29_browser-website-comments` (re-scoped to Canvases), `2026-08-29_automation-workstream-delivery`, `2026-09-11_sidekick-delivery-reliability`, `2026-09-19_impersonation-platform` (Sideline half). Rewrite the implementation brief's product contract as the PRD requires.

### Phase C: server removal, worker-first

- C-1. Routes: `spaces.ts`, `workstreams.ts`, `conversation-access.ts`, the Thread, Channel and Activity halves of `navigation.ts`, `digest.ts`, `work-opportunities.ts`, `sideline.ts`, the Breakout, merge and suggestion halves of `conversations.ts`; `PUT /workspace/order` and `/pinned-order` reshaped for Canvases and Sidekicks.
- C-2. Services and storage: `workspace-space-storage.ts` (5,877), `workspace-space-protocol.ts`, `space-service.ts`, `space-bootstrap-service.ts`, `channel-access-service.ts`, `channel-rails.ts`, `listing-rules.ts` (re-derive memory-fact visibility from Canvas and Sidekick participation first), `hosted-parent.ts` (3,406) and its schema, `workstream-service.ts`, `workstream-object-creation-service.ts`, directory and batch services, naming and description services, `conversation-merge-service.ts`, `conversation-suggestions.ts`, `thread-backfill.ts`, substream creation and context services, access requests, activity feed and push, digests, suggested work (~5,000 lines with storage and workflow), session import, the Thread branch of `resend-inbound-email-service.ts`, `slack-workspace-workstream-service.ts`, room bindings in `external_conversation_bindings`. Keep `workstream-wakeup-service.ts` (the generic agent timer) and `lib/workstream-email-address.ts` (artifact hostnames depend on it).
- C-3. `SubstreamAgent`: remove Breakout lifecycle and context capture, suggestions, turn disposition, backfill and import desktop actions; delete the 23 `parentKind === "workstream"` branches; split `workstream-object-product.ts` (6,442) into generic hosting and deleted Thread code. Read state (`member_attention`, `acknowledgeRead`, `markUnread`) stays for Canvas Chat and Sidekick conversations.
- C-4. Queues: drop `thread_backfill`, `channel_color_sync`, `space_bootstrap`, `space_default`, `space_intent_resume`, `project_default_resource`, `workstream_batch_update`, conversation-view jobs and the suggested-work half of `conversation-effect-service.ts`; delete `WORK_OPPORTUNITY_WORKFLOW`.
- C-5. Harness and prompts: rewrite the vocabulary in `prompts/workstream.ts` (byte-stable and golden-hashed, so a hash change), `COMPACTION_SUMMARY_PROMPT`, `AUTOMATIONS_PLUGIN_SYSTEM_MESSAGE`, `agent-communication-plugin.ts` descriptions and the `building-live-sites` skill (a Canvas owned by the Sidekick, not a Thread). Delete `workstream-name.ts`, `workstream-description.ts`, `suggestion-draft.ts`, turn-disposition prompts and evals, the Thread-loop `rally:sidekicks` variant and `conversation_merge`. Memory subject kinds become `canvas | sidekick | person | organization`; `workstream`-scoped memory is deleted with its conversations.
- C-6. Search: drop Channel-message indexing; re-derive audience groups from Canvas and Sidekick participation; bump the Turbopuffer generation (v3 to v4) and reindex.
- C-7. Data migrations, in order: deploy readers-free Workers, then append-only WorkspaceDO migrations dropping Space, Channel, Breakout, Activity, digest and suggested-work tables, then a D1 migration dropping `workstream_authority_control`, `workstream_authority_routes` and `workstream_create_receipts` if nothing reads them. Confirm fleet movement in the migration tracker. No DO class is deleted.
- C-8. Tests: delete the ~80 Node and ~45 test-workers files named for removed concepts (~25k lines in test-workers); keep `*-migration.test.ts` files that prove applied history. Rewrite `scripts/smoke-local.mjs`, `scripts/e2e-local.mjs` and `scripts/substream-socket-client.mjs` against a Sidekick conversation; delete `preview-digest-email.mjs`; update eslint rule allowlists (`presentation-boundaries.mjs`, delete `renderer-cache-boundaries.mjs`), then `pnpm lint:fresh`.
- C-9. Demo pack and seed: rewrite `demo-pack.ts` steps as `create_canvas`, `canvas_chat_message` and `sidekick`; `packages/db/seed-product.json` and `seed.sql` without workstreams; D1 `demo_seed_receipts` kinds; the `demo-scenario` skill.

### Phase D: documentation and cleanup, alongside each phase

- D-1. New docs: `docs/canvases.md` (identity, access, directory, Chat, Comments) and `docs/sidekick-shared-conversation.md`. Register both in `docs/README.md`.
- D-2. Rewrite: `desktop-shell.md`, `conversation-surfaces.md`, `live-web-artifacts.md`, `artifact-annotations.md`, `automation-lifecycle.md`, `hosted-conversation-parents.md`, `workstream-durable-object.md`, `architecture.md`, `data-model.md`, `realtime-sockets.md`, `websocket-architecture.md`, `agent-harness.md`, `conversation-tools.md`, `agent-memory.md`, `text-search.md`, `authorization.md`, `scope-invitations.md`, `slack-integration.md`, `external-conversation-bindings.md`, `browser-client.md`, `shared-ui.md`, `engineering-mcp.md`, `e2e.md`, `dev-environment.md`, `demo-workspaces.md`, `branded-ids.md`, `telemetry.md`, `impersonation.md`, `push-notifications.md`.
- D-3. Delete, with a retirement record in the owning doc's changelog (model: `projects.md`): `spaces.md`, `space-access-sources.md`, `listing-rules.md`, `channel-access-requests.md`, `workstream-creation.md`, `substream-creation.md`, `workstream-naming.md`, `workstream-descriptions.md`, `workstream-markers.md`, `workstream-appearance.md` (keep the icon catalog section under a new name), `workstream-links.md`, `workstream-origin-attachments.md`, `workstream-pinning.md` (fold the Pinned group into `canvases.md`), `thread-backfill.md`, `conversation-merge.md`, `conversation-suggestions.md`, `suggested-work.md`, `contextual-routing.md`, `jev-classifier-opportunities.md`, `digests.md`, `attention-menu.md`, `pane-stack.md`, `conversation-view-cache.md`, `ios-client.md`, and `menu-bar.md` unless B-6 keeps the menu bar.

## 5. Removal inventory

Dedicated code only; shared files that lose branches are counted in the phase steps.

| Area                      | What goes                                                                                                                                                                                                                                                                                    | Approx. lines      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Desktop renderer and main | Channels 6,900; Threads 11,900; Breakouts, merge, suggestions 2,400; Activity 1,650; Pinned section 430; sidebar section bodies ~1,400; Sidekicks window plumbing ~800                                                                                                                       | ~25,000 with tests |
| iOS                       | `apps/ios`                                                                                                                                                                                                                                                                                   | 9,000              |
| Sideline                  | `apps/sideline`, shared UI, route, workflow                                                                                                                                                                                                                                                  | ~3,600             |
| `packages/ui`             | 11 Thread-specific components and CSS families                                                                                                                                                                                                                                               | ~2,000 plus CSS    |
| API routes                | spaces, workstreams, conversation-access, navigation halves, digest, work-opportunities, sideline, conversation halves                                                                                                                                                                       | ~1,900             |
| API services and storage  | Space storage 5,877; hosted parent 3,805; suggested work ~4,300; activity and digests ~3,300; Thread services ~4,500; Breakout services ~1,700; naming and description ~1,900; merge, suggestions, backfill ~1,400; session import ~660; Slack Thread creation ~800; demo pack rewrite 1,400 | ~30,000            |
| Harness                   | prompts, turn disposition, suggestion drafts, Thread-loop plugin variant, evals                                                                                                                                                                                                              | ~1,500             |
| Contracts                 | `spaces.ts` 637, `substream-creation.ts` 200, `conversation-merge.ts` 171, `conversation-suggestions.ts` 79, the Activity half of `navigation.ts`, Thread schemas in `index.ts`, Sideline shapes                                                                                             | ~2,600             |
| Tests                     | ~80 Node files, ~45 test-workers files named for removed concepts                                                                                                                                                                                                                            | ~35,000            |
| Scripts and tooling       | smoke and e2e lanes, digest preview, one eslint rule                                                                                                                                                                                                                                         | ~1,500             |
| Engineering MCP           | 12 Thread tools and their API bridges                                                                                                                                                                                                                                                        | ~1,500             |
| Site                      | 83 of 91 help pages rewritten or removed, landing and compare copy                                                                                                                                                                                                                           | content            |

## 6. Reuse inventory

Do not rebuild: `ConversationSurface`, `lib/transcript.ts`, `lib/use-workstream-socket.ts`, the composer and drafts, `message-feed.tsx` and `workstream-blocks.tsx` (minus merge props), `title-pill.tsx`, `resizable-sidebar.tsx`, `sidebar-skeleton.tsx`, list motion, pin drag, `workstream-glyph.tsx`, the appearance picker, `inspector-rail.tsx` mechanics, `site-resource-detail.tsx`, `artifact-viewers.ts`, the annotation script and client pieces, `SubstreamAgent`, `HostedSidekick`, `ArtifactHostDO`, `SocketService` and the ticket pipeline, `workspace_pins`, `workspace_resource_version_changes`, scope grants and invitations, `workstream-wakeup-service.ts`, `lib/workstream-email-address.ts`, the search pipeline, memory tables, every connector.

## 7. Risks

- **Prompt golden hashes.** `prompts/workstream.ts` and the compaction prompt are byte-stable and hashed, and every Sidekick run reads Thread vocabulary. C-5 is a model-behavior change; run the addressing and premature-stop evals before and after.
- **Artifact hostnames depend on the Thread email allocator.** Deleting `lib/workstream-email-address.ts` breaks `services/artifact-hostname.ts`. Keep the allocator and the Global `workstream_email_routes` ledger under their current names.
- **Memory-fact visibility derives from Channel listing rules** (`listing-rules.ts` is imported by `workspace-memory-facts-storage.ts`). Re-derive before deleting.
- **Deleting Threads is irreversible.** The retirement walk is per organization and per object; run it behind a guarded operator operation after the readers are gone, not in a migration.
- **Dead columns are permanent.** `artifact_registry.workstream_id`, `artifact_state.workstream_id`, `automation_runs.workstream_id` and others named in released CHECKs stay as ignored columns.
- **Search generation bump** reindexes every organization.
- **Browser and desktop share one renderer**, so every client deletion lands on both at once. The browser guest-grant model moves from Threads to Canvases in A-6.
- **The migration tracker is the only fleet signal**; a WorkspaceDO drop migration runs only as each organization's object wakes.

## 8. Sizing

Rough PR counts: Phase A 12 to 15; Phase B 10 to 12 landed within days of each
other; Phase C 10 to 12; Phase D alongside each. The team sets the calendar.
