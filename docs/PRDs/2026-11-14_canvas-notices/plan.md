# Canvas notices: implementation plan

> Companion to [prd.md](prd.md). Written 2026-11-15 from a survey of the tree
> after the PRD merged (#1611). Where the survey moved a decision, the PRD's
> decision log records it.

Two pull requests, in the order the PRD's Rollout gives. Each phase ends at
its acceptance gate; the second does not start until the first has merged.

## Phase 1: building blocks

Nothing a person sees changes except Settings, which keeps its behavior.

1. **`background_agent.root_reason`.** AgentLoopDO migration 88 adds the
   column. `AgentCommunicationService.start` passes the starting turn's
   reason to `initializeDelegatedAgent`, which writes it in
   `initializeBackgroundAgent`: `sidekick_review` when the turn is the
   self-review or one `reviewOwnsThisTurn` claims for it, otherwise the
   turn's `reason`. A worker started by a worker copies its starter's
   `rootReason` from `agentRuntimeInfo`, as `rootSubstreamId` is copied.
   `claimPersistentLoopExecution` and the wake-up path set
   `backgroundAgentRootReason` on the input beside `backgroundAgent`.
2. **`canvasJoin`.** `POST /canvases/:id/join` → `CanvasService.join` →
   `WorkspaceDO.canvasJoin` → `HostedCanvas.join`, which requires
   `canvasReaderAllows` and inserts the person into `canvas_participants`
   as `added` with themselves as `added_by_user_id`. The existing trigger
   raises `sharing_revision`. Client: `api.joinCanvas`.
3. **`useDevicePushReadiness()`.** One renderer hook returning the device's
   state and the action to offer, for the Mac (`desktopBridge`), the browser
   (`lib/web-push`). The iPhone app's page provides `unknown` through
   `DevicePushReadinessContext` until its shell can report its permission
   (decision log, 2026-11-15). Settings → Notifications takes its device
   rows' words from the hook's `devicePushNotice`.

**Gate.**
- Workers: a worker the self-review starts records `sidekick_review`, a
  worker it starts inherits it, and the claimed input carries it; a member
  admitted only by Organization visibility joins and is listed, and a person
  the Canvas does not admit is refused. Each proved able to fail.
- Renderer tests for the hook's states; Settings screenshots on the Mac and
  in a browser match today's.
- Lint, typecheck, the touched suites; one full `pnpm test` (contracts move).

## Phase 2: notices

1. **Storage.** WorkspaceDO migration 150 rebuilds
   `workstream_notification_intents` and `workspace_activity_items` with
   `canvas_notice` in their CHECKs, as migration 146 did, and creates
   `canvas_notice_registrations` and `canvas_notification_choices`.
2. **Contracts.** `canvasNotices` in `NotificationKindSchema`,
   `OFFERED_NOTIFICATION_KINDS`, `NotificationChannelsSchema` and its choice
   schema; `canvas_notice` in the push payload kind and `ActivityKindSchema`,
   behind client contract 16 and a gate like the source kinds'. A
   `canvas_notice` branch in `ParentNoticeSchema`.
3. **Delivery.** A queue message may carry `channel: "default"`; the push
   consumer resolves it to push when the person has a live device whose
   transport can send, else email, before the allow check. `parentWords`,
   the per-Canvas collapse id and the email footer label gain the kind.
4. **The Canvas.** `HostedCanvas.registerNotices`, `notify` and the choice
   read and write, reached through WorkspaceDO; `GET`/`PUT
   /canvases/:id/notifications` for the viewer's own choice.
5. **The plugin.** `rally:notifications` with `register` and `send`, offered
   per the PRD's matrix (the self-review by `reason` or `reviewOwnsThisTurn`,
   its workers by `backgroundAgentRootReason`). A Sidekick's Canvas is read
   from its attachments before any access filter; reach from
   `sidekickReach`, a run's worker from its root run.
6. **The record and the controls.** The record is a conversation post whose
   schema gains a `canvas_notices_record` form beside the Sidekick
   activation. The renderer draws it as a card with the viewer's controls
   and the device line from `useDevicePushReadiness()`. The title pill menu
   gains Notifications; Settings gains the Canvas notices row.
7. **Docs.** `push-notifications.md`, `member-preferences.md`, `activity.md`,
   `canvases.md`, `agent-loop-types.md` (the gates table), each with its
   changelog entry; the plugin's contract in the owning document.

**Gate.**
- Workers, end to end: register in a Chat posts the record; a run sends;
  every unmuted participant gets an intent and an Activity row; a person
  with a live device is pushed and one without is emailed; a muted person
  gets nothing; a Sidekick on two Canvases is refused, naming both.
- The migration test replays 149 → 150 with rows in both tables.
- The matrix test covers every row of the PRD's plugin table.
- Screenshots: the record for a participant, a non-participant and a muted
  viewer, with the device line on the Mac and in a browser; the menu item;
  the Settings row.
- Lint, typecheck, one full `pnpm test`.
