# Guest sharing completion audit

This is the final implementation map for the requested lite collaboration scope. The
[design](design.md) defines the intended behavior; [implementation](implementation.md)
contains the incremental evidence. Browser scope remains lite collaboration:
no workspace creation, setup, connector setup, onboarding, or desktop settings.

## Current boundary

**September 17 product decisions:** Preserve existing substream context behavior
without adding a sharing option or review flow. Keep grants parent-owned,
including coordination for actual participant additions. These decisions
supersede the pending-choice and zero-first-admission-cost concerns in the
historical entries in [implementation.md](implementation.md).

| Requirement | Evidence and remaining work |
| --- | --- |
| Ordinary identity, verified-email entry, reusable guest relationships | The invitation workerd journey now starts through browser email-code routes, rejects a wrong code, reuses the existing verified identity, preserves the cookie on redemption retry, and refuses a second redemption ID. It accepts two independent workstream invitations through the browser adapter. A new identity also completed OTP entry, Main invitation acceptance and rendered navigation against the local API. Actual external mailbox delivery remains unverified. |
| Independent Main, child and complete-workstream grants | Canonical grant storage, migration/projection, inherited/restricted children and durable invitation operations exist. The scope-grant, invitation and creation workerd suites exercise these boundaries. A real Chromium session now accepts a second workstream invite and navigates both. A real Main with no participants now verifies that workspace-public reading does not expose sharing options, create invitations or start authority migration. |
| Participant lists and full scoped mutation | Conversation routes and sockets use exact conversation admission. The guest pipeline case exercises real socket message admission, uploads, participant changes and revoked access. The real-workerd connector executor now performs an allowed Google document write against a controlled provider and blocks a second write when the share is revoked during credential refresh. The scoped mutation entry-point inventory below completes the source map. |
| Resource access | Canonical exposure checks cover metadata and bytes, with guest upload/message admission coverage. Version listing, version metadata, original version bytes and extracted version bytes now have real-workerd allowed/unshared/revoked coverage. Live artifact entry and viewer sessions now use canonical resource checks, with child-only entry and revoked-session coverage. Overlapping conversation exposure is now covered for version bytes and artifact sessions. Shared-site opening is now verified through the real guest HTTP route and a headed Chrome UI journey; the latter uses fixture API/site responses. End-to-end serving of a stateful site remains unverified. |
| Sidekick use and management | Exact-child summaries, local loads/removal, source audience checks and parent recommendation mutations exist. Parent grant admission/revocation and unrelated-source denial are covered in workerd. UI and agent catalog now use conversation-scoped recommendation options and canonical parent management access. Local removal and shared recommendation actions are separate; browser and desktop controls were inspected in real windows. AutomationService now resolves parent management from canonical grants; real appearance/pause/resume HTTP mutations succeed with a parent grant, and appearance changes fail after revocation. Detail and run-history routes now use the existing management actor; guest authoring socket admission and parent-grant revocation now pass through the existing queue fan-out in real workerd. |
| Existing substream context | Preserve current history, saved context and model-input behavior. The reproduced frozen Main-derived copy is part of the shared child, not a reason to introduce a new sharing workflow. Live Main access remains independently scoped. User decision recorded September 17. |
| Promotion | Administrator UI, incarnation/revision-fenced promotion, identity-preserving sessions and cross-tab/focus renewal exist. A real-workerd test now registers a browser cookie, accepts a second workstream invitation through the browser adapter, promotes the existing relationship, and verifies the same browser session plus both child grants survive while private Main access stays denied. The rendered local browser journey now preserves its draft and both workstreams after promotion, then closes the feed on membership removal. Promotion updates the workspace relationship in place; it does not replace the user ID or rewrite authored content. |
| Lite browser and SSR/SPA transport | Static HTML/React entry, cookie adapter, direct ticketed sockets and shared conversation core exist. Inspected Chromium flows cover child navigation, participant/resource controls, Sidekicks, composer and session lifecycle using fixture authority. Local real-backend entry, Main read, attachment upload, message persistence, reload and file preview now pass. The local journey additionally covers two workstreams, promotion, draft preservation and membership removal. Chrome is the requested browser verification target; Firefox/Safari testing is out of scope. |
| Revocation and compatibility | Canonical revisions, durable delivery, socket admission fences and incarnation-aware session revocation exist. Desktop discovery withholds guest workspaces until a scoped desktop shell exists. Final source audit confirms queued participant epochs, current authority at model/tool boundaries, durable socket revocation and native guest rejection; see the final audit below. |
| Validation and delivery | The full repository run before final refinements and rebase passed: 2,995 desktop tests, 3,055 API Node tests, all 1,023 workerd tests and the other package suites. The earlier three directory expectation failures are resolved in this full run. All 456 script tests passed separately; lint, typecheck, documentation and diff checks pass. Implementation is ready for PR review. Production rollout and external delivery checks are separate release tasks. |

