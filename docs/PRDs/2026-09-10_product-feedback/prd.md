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
table, and the delivery path are shared. A third entry point later — the
Sidekicks library, an empty state, a failed run — costs a component and an enum
member.

A submission goes to Slack. A connector request posts into
`#connector-requests` and product feedback into `#user-feedback`, from the
internal app that already posts operator notices — the loop closes where the
team already works. Nothing about this feature puts feedback into Rally:
forwarding submissions into Juno Labs' own workspace for Sidekick triage is
rejected, and an operator page in Ace is deferred out of the first version. A
row is still written to regional D1 first, as a receipt rather than a surface,
so a failed Slack post cannot silently destroy what somebody typed
([decision 4a](#4a-the-d1-row-is-a-receipt-not-a-destination)).

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
8. **Feedback does not go into Rally.** No forwarding into Juno Labs' own
   workspace, no work stream, no Sidekick triage. *Rejected* — the loop closes
   in Slack. See [decision 4](#4-a-submission-goes-to-a-slack-channel).
9. **No operator page in Ace.** *Deferred* — the rows are queryable by SQL, and
   a browsable list is worth building when scrolling the channel stops
   answering the question. Its absence is what makes the EU question in
   [Regional impact](#regional-impact) live rather than academic.

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

The rejected option C would not have breached it either — the work streams
would have been in *Juno Labs'* workspace, not the submitter's — so nothing in
this document turns on the contract. It was declined as product direction.

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
and `EU_DB` bindings — so if the deferred operator page is ever built, it costs
a query rather than a new operator route per region.

*Rejected:* a table in the WorkspaceDO, which is right for anything a workspace
owns and wrong here — reading it would mean fanning out across every object in
both regions to answer "what did people ask for this week".

### 4. A submission goes to a Slack channel

**Decided: the destination is Slack, and only Slack.** A connector request posts
to `#connector-requests`; product feedback posts to `#user-feedback`. That is
where the loop closes — where somebody reads it, reacts to it, threads on it,
and decides what to do. Nothing about this feature creates a surface inside
Rally for the team to visit.

**Forwarding submissions into Juno Labs' own Rally workspace is rejected**, not
deferred. It was the most interesting option on paper — a Sidekick grouping the
fortieth Jira request with the first thirty-nine — and the product owner
declined it twice. That is the decision; the arguments below are recorded only
so a future reader knows it was weighed rather than overlooked. Reopening it is
a product direction to be argued fresh, not a backlog item waiting for volume.

What was considered:

| | Destination | Verdict |
| --- | --- | --- |
| **A** | An operator page in Ace, plus a content-free ping to Slack | The page is deferred; the Slack post became the destination. |
| **B** | The submission's text posted into a dedicated Slack channel | **Chosen.** |
| **C** | Forwarded into Juno Labs' own Rally workspace as a work stream | **Rejected** — the feedback loop lives in Slack. |
| **D** | A Linear issue per submission | Rejected — forty issues named "Jira". Filing one is a triage action taken with a count in hand. |

**It reuses the existing internal Slack app.** That app holds `chat:write`, and
`chat:write` posts to any channel the bot is a member of, so the two channels
cost an invite each rather than an installation. What it does *not* reuse is
`notifyOps` itself, for two reasons about the function rather than the app:

- **Its renderer is content-free by contract.** `OpsNotification.fields` is
  documented as codes, counts, and opaque ids only, and the operator channel is
  shared by both regions precisely because that holds. Member text does not go
  through it.
- **Its renderer would mangle the text anyway.** Every field is collapsed to one
  line and cut at 200 characters with a visible mark — correct for an error
  code, wrong for the paragraph that is the entire point of the submission.

So the change is a decomposition, not a new integration. `notifyOps` today mixes
one mechanism with one policy: posting a bounded `chat.postMessage` with the
token in a header, under a five-second deadline, escaped for `mrkdwn`, never
throwing, logging its own outcome — and, on top of that, the content-free
operator notice. Split them. The mechanism becomes
`postInternalSlackMessage(env, { channel, text })`, keeping the `APP_ENV` guard,
the deadline, the outcome rows, and `escapeMrkdwn` exactly as they are;
`notifyOps` becomes one policy over it, and feedback delivery a second, with its
own renderer — one that quotes the body as a block rather than a field — and its
own channel id per kind.

One coupling to accept knowingly: a single token now serves both alerting and
feedback, so rotating it or removing the app from the workspace breaks both. At
this size that is a cheaper trade than a second app to administer, and it is one
env var away from being undone.

### 4a. The D1 row is a receipt, not a destination

The submission is still written to regional D1 before the Slack post is
attempted. This is the one place this document keeps something the product owner
did not ask for, so it states the case plainly and makes it easy to cut.

**It is not a surface.** Nothing reads it back in Rally, no member sees it, and
the Ace page that would have made it browsable is deferred out of v1 along with
everything else Rally-side. It exists for one reason: a Slack post can fail —
`not_in_channel` after somebody archives a channel, `invalid_auth` after a token
rotation, a five-second deadline against a slow Slack — and without a row, a
member who was thanked by the dialog has had their message destroyed silently.
The failure is invisible from both ends: they believe it arrived, and nobody
here knows it did not.

It also answers the question the feature exists to answer. "Which connectors
have people asked for, and how many people asked" is a `GROUP BY` against a
table and a scroll-and-tally against a channel.

The cost is a migration and an insert. **Cutting it is a real option** — delete
the table and the service writes nothing — and the thing to weigh is whether
silently losing a member's message on a Slack failure is acceptable. This
document says it is not, and defers every other Rally-side piece instead.

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
| `triaged_at`, `triaged_by` | unused in v1; the columns the deferred Ace page would set |

A partial unique index on `(workspace_id, user_id, kind, subject)` where `kind =
'connector_request'` makes decision 5 the database's job rather than a query's.
Nothing is backfilled. [`data-model.md`](../../data-model.md) is updated in the
same change.

## Regional impact

This is the section that decides the shape of the feature, so read
[`regionalization.md`](../../regionalization.md) alongside it.

A submission is written to the D1 of the region its workspace is pinned to, and
stays there. The Slack post is the only thing that leaves — and because Juno
Labs' Slack is a single Global-side destination, posting an EU member's text
into it moves member-authored content out of the EU boundary.

Rally has been strict here by default: EU telemetry terminates in EU resources,
and EU acquisition intake returns 404 rather than falling back to Global. A
deliberate vendor-contact form is arguably a different thing from telemetry
about a member's data — the member is knowingly writing to Juno Labs — but
*arguably* is not a basis to ship it.

**Deferring the Ace page removed the cheap way around this**, and that trade
should be made with open eyes. The earlier draft had EU submissions post a
content-free pointer to the channel and be read in Ace, which needed no
residency decision at all. With no Ace page, a pointer points at nothing a
person can open.

Three ways to close it, in the order this document prefers them:

1. **Decide EU text may be posted.** One question to the product owner, one line
   of copy above the textarea before anybody types, and the renderer never
   branches. This is the honest shape of the feature: a member deliberately
   writing to their vendor, told where it goes.
2. **Ship Global-first.** The card and the menu item are absent in an EU
   workspace until the answer arrives. Nothing is collected that cannot be
   read, and nobody is thanked for a message no one will see.
3. **Collect EU submissions, post the pointer, read by query.** Keeps the
   feature universal at the cost of an engineer running SQL to read anything an
   EU member wrote. Workable at current EU volume; unpleasant, and the kind of
   unpleasant that quietly becomes nobody reading them.

What is *not* an option is posting an EU member's text without the decision in
(1) having been taken.

## Security and trust model

- **The text is untrusted and is member-authored.** Anywhere it is rendered —
  a Slack message, an Ace page, an email, a work-stream turn — it is escaped for
  that surface. The Slack case is specific: `mrkdwn` must be escaped so a
  submission cannot form a mention, a channel-wide ping, a link, or a line the
  reader takes for a field, which is the treatment `renderOpsNotification`
  already applies to its own values.
- **Options A and B add no credential.** Both post as the internal Slack app
  that is already configured; B adds channel ids, which are configuration rather
  than secrets. C and D each add exactly one credential, living as a Worker
  secret in the regions that use it, never behind a `VITE_` name and never in a
  URL — a token in a URL is exported on every outbound-fetch span, which is why
  the existing notifier refuses an incoming webhook and puts its token in a
  header. See [`security.md`](../../security.md#secrets) and
  [`ops-alerting.md`](../../ops-alerting.md).
- **Splitting `notifyOps` must not widen what the operator channel may carry.**
  The extracted mechanism takes a channel and a rendered string; the
  content-free rule stays in the operator policy above it, where its invariant
  is documented, so the split cannot quietly become a licence for an error path
  to post a message body.
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

Option B needs no new app: the existing internal Slack app is invited to
`#connector-requests` and `#user-feedback`, and their channel ids are set per
region beside the token that is already there. The bot must be invited to both
channels: without the invite Slack answers `not_in_channel`, which the existing
notifier already logs as a delivery failure rather than throwing.

Nothing else is needed. The change ships before the channels exist and stores
submissions without posting until the ids are set.

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
2. Delivery: the internal Slack post mechanism split out of `notifyOps`, a
   renderer that carries the body as a quoted block, and one channel id per
   kind.

That is the whole of it. An operator page in Ace and any Rally-side triage are
out of scope, and building either later is a new change against the rows this
one produces.

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
6. Both submissions appear in their channels — the connector request in
   `#connector-requests`, the feedback in `#user-feedback` — with the body
   readable as typed, and a submission whose text contains `<!channel>`, a
   link, and a newline renders as literal text rather than as markup, a ping,
   or an extra field.
7. Settings search for "request a connector" reveals the card.
8. Both screens are captured under Xvfb and read as images, per
   [`AGENTS.md`](../../../AGENTS.md#verifying-visible-changes) — a component
   test asserting on the DOM does not establish that the card is visible at the
   bottom of a long scrolling pane.

## Open questions

1. **May an EU member's text be posted into Juno Labs' Slack?** **This now
   blocks the EU half of phase 2**, and it is the one question the build cannot
   route around: Slack is the only destination, and Juno Labs' Slack is
   Global-side. [Regional impact](#regional-impact) sets out the three ways to
   close it and recommends simply deciding yes, with a line of copy above the
   textarea saying where the message goes. Phase 1 and the Global half of phase
   2 proceed either way.
2. **Does this ship behind a flag?** See [Rollout](#rollout). The answer is
   recorded there either way. Blocks nothing until the first entry point lands.
3. **What are the two opened numbers?** The per-member hourly submission ceiling
   and the deduplication window, per [decision 6](#6-the-limits-are-opened-not-guessed).
   The change ships with both open and hands the arithmetic back; a number is
   needed before the feature is considered finished, not before it is built.
