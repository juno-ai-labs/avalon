# Member preferences

A member's preferences for one Organization, stored on the server so they
follow the member across devices. Two kinds today:

- **Show agent work** (Settings → Account → Agent), which decides whether the
  transcript shows the agent's thinking and its tool and plugin calls.
- **Channels per kind** (Settings → Notifications → Notify me about), which
  decide how each kind of Activity row reaches this person: push, email, or a
  connector surface such as Slack. How they are enforced is
  [`push-notifications.md`](push-notifications.md#what-each-person-chooses).

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
   `DEFAULT_NOTIFICATION_CHANNELS` (`storedMemberPreferences`). `push` in the
   record is derived from the channels, for clients older than them. A kind
   newer than the push switches (`merges`) has no switch: it reads from its
   default until set, and `NotificationChannelsSchema` defaults it so a client
   reading an older server's record still parses.
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
is a value in `NotificationKindSchema` with a default in
`DEFAULT_NOTIFICATION_CHANNELS` and an entry in `NOTIFICATION_KIND_FOR_PUSH`;
it needs no migration. A new channel needs no change here at all.

## Failure modes and limits

Before the socket answers or REST returns, the defaults render. A server that
predates the field sends no `viewerPreferences`, which also reads as defaults.

## Changelog

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