## Release tasks outside this PR

- Configure the public browser origin/route, API service binding, email sender
  and `EMAIL_LOGIN_POLICY_JSON` before enabling production entry.
- Verify external mailbox delivery and a deployed stateful artifact using that
  production configuration. Local/runtime/Chrome evidence does not claim these.
- Merge and deployment are separate actions; this change is being prepared for
  review, not deployed.


The UI and agent catalog now share the parent's management decision and the
conversation-scoped eligible workspace source set. A child grant does not imply
permission to change a shared recommendation. Workstream-owned Sidekick authoring
and history now use canonical parent management admission, with HTTP, resource
and socket revocation evidence recorded below. These backend capabilities do not
add setup surfaces to the lite browser.

## Final queued-command and active-run audit

- `workstream-transcript-storage.ts` compares admission-time participant epochs
  with current rows and refuses to restore inactive participants after authority
  transfer. A queued message retains its recorded author and execution principal;
  delivery cannot turn an old mention into a new grant.
- `integrations.ts` calls current run admission before a run starts, before every
  new model step and before tool execution. Guest admission uses the exact parent
  conversation grant; Sidekick runs retain their existing run-lifecycle authority.
- Connector execution rechecks run/connection authority after credential refresh
  and before provider dispatch. Existing real-workerd coverage revokes access
  during refresh and observes no second provider write.
- Grant projections and membership/session revocation close admitted sockets and
  invalidate prepared admissions. No per-token remote authorization was added.
- An already-dispatched inference or external write may finish. Revocation blocks
  subsequent authorized work and guest delivery; it cannot undo an external write.
  Existing conversation context is deliberately preserved by the user's decision.

No additional code change was needed for this final source audit. The earlier
full repository run passed (2,995 desktop, 3,055 API Node and 1,023 workerd tests).
Subsequent attachment and browser-entry changes received scoped checks, builds,
Chrome inspection, lint and typecheck, as recorded above. Historical open items
about context choice, admission ownership and duplicate attachment checks are
resolved and are not additional implementation requirements.

Final packaging checks: API and browser Worker dry-run builds pass; the final
44-case message pipeline and five browser-entry component cases pass. No new
tests were added during this final audit.

## Validation scope

The full repository test run passed before the final small send/attachment and
invitation-navigation changes. Those changes received focused pipeline checks,
browser-entry checks, Chrome inspection, lint and typecheck. The final rebase
preserves main's eager activation, deferred directory delivery and cached mention
roster changes alongside guest admission. Its conflict-resolution checks passed: 45 pipeline, 34 scope-grant/creation
runtime, 40 Slack assignment and 82 client/browser-entry cases, both Worker
builds, lint and typecheck. The two rebase integration fixes updated test
fixtures for the creation-helper rename and directory-before-viewer delivery. No second browser engine was tested.

The final implementation inventory is in [implementation.md](implementation.md).
Its dated sections retain intermediate evidence as history, not outstanding tasks.
