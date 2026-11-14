# Canvas notices

> Created 2026-11-14.
>
> Any agent working on a Canvas can tell the Canvas's participants that
> something happened, by push or email as each person chose. A Canvas turns
> notices on once, and the record of that in its Chat lets people join, mute,
> or grant their device permission. Each Sidekick works on one Canvas.
> Delivery is [`push-notifications.md`](../../push-notifications.md)'s, and
> this changes the attachment rule of
> [Sidekicks attached to Canvases](../2026-11-10_sidekicks-attached-to-canvases/prd.md).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

A newsletter Canvas turns each new newsletter into a podcast. When a podcast
is ready, the Sidekick doing the work tells everyone in the Canvas: "New
episode: Stratechery, November 14." It arrives on their Mac, iPhone or
browser, or by email, as each person chose, and opens the Canvas.

Before any agent can send, the Canvas turns notices on, with one sentence
saying what it will notify about. A record of that appears in the Canvas's
Chat. Everyone the Canvas lists as a participant gets notices from then on,
unless they mute it. Anyone else who can open the Canvas can join from the
record. When the device someone is reading on cannot show notifications, the
record says so and offers the fix.

To make "the Canvas" unambiguous, a Sidekick works on at most one Canvas. A
Canvas still has any number of Sidekicks.

## Motivation

Every notification Rally sends today is one the system decides on: a mention,
a reply, a run that finished, a pinned Canvas's new version. The agent, which
is the only party that knows when its output is news, has no way to tell
anyone. A Sidekick that turns newsletters into podcasts finishes its work and
nobody hears of it until they next open the Canvas. The nearest existing
notice, a pinned Canvas's new version, skips first versions, so a new
artifact tells nobody at all.

The owner raised it on 2026-11-14 with the newsletter example, and set the
shape in the same conversation: register a Canvas before sending, show a
record in the Chat, send from the Canvas to all participants, and no
recipients or artifact in the send. No support thread or usage number is
recorded.

A Sidekick today can be attached to several Canvases, and each run that
publishes without naming one makes a Canvas of its own. "Send from the
Canvas" has no single answer for such a Sidekick. The owner chose to fix the
model: one Canvas per Sidekick, many Sidekicks per Canvas, as part of this
work.

## Goals

1. An agent in a Canvas's Chat, one of its background agents, a Sidekick's
   wizard, or a Sidekick's run can send a notice with a title and a body. It
   names no recipient and no Canvas.
2. A notice reaches each of the Canvas's participants by the channels they
   chose, on every device they use, and opens the Canvas.
3. A Canvas sends nothing until notices are turned on for it, and turning
   them on leaves a record in its Chat that everyone who can open the Canvas
   sees.
4. From that record, a participant can mute the Canvas or pick its channels,
   a person who can open the Canvas without being listed can join it, and a
   person whose device cannot show notifications can fix that.
5. A person who never chose channels for Canvas notices gets push when they
   have a device that can receive it, and email when they do not.
6. Every Sidekick works on at most one Canvas, and its runs publish into that
   Canvas.

## Non-goals

1. **Choosing recipients or an artifact in the send.** Rejected, the owner's
   call. The model cannot narrow, widen or aim a notice; it always goes to the
   Canvas's participants and opens the Canvas.
2. **Muting one Sidekick on a Canvas.** Deferred. A person mutes the Canvas.
   Pick it up if one noisy Sidekick drives people to mute Canvases they want.
