# What each connector activity type declares for a digest

One row per declared activity type, for every connector Rally registers. The
rule these answer to, and the contract that makes stating them mandatory, is in
[`connectors.md`](connectors.md#declaring-what-a-digest-may-read).

**Nothing reads these answers today.** The digest they were written for is
retired, and no connector event writes an Activity row or records the answer
any more. The manifests still declare every type and this table still
has to match them; they are kept for a future surface that tells somebody about
connector activity, so read "digest" below as that surface.

This is a reference appendix to [`connectors.md`](connectors.md), not a second
document about connectors: that document owns the contract, the rule, and the
changelog entry for any change to either, and this file holds only the table
that would swamp it. A change to what a connector declares is recorded there.

**The manifests are authoritative.** This document is a reference for reviewing
the judgement in one place — if the two disagree, the manifest is right and this
file is stale. `digestibility-doc.test.ts` fails on exactly that, so a new
activity type has to land here as well as in its manifest; the test checks the
rows, not the reasons, because a reason that has stopped being the real reason
is a review problem rather than a build one.

The question each row answers is **would a person who was away for a day want
this read back to them?** A digestible type is news. An operational type is
still verified or polled, normalized, routed, and matched against automations
and watches — it would just never interrupt anybody on a schedule. Most of what a provider emits is operational, and that is the normal
case rather than a failure.

## Ashby

| Activity type | Digestible? | Why |
| --- | --- | --- |
| `applicationSubmit` | No | Recruiting trigger evidence for explicitly bound automations; not general workspace digest news. |
| `candidateStageChange` | No | Application progression is operational recruiting data, not a workspace-wide announcement. |

## Canva

Both types are digestible under Rally's ordinary visibility rules. Personal watch
events target their connection owner; there is no additional Canva recipient gate.

| Activity type | Digestible? | Why |
| --- | --- | --- |
| `design.revised` | Yes | An explicitly watched design changed since the previous observation. |
| `design.commented` | Yes | A new thread or reply appeared on an explicitly watched design. |

## GitHub

Thirty of eighty-seven. The loudest connector Rally has: continuous integration
reports two events per check and three per workflow run, so ingress keeps only a
workflow run's completion and discards the rest before it is stored.

| Activity type | Digestible | Reason |
| --- | --- | --- |
| `github.pull_request.opened` | Yes | Work put up for review. |
| `github.pull_request.merged` | Yes | Work landed — the single most digest-worthy GitHub event. |
| `github.pull_request.closed` | Yes | Work abandoned or landed; either way the thread ended. |
| `github.pull_request.reopened` | Yes | Work that had ended is alive again. |
| `github.pull_request.ready_for_review` | Yes | The moment a draft starts asking for someone's time. |
| `github.pull_request.review_requested` | Yes | Somebody is being asked for something by name. |
| `github.pull_request.assigned` | Yes | Ownership landed on a person. |
| `github.pull_request_review.submitted` | Yes | A judgement on somebody's work. |
| `github.pull_request_review.dismissed` | Yes | An approval that no longer counts, which changes what happens next. |
| `github.pull_request_review_comment.created` | Yes | Line-level discussion; where review actually happens. |
| `github.pull_request_comment.created` | Yes | Discussion on the pull request itself. |
| `github.issue.opened` | Yes | Something was reported or proposed. |
| `github.issue.closed` | Yes | Something was resolved or dropped. |
| `github.issue.reopened` | Yes | A resolution that did not hold. |
| `github.issue.assigned` | Yes | Ownership landed on a person. |
| `github.issue.transferred` | Yes | The issue now lives in another repository; whoever was following it needs telling. |
| `github.issue.deleted` | Yes | The issue is gone, and a link to it will not explain why. |
| `github.issue_comment.created` | Yes | Discussion on an issue. |
| `github.release.published` | Yes | Shipped, visibly. |
| `github.release.released` | Yes | Shipped, marked as the current release. |
| `github.release.created` | Yes | A release exists; the draft stage is still worth knowing about. |
| `github.release.prereleased` | Yes | Shipped to whoever tracks prereleases. |
| `github.release.deleted` | Yes | A release people may be running is gone. |
| `github.release.unpublished` | Yes | Same, by another name. |
| `github.repository.created` | Yes | A new place work can happen. |
| `github.repository.deleted` | Yes | Work's home is gone. |
| `github.repository.transferred` | Yes | Ownership of a whole repository moved. |
| `github.repository.archived` | Yes | The repository stopped accepting work. |
| `github.repository.publicized` | Yes | Visibility change with real consequences. |
| `github.repository.privatized` | Yes | Same, in the other direction. |
| `github.push` | No | Fires for every branch, so on a repository that reviews its work it is the commits the pull request already reported, counted twice. |
| `github.pull_request.synchronize` | No | The same commits again, seen from the pull request's side. |
| `github.workflow_run.completed` | No | A workflow finished, the one CI event kept. Check runs and a run starting are discarded at ingress. |
| `github.pull_request.edited` | No | The description changed after the reader was already told it exists. |
| `github.pull_request.converted_to_draft` | No | Withdrawn from review; the return trip is `ready_for_review`. |
| `github.pull_request.review_request_removed` | No | An ask that was never acted on being tidied up. |
| `github.pull_request.unassigned` | No | The removal half of a pairing whose arrival was digestible. |
| `github.pull_request.labeled` | No | Triage vocabulary. |
| `github.pull_request.unlabeled` | No | Triage vocabulary. |
| `github.pull_request.locked` | No | Moderation. |
| `github.pull_request.unlocked` | No | Moderation. |
| `github.pull_request.milestoned` | No | Planning metadata. |
| `github.pull_request.demilestoned` | No | Planning metadata. |
| `github.pull_request.auto_merge_enabled` | No | A setting; the merge itself is digestible. |
| `github.pull_request.auto_merge_disabled` | No | A setting. |
| `github.pull_request.enqueued` | No | Merge-queue position. |
| `github.pull_request.dequeued` | No | Merge-queue position. |
| `github.pull_request.stacked` | No | Merge-queue position. |
| `github.pull_request_review.edited` | No | A revision to a judgement already reported. |
| `github.pull_request_review_comment.edited` | No | A revision to a comment already reported. |
| `github.pull_request_review_comment.deleted` | No | A retraction; the digest is not a moderation log. |
| `github.pull_request_comment.edited` | No | A revision to a comment already reported. |
| `github.pull_request_comment.deleted` | No | A retraction. |
| `github.pull_request_comment.pinned` | No | Presentation. |
| `github.pull_request_comment.unpinned` | No | Presentation. |
| `github.issue.edited` | No | The description changed after the reader was told it exists. |
| `github.issue.pinned` | No | Presentation. |
| `github.issue.unpinned` | No | Presentation. |
| `github.issue.unassigned` | No | The removal half of a digestible pairing. |
| `github.issue.labeled` | No | Triage vocabulary. |
| `github.issue.unlabeled` | No | Triage vocabulary. |
| `github.issue.locked` | No | Moderation. |
| `github.issue.unlocked` | No | Moderation. |
| `github.issue.milestoned` | No | Planning metadata. |
| `github.issue.demilestoned` | No | Planning metadata. |
| `github.issue.field_added` | No | Project-field bookkeeping. |
| `github.issue.field_removed` | No | Project-field bookkeeping. |
| `github.issue.typed` | No | Project-field bookkeeping. |
| `github.issue.untyped` | No | Project-field bookkeeping. |
| `github.issue_comment.edited` | No | A revision to a comment already reported. |
| `github.issue_comment.deleted` | No | A retraction. |
| `github.issue_comment.pinned` | No | Presentation. |
| `github.issue_comment.unpinned` | No | Presentation. |
| `github.issue_dependencies.blocked_by_added` | No | Graph bookkeeping between issues already reported. |
| `github.issue_dependencies.blocked_by_removed` | No | Graph bookkeeping. |
| `github.issue_dependencies.blocking_added` | No | Graph bookkeeping. |
| `github.issue_dependencies.blocking_removed` | No | Graph bookkeeping. |
| `github.sub_issues.parent_issue_added` | No | Graph bookkeeping. |
| `github.sub_issues.parent_issue_removed` | No | Graph bookkeeping. |
| `github.sub_issues.sub_issue_added` | No | Graph bookkeeping. |
| `github.sub_issues.sub_issue_removed` | No | Graph bookkeeping. |
| `github.release.edited` | No | Notes revised after the release was reported. |
| `github.repository.edited` | No | Settings and description. |
| `github.repository.renamed` | No | The same repository under a new name. |
| `github.repository.unarchived` | No | Reversal of an administrative state. |
| `github.installation_repositories.added` | No | Which repositories Rally can see — configuration, not somebody's work. |
| `github.installation_repositories.removed` | No | Same. |

## Linear

Eighteen of fifty-six. Linear's `update` events are where the judgement sits: an
issue moving state is the substance of a Linear workspace, while a document or
comment being edited is the same thing said again a minute later.

| Activity type | Digestible | Reason |
| --- | --- | --- |
| `linear.issue.create` | Yes | Work was proposed. |
| `linear.issue.update` | Yes | State transitions are the substance of a Linear workspace. |
| `linear.issue.remove` | Yes | Work that people were tracking is gone. |
| `linear.comment.create` | Yes | Discussion. |
| `linear.project.create` | Yes | A new body of work. |
| `linear.project.update` | Yes | A project's state, dates, or lead changed. |
| `linear.project.remove` | Yes | A body of work was cancelled. |
| `linear.project_update.create` | Yes | The written status update — the most digest-shaped thing Linear has. |
| `linear.cycle.create` | Yes | A sprint started; it frames the next fortnight. |
| `linear.document.create` | Yes | Somebody wrote something. |
| `linear.initiative.create` | Yes | Strategy-level work exists. |
| `linear.initiative.update` | Yes | Strategy-level work changed. |
| `linear.initiative.remove` | Yes | Strategy-level work was dropped. |
| `linear.initiative_update.create` | Yes | The written status update at initiative level. |
| `linear.customer_need.create` | Yes | A customer asked for something. |
| `linear.release.create` | Yes | A release exists. |
| `linear.release_note.create` | Yes | What shipped, described. |
| `linear.app_user_notification.create` | Yes | Linear's own decision that this person needed telling — an assignment, a mention, a review request. |
| `linear.comment.update` | No | A revision to a comment already reported. |
| `linear.comment.remove` | No | A retraction. |
| `linear.attachment.create` | No | Automatic linking between Linear and other systems. |
| `linear.attachment.update` | No | Same. |
| `linear.attachment.remove` | No | Same. |
| `linear.issue_label.create` | No | The label vocabulary itself, not its use. |
| `linear.issue_label.update` | No | Same. |
| `linear.issue_label.remove` | No | Same. |
| `linear.reaction.create` | No | An emoji. |
| `linear.reaction.remove` | No | An emoji, removed. |
| `linear.project_update.update` | No | A revision to a status update already reported. |
| `linear.project_update.remove` | No | A retraction. |
| `linear.project_label.create` | No | Label vocabulary. |
| `linear.project_label.update` | No | Label vocabulary. |
| `linear.project_label.remove` | No | Label vocabulary. |
| `linear.cycle.update` | No | Fires continuously as issue counts and progress recompute. |
| `linear.cycle.remove` | No | Planning bookkeeping. |
| `linear.document.update` | No | Autosave; a document written over an afternoon is dozens of these. |
| `linear.document.remove` | No | A deletion the document's own link will explain. |
| `linear.user.create` | No | Directory sync. |
| `linear.user.update` | No | Directory sync. |
| `linear.user.remove` | No | Directory sync. |
| `linear.initiative_update.update` | No | A revision to an update already reported. |
| `linear.initiative_update.remove` | No | A retraction. |
| `linear.customer.create` | No | Customer-record sync, not somebody's work. |
| `linear.customer.update` | No | Same. |
| `linear.customer.remove` | No | Same. |
| `linear.customer_need.update` | No | A revision to a need already reported. |
| `linear.customer_need.remove` | No | A retraction. |
| `linear.release.update` | No | Metadata on a release already reported. |
| `linear.release.remove` | No | Planning bookkeeping. |
| `linear.release_note.update` | No | A revision to notes already reported. |
| `linear.release_note.remove` | No | A retraction. |
| `linear.oauth_app.revoked` | No | Surfaced on the connection, where it can be acted on. |
| `linear.oauth_authorization.revoked` | No | Same. |
| `linear.permission_change.team_access_changed` | No | Access administration. |
| `linear.agent_session_event.created` | No | Rally's own agent working; a digest must never narrate the machinery that writes it. |
| `linear.agent_session_event.prompted` | No | Same. |

## Slack

Five of twelve. What somebody said, and what was addressed to this person.

| Activity type | Digestible | Reason |
| --- | --- | --- |
| `slack.message.posted` | Yes | Somebody said something in a channel. |
| `slack.message.replied` | Yes | A thread moved. |
| `slack.app_mention.received` | Yes | Addressed to Rally by name. |
| `slack.direct_message.received` | Yes | Addressed to this person directly. |
| `slack.file.shared` | Yes | Something was handed over. |
| `slack.message.edited` | No | A revision to a message already reported. |
| `slack.message.deleted` | No | A retraction. |
| `slack.reaction.added` | No | An emoji. |
| `slack.reaction.removed` | No | An emoji, removed. |
| `slack.channel.created` | No | A container, before anything has been said in it. |
| `slack.member.joined_channel` | No | How a channel breathes, not what happened in it. |
| `slack.member.left_channel` | No | Same. |

## Notion

Four of thirty-one. Notion fires `content_updated` on every save, so a page
written over an afternoon is one piece of news and dozens of events.

| Activity type | Digestible | Reason |
| --- | --- | --- |
| `notion.page.created` | Yes | Somebody started writing something. |
| `notion.page.deleted` | Yes | A page people may be linking to is gone. |
| `notion.database.created` | Yes | A new structure for other people's work. |
| `notion.comment.created` | Yes | Discussion. |
| `notion.page.content_updated` | No | Every save. |
| `notion.page.properties_updated` | No | Property bookkeeping. |
| `notion.page.moved` | No | Reorganization. |
| `notion.page.locked` | No | Editing state. |
| `notion.page.unlocked` | No | Editing state. |
| `notion.page.undeleted` | No | Reversal of an administrative state. |
| `notion.page.transcription_block.transcript_deleted` | No | Block-level editing. |
| `notion.database.content_updated` | No | Every save. |
| `notion.database.schema_updated` | No | Structure, not content. |
| `notion.database.moved` | No | Reorganization. |
| `notion.database.deleted` | No | Reorganization; the page-level deletion is the one people notice. |
| `notion.database.undeleted` | No | Reversal of an administrative state. |
| `notion.data_source.created` | No | Wiring between Notion and its sources. |
| `notion.data_source.content_updated` | No | Same. |
| `notion.data_source.schema_updated` | No | Same. |
| `notion.data_source.moved` | No | Same. |
| `notion.data_source.deleted` | No | Same. |
| `notion.data_source.undeleted` | No | Same. |
| `notion.comment.updated` | No | A revision to a comment already reported. |
| `notion.comment.deleted` | No | A retraction. |
| `notion.file_upload.created` | No | Transfer machinery. |
| `notion.file_upload.completed` | No | Transfer machinery. |
| `notion.file_upload.expired` | No | Transfer machinery. |
| `notion.file_upload.upload_failed` | No | Transfer machinery. |
| `notion.view.created` | No | How a database is displayed. |
| `notion.view.updated` | No | How a database is displayed. |
| `notion.view.deleted` | No | How a database is displayed. |

## Google

Three of seven, and one of three polling streams withheld outright.

| Activity type | Digestible | Reason |
| --- | --- | --- |
| `email.received` | Yes | Mail arrived. |
| `calendar.event_changed` | Yes | A meeting was created, moved, or cancelled. |
| `calendar.event_completed` | Yes | A meeting happened, which is what a note or a follow-up hangs off. |
| `email.updated` | No | A label or read-state change on mail already seen. |
| `drive.file_changed` | No | A save. |
| `docs.document_changed` | No | A save. |
| `sheets.spreadsheet_changed` | No | A save. |

| Polling stream | Digestible | Reason |
| --- | --- | --- |
| `gmail` | Yes | Somebody's mail. |
| `calendar` | Yes | Somebody's day. |
| `drive` | No | A file watcher. Useful to an automation watching a document, never something to read back over breakfast — and a stream veto needs no matching edit to the manifest. |

## Granola

One of three.

| Activity type | Digestible | Reason |
| --- | --- | --- |
| `note.generated` | Yes | The meeting note was written for the first time; effectively "the meeting happened". |
| `note.edited` | No | A revision to a note already reported, including Granola regenerating its own earlier output. |
| `note.access_granted` | No | A permission change, not something that happened. When the shared note already has a summary, the ingress stores a `note.generated` beside it, and that one is digestible: from the workspace's side, that is when the meeting arrived. |

## Fireflies

One of two. Fireflies reports the same meeting twice, minutes apart, and only
the second report has anything written about it.

Worth stating plainly, because the Yes above promises more than the log
holds: a Fireflies webhook carries `{event, timestamp, meeting_id}` and
nothing else, so the activity has no title, no snippet and no link. The
overview and action items exist only behind a hydration, the same shape as
Granola. A surface that reads this row would have to hydrate it; that is a
change to the reader, not to this row.

| Activity type | Digestible | Reason |
| --- | --- | --- |
| `meeting.summarized` | Yes | The meeting arriving — the one of the two reports that means something was written about the call. |
| `meeting.transcribed` | No | The same meeting a few minutes earlier, with the words captured and nothing concluded from them. Digesting both would tell somebody about one call twice, and the later one is the useful half. |

## X

None of none. X is read-only through a shared account and ingests no activity at
all, so it declares two empty lists rather than omitting one — a connector that
later starts emitting activity has to state which kind it is then.

## Generic webhook

None of one.

| Activity type | Digestible | Reason |
| --- | --- | --- |
| `webhook.received` | No | Rally cannot know what a caller will post, and an unreadable payload rendered into somebody's morning email is worse than a missing line. A generic webhook earns a digest through an automation that understands it. |
