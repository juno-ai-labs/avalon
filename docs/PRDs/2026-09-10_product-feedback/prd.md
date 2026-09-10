# Feedback submissions

> Created 2026-09-10.
>
> One primitive — a feedback submission — behind two buttons: **Request a
> connector** at the foot of Settings › Connections, and **Leave feedback** in
> the account menu. Companion: [state.md](state.md).
> Standing contract: [the Rally implementation
> brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

A member who scrolls to the bottom of Settings › Connections without finding the
tool they need types its name and what they would use it for, and sends it. A
member anywhere in Rally clicks their name and chooses **Leave feedback**, types
a paragraph, and sends it. Both land in the same place: one row in their own
region's D1, written before anything else is attempted, acknowledged inline
without leaving the screen.

The two buttons are one feature. What differs between them is a `kind`, the
prompt copy, and where the button sits; the dialog, the contract, the route, the
table, and whatever delivery is chosen are shared. A third entry point later —
the Sidekicks library, an empty state, a failed run — costs a component and an
enum member.

What is *not* settled by this document is where a submission goes after it is
saved. [Key design decisions](#key-design-decisions) lays out four destinations
with what each costs and what it forecloses, and recommends one; **Open
questions** carries the choice.

## Motivation

Rally asks every new member to connect their tools — it is a named stage of
guided onboarding — and the catalogue they are shown is finite: Google, GitHub,
Granola, Linear, Slack, Notion, X, a custom MCP server, and an inbound webhook.
A member whose team runs on Jira, Zendesk, Airtable, HubSpot, or Confluence
reaches the end of that grid, finds nothing, and has no way to say so from
inside the product. There is no in-product feedback path anywhere in the desktop
client today — not in Settings, not in the account menu, not on any empty state.
The only channels are a call, an email to somebody they already know, or
silence, and at this stage silence is the common case.

The cost of leaving it alone is that the connector roadmap stays ordered by
whoever spoke most recently in a sales call, while the strongest demand signal
available — a person who went looking for a specific connector and did not find
it — is discarded at the exact moment it is expressed. The same is true of
product feedback generally: the reaction to a screen is worth most in the
seconds after someone has it.

**No support thread, incident, or measurement is cited here, because none was
supplied.** This was requested by the product owner on 2026-09-10 on the
structural argument above. That is worth stating plainly rather than dressing
up: the feature's first job is to *produce* the evidence this section could not
cite, which is also why the count of submissions per connector matters more than
any individual one.

## Goals

1. A member can request a connector from the place they discovered it was
   missing, without leaving the Settings window and without being an admin.
2. A member can send unstructured feedback from any screen, in two clicks from
   their own name.
3. Every submission is durably recorded before any delivery is attempted, so a
   Slack outage, a mail failure, or a deploy cannot lose one.
4. Someone at Juno Labs learns that a submission exists without polling
   anything, and can read its contents through an existing operator surface.
5. A submission carries enough context to act on — who, which workspace, which
   region, which surface, which app version — without carrying anything the
   member did not deliberately type.
6. Adding a third entry point costs one component and one enum member: no new
   route, table, contract, or delivery path.
7. Nothing a member types crosses the region boundary their workspace is pinned
   to, unless the product owner decides otherwise and the form's own copy says
   so before they type.

## Non-goals

1. **No reply, thread, or status back to the member.** The dialog thanks them
   and closes. *Deferred* — a reply path is a second surface with its own
   notification and read-state problems, and it is worth building only once
   there is enough volume to answer.
2. **No screenshots or attachments.** *Deferred* — it needs R2, a size limit, and
   an answer to what happens when someone captures a screen containing another
   customer's data.
3. **No public tally, roadmap, or "also requested by 12 people".** *Rejected for
   v1* — showing a count is a commitment to keeping it accurate and to a
   ranking, and we have neither the volume nor the intent yet.
4. **Not a support desk, and not a bug tracker.** *Rejected outright.* No
   response time is implied and the copy must not imply one. A member reporting
   a broken run still needs the existing paths.
5. **No Linear issue per submission.** *Rejected as an intake path* — forty
   "add Notion" requests become forty issues. Filing an issue is a triage
   action taken afterwards by a person or a Sidekick, not an ingestion rule.
6. **Not anonymous.** Every submission carries its member and workspace.
   *Rejected* — anonymity makes follow-up impossible and abuse free, and the
   member is already authenticated.
7. **This adds no connector and changes no catalogue.** A request is a request.

## Product behavior

### The primitive

A **feedback submission** is one member-authored message to Juno Labs, carrying:

- a `kind` — `connector_request` or `product_feedback` today;
- an optional `subject` — for a connector request, the tool's name;
- a `body` — what they typed;
- a closed, bounded `context` — the surface it was sent from, the app version,
  the platform, and the workspace's region. No free text, no screen contents.

Everything below is that one object with different copy around it.

### Request a connector (Settings › Connections)

At the foot of the connections pane, after the provider grid and before the
authorization status line, a card in the same visual family as a provider card:

> **Not seeing the tool you need?**
> Tell us what to build next. We read every one.
> [ Request a connector ]

Choosing it expands the card in place — no modal, because the member is already
in a settings pane and a dialog over a settings window reads as an error:

- **Which tool?** — single line, required. Placeholder `Jira`.
- **What would you use it for?** — multi-line, optional but asked for
  explicitly, because "Jira" alone does not tell us whether they mean reading
  issues, filing them, or watching a board.
- **Send request** / **Cancel**.

States:

- **Empty** — Send is disabled until *Which tool?* is non-empty after trimming.
- **Sending** — the buttons disable and Send shows the spinner used elsewhere in
  the pane; the fields stay readable and are not cleared.
- **Sent** — the form collapses back to the card, which now reads *Thanks — your
  request for **Jira** is with us.* and offers **Request another**. The
  acknowledgement is inline and persists for the life of the window; there is no
  toast.
- **Already sent** — a member who sends the same tool name again within the
  deduplication window gets the same acknowledgement, not an error. They are not
  told it was a duplicate; it costs them nothing and telling them invites
  arguing with the matcher.
- **Error** — an inline error in the pane's existing `InlineError`, with the
  typed text preserved and Send re-enabled. Nothing typed is ever lost to a
  failed request.
- **Offline** — the same error path, with the same text preserved. A submission
  is never queued locally for later delivery: a queue that outlives the window
  is a durability promise this feature does not need to make.

Two things this card must *not* do. It must not appear as a per-provider action
on an existing card — "request Notion" when Notion is right there is confusing.
And it must be distinct from the existing **Unavailable** state, which means a
connector Rally has built is not configured in this region: that is an
operational fault, not a product request, and the card's copy must not invite a
member to file the second when they hit the first.

The card is visible to every member regardless of role, and regardless of the
connection filter. It is not registered as a connector and does not appear in
the provider count.

### Leave feedback (account menu)

In the account menu that opens from the member's own name — the one carrying
**Sidekicks**, **Settings…**, and **Sign out** — a new item above **Settings…**:

> 💬 Leave feedback

It appears in both presentations of that menu. Choosing it opens the shared
`Modal`:

- Title **Leave feedback**, description *Tell us what is working, what is not,
  or what you wish Rally did. It goes straight to the team.*
- One multi-line field, required, focused on open.
- **Send** / **Cancel**.

States mirror the card: disabled Send while empty, spinner while sending, the
dialog replaced by a short *Thanks — we have it.* and a **Done** button on
success, an inline error with the text preserved on failure. Closing the dialog
with unsent text asks nothing and keeps the text for the life of the window, so
a mis-click does not cost a paragraph.

### What both record

Alongside what the member typed, and never instead of it: the submitting
member's id, their workspace, the region, the `surface` the submission came
from as a bounded enum (`settings_connections`, `account_menu`), the desktop
version and platform, and the server's receipt time. That set is what makes a
submission actionable — a connector request from a two-person trial workspace
and one from the largest account are not the same request.

### Searchability

The connector request registers in the settings registry as an `action` in the
`connections` section, so a member who types "request", "missing", or "jira"
into settings search is taken to it. This is the registry's whole purpose and
skipping it is how a control becomes unfindable; see
[`settings-search.md`](../../settings-search.md).

## Impact on the product contract

None. Rally's contract concerns work streams, participation, and the deliberate
absence of channels, a global inbox, and global search; a form that sends a
message to Juno Labs is not a conversation surface in the product and creates no
new place for members to talk to each other.

One clause is worth naming because a chosen destination could brush it. If
submissions are forwarded into Juno Labs' own Rally workspace
([option C](#4-where-a-submission-goes-next)), the work streams created are in
*Juno Labs'* workspace, not the submitter's. No member sees a work stream they
did not create, and no workspace gains a participant. The contract holds.

## Decision log

None yet.

## Key design decisions

### 1. One primitive, two buttons — not two features

A "request a connector" form and a "leave feedback" form differ in their copy
and in nothing else: same authenticated member, same free text, same
destination, same durability requirement. Built as two features they get two
tables, two routes, and two answers to the residency question, and the second
one to be written will quietly disagree with the first.

So: one `kind` column, one route, one table, one delivery path, and one
`FeedbackDialog` component parameterized by kind, prompt copy, and surface. The
test is Goal 6 — a third entry point should cost an enum member. *Rejected:* a
generic `submissions` table with an untyped JSON payload, which buys the same
reuse by giving up the ability to query "every connector request, grouped by
tool".

### 2. Persist before delivering, always

The submission is written to D1 and the response returned before any Slack post,
mail, or forward is attempted. Delivery outcome is a column on the row, updated
after.

This is the private-access invariant, and it was written from the same failure:
*"D1 persistence precedes provider I/O; otherwise a mail failure loses the
lead."* A feedback path that posts to Slack and stores nothing has no record
when Slack is unreachable, and no way to answer "what did people ask for in
August" three months later. *Rejected:* fire-and-forget to Slack with no row,
which is a third of the code and loses exactly the data the feature exists to
collect.

### 3. Regional D1, not the WorkspaceDO

A submission is correspondence with the vendor, not workspace data: no member
reads it back, no work stream references it, and it must be readable by staff
across every workspace at once. Regional D1 is where cross-workspace,
staff-readable rows already live, and Ace already holds read-only `GLOBAL_DB`
and `EU_DB` bindings, so a staff-facing list costs a query rather than a new
operator route per region.

*Rejected:* a table in the WorkspaceDO, which is right for anything a workspace
owns and wrong here — reading it would mean fanning out across every object in
both regions to answer "what did people ask for this week".

### 4. Where a submission goes next

This is the open choice. All four options share sections 2 and 3 above — the row
is written regardless — and differ only in what happens afterwards.

| | Destination | New infrastructure | EU submissions | Cost |
| --- | --- | --- | --- | --- |
| **A** | Ace page + content-free ping to the existing operator Slack channel | none | identical treatment | small |
| **B** | A dedicated internal Slack channel carrying the text | one Slack app, two secrets per region | needs a residency decision | medium |
| **C** | Forwarded into Juno Labs' own Rally workspace as a work stream | one address or webhook, held as a secret | needs a residency decision | medium |
| **D** | A Linear issue per submission | one Linear credential | needs a residency decision | medium |

**Option A — Ace, plus a pointer in the operator channel.** The row is written;
`notifyOps` posts `feedback_submitted` with `region`, `kind`, `workspace_id`,
and the submission id — *codes, counts, and opaque ids only*, which is the
existing invariant of that channel and the reason it can be shared by both
regions. A new **Feedback** page in Ace lists both regions from the bindings it
already has, filters by kind, searches server-side, and marks a submission
triaged. Nothing a member typed leaves its region; no new secret, no new app, no
residency decision. The cost is a click: the channel says *something arrived*,
and Ace says what it was.

**Option B — a dedicated Slack channel carrying the text.** Feedback lands where
the team already is, can be reacted to and threaded, and needs no second
surface to read. It must not reuse `notifyOps`: that notifier's invariant is
explicitly that a notice never carries a message body, a person's name, or a
workspace name, and it exists because the operator channel is shared across
regions and is the thing that reports on Slack being broken. So this is a
*second* internal Slack app with its own token, channel, and renderer — and a
renderer that escapes `mrkdwn` properly, because the text is member-authored and
must not be able to form a `@channel`, a link, or a convincing extra field.

**Option C — forward it into Rally.** The submission becomes a turn in a work
stream in Juno Labs' own Rally workspace, where a Sidekick reads it: groups the
fortieth Jira request with the first thirty-nine, keeps a running tally, drafts
a reply for a human to send, and files the Linear issue when the count justifies
one. This is the highest-leverage option and the one that most obviously belongs
to this product, and it needs no new ingress — Rally already has two primitives
that accept outside content into a work stream: every automation holds a
permanent address on `automation.rallywith.ai`, and the generic inbound webhook
connector accepts signed posts. Either is configuration held as a Worker
secret, not architecture. Its risk is that it is the option whose failure is
quietest: a forward that silently stops leaves submissions accumulating in D1
that nobody is reading, which is why it wants A's Ace page underneath it either
way.

**Option D — a Linear issue each.** Direct to the backlog, with no second
surface. It is the wrong shape for intake: connector requests are inherently
repetitive, and forty issues named "Jira" is worse than no issues. Filing one
belongs downstream of triage, as a thing a person or a Sidekick does with a
count in hand. Recorded here as considered and rejected as an intake path.

**Recommendation: A now, C next.** A is the durable half and it is nearly free —
the storage and the Ace page are needed under every other option, `notifyOps`
already exists and needs no secret, and it makes no residency decision, which
means it cannot make the *wrong* residency decision. C is then a second change
that adds a forward for the regions whose content is allowed to move, and it
gets to be a genuine dogfooding story rather than a plumbing exercise. B is a
subset of C's value that costs a new Slack app; D is a triage action.
[Open questions](#open-questions) carries the decision.

### 5. Deduplication is per member, per kind, per subject

A member who sends "Jira" three times in a week has told us one thing, and three
rows would make the count that matters — how many *people* want Jira —
unreliable. The first row stands, its `created_at` unchanged; a repeat within
the window updates a counter and returns the same acknowledgement. This is the
shape private-access already uses for repeated email requests, and it is why
that table has a unique normalized column rather than a de-duplicating query.

Free-text `product_feedback` is not deduplicated: two paragraphs from the same
person are two pieces of feedback.

### 6. The limits are opened, not guessed

Per [`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md),
this change defines the guards and sets each to its open value, and the team
picks the numbers:

| Limit | Definition site | Open value |
| --- | --- | --- |
| `FEEDBACK_BODY_MAX_CHARS` | the contract schema | no cap |
| `FEEDBACK_SUBJECT_MAX_CHARS` | the contract schema | no cap |
| `FEEDBACK_SUBMISSIONS_PER_MEMBER_PER_HOUR` | the route | unlimited |
| `FEEDBACK_DEDUPE_WINDOW` | the service | forever (first row always wins) |

Two of these are not defensive at all and have an owner already: the character
counter shown under the textarea is a *product* limit, visible in the interface,
and the product contract sets it; whatever cap D1 or the Workers request body
imposes is a *platform* limit, transcribed with its citation. The remaining two
are the team's to set, with the arithmetic handed back in the implementing
change's report.

## Data model

One new table per region, `feedback_submissions`, in migration `0104`:

| Column | Notes |
| --- | --- |
| `id` | branded submission id, per [`branded-ids.md`](../../branded-ids.md) |
| `workspace_id`, `user_id` | the submitting member and their workspace |
| `kind` | `connector_request` \| `product_feedback` |
| `subject` | the requested tool, normalized for dedupe; null for feedback |
| `body` | what the member typed |
| `surface` | bounded enum: `settings_connections`, `account_menu` |
| `app_version`, `platform` | from the desktop client |
| `repeat_count` | incremented by a deduplicated resend |
| `created_at`, `updated_at` | server clock |
| `delivery_state`, `delivered_at` | the outcome of whatever destination is chosen; `pending` until then |
| `triaged_at`, `triaged_by` | set from Ace |

A partial unique index on `(workspace_id, user_id, kind, subject)` where `kind =
'connector_request'` makes decision 5 the database's job rather than a query's.
Nothing is backfilled. [`data-model.md`](../../data-model.md) is updated in the
same change.

## Regional impact

This is the section that decides the shape of the feature, so read
[`regionalization.md`](../../regionalization.md) alongside it.

A submission is written to the D1 of the region its workspace is pinned to. Ace
reads both through the read-only bindings it already holds, so a staff list
spanning both regions involves no cross-region movement of content: the query
runs against each region's own database and only the answer reaches the
operator's browser, which is exactly what the existing directory search does.

Under option A nothing else crosses. The `notifyOps` payload is ids and codes,
which is what lets one channel serve both regions.

Under B, C, or D, the destination is a single Global-side thing — a Slack
workspace, Juno Labs' Rally workspace, a Linear team — and forwarding an EU
member's text to it moves member-authored content out of the EU boundary. Rally
has been strict here by default: EU telemetry terminates in EU resources, and EU
acquisition intake returns 404 rather than falling back to Global. A deliberate
vendor-contact form is arguably a different thing from telemetry about a
member's data — the member is knowingly writing to Juno Labs — but *arguably* is
not a basis to ship it. So: **either EU submissions stay in EU and are read in
Ace only, or the product owner decides they may be forwarded and the form says
so above the textarea before anyone types.** The second is a real option; it is
not one this document takes.

## Security and trust model

- **The text is untrusted and is member-authored.** Anywhere it is rendered —
  a Slack message, an Ace page, an email, a work-stream turn — it is escaped for
  that surface. The Slack case is specific: `mrkdwn` must be escaped so a
  submission cannot form a mention, a channel-wide ping, a link, or a line the
  reader takes for a field, which is the treatment `renderOpsNotification`
  already applies to its own values.
- **No new secret is required by option A.** B, C, and D each add exactly one
  credential, which lives as a Worker secret in the regions that use it, never
  as a `VITE_` name and never in a URL — a token in a URL is exported on every
  outbound-fetch span. See [`security.md`](../../security.md#secrets) and the
  same invariant in [`ops-alerting.md`](../../ops-alerting.md).
- **Absent configuration is a supported state.** A region with no destination
  configured still accepts and stores submissions; delivery answers `skipped`.
  Nothing about a Slack setting may take an intake route offline.
- **The route is member-authenticated**, not public, and not admin-gated.
  Rate limiting is the guard against a member submitting in a loop; its number
  is opened per decision 6.
- **Telemetry carries no content.** Two events per the two-event rule —
  `feedback_submitted_requested` from the renderer and `feedback_submitted_completed`
  from the API, correlated by one `operationId` — with `kind`, `surface`, and a
  bounded result class as their only properties. The subject and body are
  product data in Rally's own database, and they never become event properties;
  see [`adding-new-instrumented-event.md`](../../adding-new-instrumented-event.md).

## Provider configuration

Option A needs none — `OPS_SLACK_BOT_TOKEN` and `OPS_SLACK_CHANNEL_ID` are
already configured where they are configured, and a region without them answers
`skipped` as it does today.

Option B needs a second internal Slack app with `chat:write` and nothing else,
installed once, invited to one channel, with its token and channel id set per
region. Option C needs either the target work stream's permanent address or a
generic-webhook URL and signing secret from Juno Labs' own Rally workspace.
Option D needs a Linear API credential and a target team. In each case the
change ships before the secret exists and does nothing until it is set.

## Rollout

**Whether this ships behind a flag is an open question for the product owner**
and is recorded here either way before the first implementing change (see
[Open questions](#open-questions)). The honest default for a change this size is
*no flag*: it is additive, it is two buttons, it has no migration to sequence,
and turning it off is reverting one pull request. If the answer is yes, the flag
is `feedback-submissions-enabled`, it defaults off for everyone, every audience
is reached by a targeting rule, and it is registered in Ace in the same change
that introduces it — a flag served from the Worker but absent from Ace is a
feature nobody can enable, per [`feature-flags.md`](../../feature-flags.md).

Suggested sequencing, which a `plan.md` will carry once this PRD is approved:

1. The primitive — contract, migration, route, service, both entry points,
   inline acknowledgement, settings-registry entry, telemetry. Submissions are
   stored and readable by SQL only.
2. Ace's Feedback page across both regions, and the content-free operator ping.
3. Whichever destination the product owner chooses, for the regions whose
   content may reach it.

## Acceptance

1. From Settings › Connections, a non-admin member sends a connector request and
   sees the inline acknowledgement without the pane navigating or a toast
   appearing; the row is in that region's D1 with the right workspace, member,
   surface, and version.
2. The same member sends the same tool name again and sees the same
   acknowledgement; there is still one row, with `repeat_count` at 2.
3. From the account menu, in both presentations, a member sends feedback and
   sees the dialog's success state; a second row exists with kind
   `product_feedback` and surface `account_menu`.
4. With the API refusing the request, the typed text survives, an inline error
   appears, and Send works again once the API recovers.
5. With no destination configured, both submissions still store and return
   success.
6. An operator opens Ace's Feedback page and sees both submissions, from both
   regions, newest first, filterable by kind.
7. Settings search for "request a connector" reveals the card.
8. Both screens are captured under Xvfb and read as images, per
   [`AGENTS.md`](../../../AGENTS.md#verifying-visible-changes) — a component
   test asserting on the DOM does not establish that the card is visible at the
   bottom of a long scrolling pane.

## Open questions

1. **Where does a submission go after it is stored?** The four options are in
   [decision 4](#4-where-a-submission-goes-next); the recommendation is A now, C
   next. **Blocks phase 3 only** — phases 1 and 2 are identical under every
   option, so the build can start before this is answered.
2. **May an EU member's text be forwarded out of the EU?** Only relevant under
   B, C, or D. A "no" is not a blocker: EU submissions are then read in Ace,
   which is where the answer already is. A "yes" adds a line of copy above the
   textarea, shown before anyone types. Blocks phase 3 for EU only.
3. **Does this ship behind a flag?** See [Rollout](#rollout). The answer is
   recorded there either way. Blocks nothing until the first entry point lands.
4. **What are the two opened numbers?** The per-member hourly submission ceiling
   and the deduplication window, per [decision 6](#6-the-limits-are-opened-not-guessed).
   The change ships with both open and hands the arithmetic back; a number is
   needed before the feature is considered finished, not before it is built.