3. **A cooldown or rate limit on notices.** Rejected for now, the owner's
   call. A newer notice replaces the one on screen instead. If a Canvas floods
   people, the limit's number is the team's to set
   ([`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md)).
4. **Leaving a Canvas's participant list from the record.** Rejected, the
   owner's call: muting is enough.
5. **Moving a Sidekick to another Canvas.** Deferred. A Sidekick's Canvas is
   set once. Archive and remake the Sidekick to change it.
6. **Android push and Linux desktop push.** Deferred, as today. Those people
   get email by default (goal 5).
7. **Turning notices off for a Canvas as a whole.** Deferred. Registering
   again changes what the record says; nothing unregisters.

## Product behavior

### Turning notices on

An agent turns notices on for its Canvas with a sentence of purpose: "Tell you
when a new newsletter becomes a podcast." The Canvas's Chat shows the
**record**, a row drawn for everyone who can open the Canvas:

> 🔔 **This Canvas sends notices.** Tell you when a new newsletter becomes a
> podcast. Turned on by Newsletter podcaster.

Turned on in the Chat, it names Rally. Turned on by a Sidekick's wizard, it
names the Sidekick. The wizard's own conversation gets an ordinary reply
saying notices are on and linking to the Canvas. Turning them on again with
a new sentence adds a new record; earlier records stay as history and only
the newest shows controls.

The record is visible when a person hides the agent's tool rows, as a
Sidekick source request's card is
([`member-preferences.md`](../../member-preferences.md)).

### What the record offers, per viewer

| The viewer | Below the record |
| --- | --- |
| The creator, or on the participant list | "You get these by push" (or email, or both). **Change** opens the channel picker; **Mute this Canvas** turns them off. |
| Muted | "You muted this Canvas." **Turn on**. |
| Able to open the Canvas but not listed (Organization visibility, a writer Sidekick's audience, an owner or administrator) | **Get notifications**, which adds them to the participant list. |
| Guest | As a participant: a guest is only ever admitted from the list. |

Below that, for a viewer who gets notices by push, the device's own state:

| Device | State | Offer |
| --- | --- | --- |
| Mac | Notifications off in Rally | **Turn on** |
| Mac | Denied by macOS | **Open System Settings** |
| Browser | Not yet asked | **Allow** |
| Browser | Blocked for the site | How to unblock it |
| iPhone Safari tab | Needs the Home Screen app | How to add Rally to the Home Screen |
| iPhone app | Not yet asked | **Allow** |
| iPhone app | Off in system settings | **Open Settings** |
| Any | Ready, or push unavailable here (Linux, Android) | Nothing |

A person who gets notices only by email sees no device line.

### The title pill's menu

The Canvas's title pill menu gains **Notifications**, with the same controls
as the record: join, channels, mute. It is how someone who joins later, after
the record has scrolled away, finds them. Before notices are turned on the
item is absent.

### Sending

An agent sends a title and a body. Each recipient gets one notice:

- **Push:** the title, the body as plain text, the Canvas named as where it
  came from (and the Sidekick, when one sent it). Tapping it opens the Canvas.
  A newer notice from the same Canvas replaces the older one on screen.
- **Email:** the shared notice template, its subject naming the Canvas and the
  title, an **Open in Rally** button to the Canvas, and a line naming the
  Settings row that sent it.
- **Activity:** a row in the person's Activity feed, counted in the icon
  badge, as for every notice.

Recipients are the Canvas's creator and everyone on its participant list,
less anyone who muted it, anyone no longer an active member or guest, and
anyone the Canvas no longer admits. The person whose message started the
agent's turn is included.

### Settings

Settings → Notifications → **Notify me about** gains **Canvas notices**, with
push and email like every other row. Until a person picks, the row shows the
default as "Push when a device is set up, otherwise email". A Canvas's own
channel choice, from the record or the menu, overrides the row for that
Canvas.

### A Sidekick's one Canvas

- A Sidekick made in a Canvas's Chat, or through `POST /canvases/:id/sidekicks`,
  works on that Canvas, as today.
- A Sidekick made anywhere else has no Canvas until it needs one: its first
  run that publishes makes it, or its wizard turning notices on makes it.
  Every later run publishes into the same Canvas.
- A Sidekick's wizard can attach a Canvas only while the Sidekick has none.
- The Sidekick's card shows at most one Canvas pill.

### States

- **Loading:** the record renders from the transcript row; the viewer's line
  waits for the Canvas detail it already loads, and the device line for the
  device check, each without blocking the transcript.
- **Offline:** the record shows; join, mute and channel changes are disabled,
  as the Canvas's other writes are.
- **Error:** a join or mute that fails shows the error under the record and
  leaves the previous state.

Platforms: macOS, web, and the iPhone app, which shares the conversation UI.

## Impact on the product contract

Two clauses of the Canvases and Sidekicks contract move.

1. **"A Sidekick's output is a Canvas" narrows to "a Sidekick's output is its
   Canvas."** [Sidekicks attached to Canvases](../2026-11-10_sidekicks-attached-to-canvases/prd.md)
   widened a Sidekick's output from the Canvas each run makes to any Canvas it
   is attached to. This change makes it one. A Sidekick whose runs each made a
   daily Canvas now writes each day's output into one Canvas, as new artifacts
   or new versions.
2. **The agent may notify people.** Until now only system events notified
   anyone. An agent's notice goes only to people the Canvas already lists, by
   channels they control, so no one is reached who had not already joined the
   Canvas or been added to it.

Nothing else changes. The tool-execution policy holds: no tool call asks for
confirmation, and turning notices on asks nobody.

## Decision log

None yet.

## Key design decisions

1. **Turning notices on opts every participant in.** The owner's call. The
   alternative, a permission card each person must accept, makes the default
   silence, and a Canvas whose people never scroll to the card never notifies
   anyone. A person who did not want them mutes the Canvas.
2. **Notices go to explicit participants, and joining is a general Canvas
   action.** Organization visibility admits everyone in the Organization; sending to
   all of them would make an Organization-wide Canvas a broadcast list.
   `canvasJoin` adds a person who can already open the Canvas to its
   participant list (source `self`). It needs only `canvasAdmits`, so it
   cannot widen who opens the Canvas. A joined person stays in if a manager
   later narrows the Canvas, which the owner accepted.
3. **A manager's audience save sends what changed.** `canvasSetAudience`
   replaces the participant list with the one the sharing modal sends, so a
   save from a modal opened before someone joined drops them. The save becomes
   adds and removes against the current list. Without it, joining is
   unreliable on any Canvas a manager edits.
4. **The default channel is decided at send time.** A person with no saved
   choice gets push if they have a live push device, otherwise email. The
   intent is recorded in `WorkspaceDO` and the device registry is in regional
   D1, so the producer queues one message marked `default`, and the push
   consumer, which already reads the person's devices to send, picks push or
   email. A person who installs the iPhone app later switches to push without
   touching Settings. A device is live only while its OS permission holds (a
   Mac that loses permission unregisters), so "has push" means "can get push".
   This is the one place a notice moves from one channel to another, and only
   for an unsaved default; [`push-notifications.md`](../../push-notifications.md)'s
   "nothing falls back" stays true for every saved choice.
5. **A Canvas's choice overrides the Settings row, and stores only overrides.**
   A person with no row for a Canvas gets the Settings row's channels. Muting
   stores an empty list. Rejected: a per-Canvas row created for every
   participant on registration, which would need writing for everyone who
   joins later.
6. **The record is a post, not the tool's own row.** Registration appends the
   record to the Canvas's Chat through `appendConversationPost`, which does not
   wake the Chat's agent, whatever loop registered. A tool row would put the
   record in the wizard's conversation when the wizard registers, where the
   Canvas's people never look.
7. **One device check, shared by Settings and the record.** The Mac
   (`pushNotificationStatus`), browser (`webPushState`) and iPhone app
   (`permission` in `apps/mobile/src/notifications.ts`) each read their own
   state today, in Settings and in the mobile shell. They become one hook,
   `useDevicePushReadiness()`, returning the state and the action to offer, so
   Settings and the record cannot disagree. The iPhone app reaches its native
   check through the browser bridge.
8. **A Sidekick has at most one Canvas, made on first need.** Rejected:
   exactly one, made with the Sidekick, which would give every instruction-only
   Sidekick an empty Canvas in the sidebar. A Sidekick with no Canvas gets one
   when a run first publishes or its wizard turns notices on, with the
   Sidekick's name as its title and its audience as today's run Canvases have.
9. **A run publishes into its Sidekick's Canvas, with no `canvas` argument.**
   With one Canvas there is nothing to name. `publish_resource` drops the
   argument for runs, and `canvas_not_attached_to_sidekick` goes with it.
   Overlapping runs that republish one artifact can lose an update, as they can
   today on an attached Canvas; `ATTACHED CANVASES` already tells a run to
   write rows or rebuild from sources.
10. **Registration is open to loops content can start.** A Sidekick source
    request is offered only to turns a person drives, because it asks in a
    delegate's name. Registration asks nothing of anyone and reaches only
    people the Canvas already lists, who can mute it, so the owner allowed
    background agents too. Runs still cannot register: a run is handed an
    event's content, and turning notices on changes the Canvas for everyone.

## Data model

All in the Organization's `WorkspaceDO`. Implementers and reviewers read
[`durable-object-sqlite.md`](../../durable-object-sqlite.md) first.

- **`canvas_notice_registrations`**: `canvas_id` (primary key), `purpose`,
  `registered_by_kind` (`canvas` or `sidekick`), `registered_by_id`,
  `record_message_id`, `registered_at`, `updated_at`.
- **`canvas_notification_choices`**: `canvas_id`, `user_id`, `channels_json`
  (an empty list is muted), `updated_at`; primary key `(canvas_id, user_id)`.
  Rows exist only for people who changed the default.
- **`canvas_participants.source`** gains `self` in its CHECK.
- **`workstream_notification_intents.notification_kind`** gains
  `canvas_notice` in its CHECK, as migration 138 did for run notices. The
  intent's `source_message_id` is the send's receipt id.
- **`member_preferences`**: `NotificationKindSchema` and
  `OFFERED_NOTIFICATION_KINDS` gain `canvasNotices`, whose absence means the
  send-time default.
- **`sidekick_conversation_attachments`** gains a unique index on
  `automation_id`. The migration keeps one row per Sidekick, in this order:
  the `made_here` row; else the newest row a wizard attached; else the newest
  Canvas a run made. It deletes the rest. A detached Canvas stays a Canvas
  with its audience (`writer_sidekick_id` is untouched); runs stop writing it.

## Regional impact

None. Every row is in the Organization's `WorkspaceDO`. The default-channel
decision reads the regional D1 device registry the push consumer already
reads.

## Security and trust model

- **The model controls only words.** It cannot name a recipient, a Canvas or
  a link. Recipients come from the Canvas's participant list, and every notice
  links to the Canvas's canonical link, so a notice cannot send a person to a
  URL a model wrote.
- **Content can write a notice.** A run started by an email can put that
  email's words in a notice's title and body, sent to everyone in the Canvas.
  Push and email render the text as plain text, and the link is fixed, which
  bounds what such text can do. Muting is the person's remedy; non-goal 3 is
  the team's.
- **Joining cannot widen access.** `canvasJoin` requires that the Canvas
  already admits the person. It persists access across a later narrowing,
  which the owner accepted (decision 2).
- **Access is checked at delivery.** `renderNotice` checks each recipient
  again when the message is sent, so a person removed between send and
  delivery gets nothing.
- **A run's reach follows the run.** A run a schedule or an event started
  sends from its Sidekick's Canvas by the attachment alone. A run a person
  asked for sends only if that person can still open the Canvas, as its
  publish does today.

## Agent behavior

### Plugin contract

- **Canonical id** `rally:notifications`, model id `rally_notifications`,
  wire prefix `notifications_`. The prefix stays because the local names are
  bare verbs ([`agent-tools.md`](../../agent-tools.md#the-shape-of-a-tool)).
- **Preloaded** for every loop that has a Canvas: a Canvas's Chat and its
  background agents, a Sidekick's wizard, and a Sidekick's runs. Loading reads
  nothing and authorizes nothing; each call resolves the Canvas.
- **Which Canvas** is always the host's: the loop's own Canvas for a Chat or
  its background agent, the Sidekick's Canvas for a wizard or a run.
- **Tool order:** `notifications_register`, `notifications_send`.
  `notifications_register` is offered to a Chat, a background agent and a
  wizard; never to a run.
- **System-prompt guidance:**

  > Notices reach everyone in this Canvas on their phone, computer or email.
  > Send one when something finished that a person would want to know about
  > while away: a new episode, a report, a result. Do not send one for
  > progress, for a step inside a larger task, or to say you are working.
  > One notice per outcome. If notices are not on and you can turn them on,
  > turn them on only when a person asked to be notified, or when the Canvas
  > exists to tell people about new things.

### Tool catalog

| Tool | Description (model-facing) | Capability | Mode | Idempotency | Timeout | Serial |
| --- | --- | --- | --- | --- | --- | --- |
| `notifications_register` | Turn on notices for this Canvas, so agents can tell its participants when something happens. Say in one sentence what it will notify about; that sentence is shown to everyone in the Canvas. Calling again replaces the sentence. | `rally.notifications.register` | `write` | `record_before_execute`, reenterable (resolves by the receipt's `effectIntentId`) | default | yes |
| `notifications_send` | Tell everyone in this Canvas that something happened. They get it on their devices or by email, and it opens the Canvas. Notices must be on (`notifications_register`). | `rally.notifications.send` | `write` | `record_before_execute`, reenterable (the intent's source id is the receipt id) | default | yes |

### Wire shapes

`notifications_register`, strict, unknown fields rejected:

```json
{ "purpose": "Tell you when a new newsletter becomes a podcast." }
```

- `purpose`: required string, trimmed, at least one character. Shown as
  written in the record, and as plain text.

Success:

```json
{ "canvasId": "…", "purpose": "…", "changed": true, "recordMessageId": "…" }
```

`changed` is `false` when the Canvas was already registered with the same
sentence; no new record is added.

`notifications_send`, strict, unknown fields rejected:

```json
{ "title": "New episode: Stratechery, November 14", "body": "A 12-minute episode from this morning's issue." }
```

- `title`: required string, trimmed, at least one character.
- `body`: required string, trimmed, at least one character.

Neither field gets a new length cap. The push sink already fits the body to
1,000 code points and Apple's 4,096 bytes, and the email sink quotes 320
characters.

Success:

```json
{ "canvasId": "…", "noticeId": "…", "recipients": 4 }
```

`recipients` counts the people queued, after mutes; delivery is
asynchronous. A replay returns the first call's output.

### Discovery and sequencing

No id comes from the model. A typical sequence in a Canvas's Chat: a person
asks to be told about new episodes; the agent calls `notifications_register`;
later a run calls `notifications_send` after `publish_resource` succeeds.

### Failures

| Code | Tool | Model-visible error | Next action |
| --- | --- | --- | --- |
| `canvas_notices_not_registered` | send | "Notices are not on for this Canvas. Turn them on with notifications_register, then send again." (A run is told instead: "Notices are not on for this Canvas, and a run cannot turn them on. Continue without sending a notice.") | Register, or stop |
| `canvas_archived` | both | "This Canvas is archived, so it cannot send notices. Continue without sending a notice." | Stop |
| `canvas_access_denied` | both | "The person this run acts for can no longer open this Canvas, so no notice was sent." | Stop |
| `canvas_notices_empty_field` | both | "`<field>` is empty. Write it and call again." | Correct and retry |

A wizard whose Sidekick has no Canvas does not fail: registering makes it
(decision 8). A send that finds no recipients after mutes succeeds with
`recipients: 0`.

### Model-usability acceptance

Schema snapshot and contract tests cover both tools' required, forbidden and
success shapes. Evaluations on the medium fallback model cover: registering
when asked, not registering unasked in an ordinary Chat, sending once after a
publish, not sending progress notices, and a run stopping on
`canvas_notices_not_registered` instead of retrying.

## Rollout

Ships to everyone on merge, with no flag. Order:

1. One Canvas per Sidekick: the attachment migration, the `publish_resource`
   change, the wizard's attach rule, the card's single pill.
2. `canvasJoin`, the change-based audience save, and `useDevicePushReadiness()`.
3. The plugin, the record, the menu item, the Settings row and delivery.

The attachment migration deletes rows, so step 1 is reversible only by
restoring from a Durable Object point-in-time recovery; it moves no artifacts
and archives no Canvas.

## Acceptance

1. In a Canvas's Chat, ask to be told about new podcasts. The record appears
   for everyone in the Canvas, with controls per viewer.
2. With notifications off on a Mac, a browser and the iPhone app in turn, the
   record offers each fix, and the fix works.
3. A Sidekick run sends a notice. It arrives by push on a Mac, a browser and
   an iPhone; on a person with no push device it arrives by email; it appears
   in Activity; tapping it opens the Canvas.
4. A member of an Organization-wide Canvas who is not listed gets nothing,
   joins from the record, and gets the next notice.
5. A muted participant gets nothing; turning the Canvas back on restores it.
6. A manager opens the sharing modal, someone joins, the manager saves, and
   the person who joined is still listed.
7. A Sidekick made from the Sidekicks section publishes twice in two runs, and
   both land in one Canvas.

## Open questions

1. **Is the migration's pick order right** for Sidekicks with several
   Canvases today (`made_here`, then the newest wizard attachment, then the
   newest run Canvas)? A different order changes which Canvas each existing
   Sidekick keeps writing.
