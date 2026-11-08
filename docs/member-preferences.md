# Member preferences

A member's preferences for one Organization, stored on the server so they
follow the member across devices. Two kinds today:

- **Show agent work** (Settings → Account → Agent), which decides whether the
  transcript shows the agent's thinking and its tool and plugin calls.
- **Channels per kind** (Settings → Notifications → Notify me about), which
  decide how each kind of Activity row reaches this person: push or email.
  How they are enforced is
  [`push-notifications.md`](push-notifications.md#what-each-person-chooses).
  The kinds offered are exactly those a producer records
  (`OFFERED_NOTIFICATION_KINDS`): **Mentions** (`mentions`), **New messages**
  (`newMessages`), **Being added** (`added`, which also covers being let into
  a Canvas you asked for), **Sidekick runs** (`runFinished`, both run
  notices), **Pinned Canvas updates** (`artifactUpdates`) and **Access
  requests** (`accessRequests`, for whoever decides on a Canvas's people).
  In the client, each kind's picker offers **Push** (only where this
  deployment can push, though a stored `push` stays in a save) and **Email**,
  the same two for every kind (`NotificationChannelSettings`); a stored
  `slack_agent_dm` is dropped by the contract's lenient channel list on read,
  so it is never drawn and a save of that kind never sends it back.

## Where the code lives

`apps/api/src/durable-objects/member-preferences.ts` holds the WorkspaceDO
migration. `MemberPreferencesSchema` in `@rally/contracts` is the shape, and
`lib/use-member-preferences.ts` is the renderer's read.

## How it works

1. **Storage.** The WorkspaceDO's `member_preferences` table has one row per
   member (migration 89). No row means every default. The channels are
   `notify_json` (migration 107), holding only the kinds the member has set; a
   kind not named reads from the push switch in `push_json` (migration 106)
   someone may have turned off before channels existed, then from
   `DEFAULT_NOTIFICATION_CHANNELS` (`storedMemberPreferences`), which is push
   alone for every kind. A channel this build does not know is dropped from a
   stored list as it is read; `slack_agent_dm`, no longer a channel, reads that
   way, so a stored Slack choice is read as absent and never consulted (and a
   save naming it is dropped the same way). `push` in the
   record is derived from the channels, for clients older than them. A kind
   newer than the push switches (`merges`) has no switch: it reads from its
   default until set, and `NotificationChannelsSchema` defaults it so a client
   reading an older server's record still parses. The Thread-era kinds
   `newThreads`, `newBreakouts` and `merges` have no producer: they are still
   accepted where a person stored them, and a save naming them still lands,
   but they are not offered and never consulted. `merges` is in the record
   only when stored. `newThreads` and `newBreakouts` are in it always, the
   stored value or the previous release's default (`PREVIOUS_RELEASE_DEFAULTS`),
   because a desktop of that release requires them to parse the record; this
   window closes once every desktop has updated, as the socket's `workstreams`
   page's did.
2. **First paint.** The WorkspaceDO's answer to a workspace socket `subscribe`
   carries `viewerPreferences` beside `featureFlags`. The renderer writes it to
   `['member-preferences', workspaceId]`, so the first frame already honours it
   without a separate read. Before the socket answers, the renderer paints the
   last value this device saw for that Organization (`localStorage`), so a cold
   launch does not flash the defaults. Applying the socket's answer cancels any
   REST read still in flight, so an older answer cannot land on top of it.
3. **Change.** `PUT /workspace/me/preferences` carries only what changed: each
   field, each kind's channel list and each push switch is optional, and
   whatever a save leaves out keeps its stored value
   (`MemberPreferencesUpdateSchema`, `savedNotify`). A kind named replaces that
   kind's list whole; a push switch from an older client adds or removes `push`
   on its kind.
   Each control sends its own field through `useSaveMemberPreferences`, so a
   window holding a stale copy cannot write it back over a change made on
   another device, and a desktop that predates the push switches, which saves
   `showAgentWork` alone, leaves them as they were. An empty save is refused. The
   write publishes `viewer_preferences` to the member alone, and their other
   windows refetch. The settings switch updates the cache optimistically and
   puts it back if the write fails.
4. **Use.** With agent work off, `withoutAgentWork` drops the agent's thinking
   rows, its `tool_event` rows and its timed `plugin_activity` rows before the
   transcript is grouped. Counted `plugin_activity` rows are messages between
   agents, not calls, and stay: each carries its turn's attention ordinal, and
   hiding it would leave the conversation unread with nothing to read. Rows that ask the
   reader to act stay: connecting an account and authorizing a resource.

## Invariants

- **A preference never hides something the member must act on.** Without the
  connection and authorization cards, the agent would wait on a request nobody
  can see.
- **The run's own timer stays.** The response's `working` row is the live
  "Rally is working" indicator and, once settled, the "Worked for" total.
  Without it a long run shows nothing between the question and the answer,
  because the bottom activity slot defers to the feed once the transcript owns
  the run's timing.
- **Display only.** Nothing here changes what the agent does or what the server
  stores in the transcript.
- **Guests keep the defaults.** The REST routes are under the members-only
  `/workspace` mount, so the renderer does not ask on a guest's behalf.

## Boundary

Human replies have their own `newMessages` delivery setting, defaulting to push
independently of explicit mentions and Rally completions.

The desktop and browser renderers honour the preference. A new
display preference is a column in `member_preferences`, a field in
`MemberPreferencesSchema` with a default, and a setting definition. A new kind
is a value in `NotificationKindSchema` and `OFFERED_NOTIFICATION_KINDS`
with a default in `DEFAULT_NOTIFICATION_CHANNELS` and the push kinds that
read it in `NOTIFICATION_KIND_FOR_PUSH`; it needs no migration. A push kind
with no entry there is allowed on no channel. A new channel is a value in
`NotificationChannelSchema` and a sink
([`push-notifications.md`](push-notifications.md#sinks)); nothing here changes.

## Failure modes and limits

Before the socket answers or REST returns, the defaults render. A server that
predates the field sends no `viewerPreferences`, which also reads as defaults.

## Testing

`apps/api/test/member-preferences-kinds.test.ts` covers the record's kinds
(the offered six defaulted, a stored Thread-era kind kept and never read) and
which choice each pushed kind reads;
`member-preferences-previous-release.test.ts` that the record parses under
the previous release's schema.
`apps/api/test-workers/member-push-preferences-migration.test.ts` covers
migrations 106 and 107 over populated rows.

## Changelog

### 2026-11-08 — Slack is no longer a notification channel

**What changed:** `NotificationChannelSchema` is `push` and `email`. A stored
`slack_agent_dm` is dropped as the list is read, so it reads as absent and is
never consulted; the mention and add defaults are push alone (they were push
and Slack). `chosenChannels` reads a person's choice for a kind from the
object's own row, for a producer queueing its notice. `access_denied` reads
**Access requests**.

**Why:** The owner's answer of 2026-11-08: "Remove Slack but email should
support all notifications". Dropping an unknown channel on read was already
the stored list's rule, so no migration rewrites stored rows, and a desktop of
the previous release, whose list is lenient too, parses the record.

**Considered and rejected:** Defaulting email on for mentions and adds in
Slack's place: it would start mailing everyone who never chose it; that is a
product call left to the owner.

**What a future change must respect:** a channel removed from the schema is
read as absent, never as an error.

### 2026-11-08 — Settings offers only kinds a producer records, and Access requests joins them

**What changed:** `NotificationKindSchema` gains `accessRequests` (default
push); `OFFERED_NOTIFICATION_KINDS` names the six Settings offers. `newThreads`,
`newBreakouts` and `merges` are optional in `NotificationChannelsSchema` and
absent from `DEFAULT_NOTIFICATION_CHANNELS`; the server still emits
`newThreads` and `newBreakouts` in the record, stored or `["push"]`, for one
release, for a person with no stored row too (the no-row read first returned
the bare defaults, so that desktop failed to parse exactly the people who had
never opened Settings). `NOTIFICATION_KIND_FOR_PUSH` drops `thread_started`,
`breakout_started` and `merged`, and maps `access_request` to
`accessRequests` and `access_granted` to `added`. [Client half: the Settings
rows, folded in at merge.]

**Client:** Settings → Notifications offers Push and Email for every kind
and nothing else: the connector-surface options, the unlinked Slack row and
the "connected messaging apps" footnote are gone, and a stored Slack choice is
neither drawn nor saved back. The owner's instruction of 2026-11-08: "Remove
Slack but email should support all notifications".

**Why:** The owner asked on 2026-11-08 that Settings offer only kinds real
producers create, and that every offered one create Activity and push.
**New messages** and **Pinned artifact updates** were offered with no
producer; now each has one, and access requests are a new kind a decider may
want to route on its own. Being let into a Canvas is being added, so it reads
that choice rather than a seventh row.

**Considered and rejected:** Deleting the three Thread-era kinds from the
schema: a stored record naming them, and an older client's save of them,
would then be refused or stripped mid-release; one release of accepting them
costs nothing. Leaving `newThreads` and `newBreakouts` out of the record
unless stored: the previous release's desktop requires both, so its whole
preferences record would fail to parse (the one-release compatibility rule
wins over "not defaulted").

**Consequences:** The two emitted kinds are a compatibility window: remove
`PREVIOUS_RELEASE_DEFAULTS` once every desktop has updated; nothing reads
them. Guard: `member-preferences-previous-release.test.ts` parses the
emitted record with the previous release's schema, copied verbatim from
d0cab03. A later release can drop the three kinds once no stored record
matters.

### 2026-10-15 — Channels per kind replace the push switches

**What changed:** The record carries `notify`, a channel list for each of five
kinds, stored as `notify_json` (migration 107) with only the kinds a member set.
`push` is now derived from it for older clients, and a push switch they save
still lands, as `push` added to or removed from its kind.

**Why:** A kind can now go by email or Slack as well as push, and a switch per
channel per kind would have been fifteen booleans and a column for each new
connector.

**Considered and rejected:** Converting `push_json` into `notify_json` in the
migration: an object migration rewriting every row on wake, when reading the
old switch for a kind nobody has set yet gives the same answer.

**Consequences:** A save of a kind replaces its whole list, so a client must
send the list it means, including a channel it does not show.

### 2026-10-14 — Push switches join the record, and a save merges them

**What changed:** The record carries seven push switches, all on by default,
stored as `push_json`. A save carries only what changed, down to one switch,
and everything it leaves out keeps its stored value.

**Why:** Pushing every Activity row made new threads and Rally's finishes
noisy in a busy Organization, and people need to choose what reaches their
devices, on every device at once.

**Considered and rejected:** Replacing the whole record on save, as before:
every shipped desktop saves `showAgentWork` alone, and would turn every push
switch back on; and any window with a stale copy would undo a change made on
another device. A column per switch: seven columns and a migration for each
switch added later, against one JSON column whose absent keys read as on.

**Consequences:** Saves must stay partial. A control sends only its own field;
sending the whole cached record reopens the stale-copy overwrite.

### 2026-10-05 — Show agent work, stored per member per Organization

**What changed:** Members can hide the agent's thinking and its tool and plugin
calls from their transcripts. The WorkspaceDO stores the choice, and the socket's subscribe
answer delivers it.

**Why:** Some members want the conversation without the agent's working steps,
and they want that choice on every device.

**Considered and rejected:**
- A local app setting, like `debugEnabled`. It would not follow the member to
  another device or to the browser.
- Reading it over REST before drawing the transcript. That costs a request
  before first paint, which the socket answer already avoids for feature flags.

**Consequences:** Any new display preference should join this record rather
than add a parallel channel. iOS still shows the agent's work until it reads
the field.
