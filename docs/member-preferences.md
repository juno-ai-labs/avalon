# Member preferences

A member's display preferences for one Organization, stored on the server so
they follow the member across devices. Today there is one: **Show agent work**
(Settings → Account → Agent), which decides whether the transcript shows the
agent's thinking and its tool and plugin calls.

## Where the code lives

`apps/api/src/durable-objects/member-preferences.ts` holds the WorkspaceDO
migration. `MemberPreferencesSchema` in `@rally/contracts` is the shape, and
`lib/use-member-preferences.ts` is the renderer's read.

## How it works

1. **Storage.** The WorkspaceDO's `member_preferences` table has one row per
   member (migration 89). No row means every default.
2. **First paint.** The WorkspaceDO's answer to a workspace socket `subscribe`
   carries `viewerPreferences` beside `featureFlags`. The renderer writes it to
   `['member-preferences', workspaceId]`, so the first frame already honours it
   without a separate read. Before the socket answers, the renderer paints the
   last value this device saw for that Organization (`localStorage`), so a cold
   launch does not flash the defaults. Applying the socket's answer cancels any
   REST read still in flight, so an older answer cannot land on top of it.
3. **Change.** `PUT /workspace/me/preferences` replaces the whole record. The
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

The desktop and browser renderers honour the preference. iOS does not yet. A new
preference is a column in `member_preferences`, a field in
`MemberPreferencesSchema` with a default, and a setting definition.

## Failure modes and limits

Before the socket answers or REST returns, the defaults render. A server that
predates the field sends no `viewerPreferences`, which also reads as defaults.

## Changelog

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
