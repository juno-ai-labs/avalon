# Spike: can a demo workspace be seeded and reset on Rally's real object hierarchy?

> Companion research for [the demo workspace PRD](prd.md). This is the spike
> report from 2026-09-04, preserved as the evidence that PRD cites, with screenshot
> assets and links removed. It records an investigation; it is not itself a proposal.
>
> The spike branches are throwaway and are not merged, so the code described
> below exists only on `spike/demo-workspace-replay-main` at `87e73ef`. The
> report is copied into this folder so the PRD's evidence outlives them.
>
> **Where the PRD departs from it.** The recorded connector plugin rows and
> their observed durations — §1 and the visual observations in §6 — were how the
> spike proved that real tool dispatch survives seeding. The PRD rejects them
> (non-goal 4): a demo's assistant prose names the connectors it consulted and
> carries no tool receipts at all, because stale tool names become misleading
> context on a continued turn. Read those observations as evidence of a capability,
> not as the intended demo.

**Branches:** `spike/demo-workspace-replay` (original, Rally 1.269.0) and
`spike/demo-workspace-replay-main` (ported and re-run on Rally 1.271.0 — **read §0 first**).
Throwaway. Not for merge; no pull request.
**Ran against:** a live local stack — two regional Workers under `pnpm dev:api:local`,
real Durable Objects, real D1, real Queues, `pnpm db:open-authority` applied.
**Driver:** `node scripts/spike-demo-replay.mjs`, which seeds W1, verifies it, answers
its open question, retires it, seeds W2, verifies it, waits, and re-verifies.

The question this was built to answer: **if we ship a demo workspace we can reset
between presentations, does the reset actually hold on Rally's real
`WorkspaceDO → WorkstreamDO → SubstreamAgent` hierarchy, or does the old workspace keep
leaking into the new one?**

Short answer: **it holds, and it is cheaper than it looks — but "retire the old one and
make a new one" is the only version that works today, and even that leaves one loose end.**

Every fact below was produced by calling Rally's own production write paths, as the
persona who did it, and read back through ordinary product routes — the workspace
directory, work-stream detail, the canonical transcript snapshot, and the home-screen
attention payload. No `POST /dev/seed-product`, no `seedFromFixture`, no
`seedDevelopmentRun`, no `seedDevelopmentReceipt`, no `seedDevelopmentConversationTurn`,
and no SQLite read anywhere in the verification.

---

## 0. Re-verified against `main` (Rally 1.271.0) — read this first

The original run was against `main` at 1.269.0. `#550` ("Rebuild automations on
substreams under a shared conversation parent") then **replaced both propagation hops
with Cloudflare Queues**. The spike has been ported to current `main` on branch
`spike/demo-workspace-replay-main` and re-run end to end. What changed:

| | 1.269.0 (original run) | 1.271.0 (`main` today) |
| --- | --- | --- |
| Child → parent → workspace | direct RPC | **Cloudflare Queue, both hops** |
| `flushEffectsToWorkstreamDO`, `flushWorkspaceDirectoryEffects`, `hasWorkstreamDirectory` | existed; create called all three | **deleted** |
| Synchronous guarantee at create | full projection delivered | **`reserveChild` only** — the parent row and a *provisional* directory row |
| Everything else in the pack | — | unchanged and still passes |

**§3's "propagation barrier — free" is therefore stale, and must not be quoted into the
PRD as written.** The corrected version is below, and it is still good news.

### The barrier is now a read, not a push

`reserveChild` runs *before* the child is initialized and writes the provisional
directory row into `WorkspaceDO` synchronously. So:

- **Existence** is guaranteed by the time `POST /workstreams` returns. Nothing to force.
- **Content** — the message, the activity, and critically **the viewer projection** —
  is eventually consistent through the Queue.

Measured: immediately after seeding, the presenter saw **2 of 3 rooms** and
`{waitingForYou: 0}`. 150 seconds later, the same reads returned **3 rooms**,
`youAreMentioned: true`, `unseen: true`, `{waitingForYou: 1, waitingReason: "mentioned"}`
— exactly the state the old synchronous path produced. **Nothing was lost; it was late.**

The seeder's barrier is therefore: after seeding, poll the workspace's own directory as
each viewer until it reflects the seed. That needs no new object method, and it is the
honest shape — a demo that opens the sidebar one second after a reset would otherwise
show a half-populated workspace.

### Retirement on `main`: still holds, by a different mechanism

| Check | Result on `main` |
| --- | --- |
| Alarms after retirement | `alarmAt: null` and `storedAlarms: 0` on the workspace, all three parents, all three children |
| The residual `product:workspace` alarm from the original run | **did not reproduce** — the retired workspace stayed at zero |
| Object write into a retired room | `409 workspace_retired` |
| The presenter's session | `401 session_revoked` |
| Directory `last_activity_at` after a straggler and a 20 s settle | byte-identical before and after |
| W2 after the seed and a 150 s wait | 3 rooms, correct recency order, correct attention — nothing from W1 |

**One new observation, and it changes what the fence is for.** After retirement, one
`WorkstreamDO` was left holding `pendingOutbox: 3` — three effects that will never be
delivered, because retirement cleared the alarm that would have drained them.

Under RPC, an in-flight effect *arrived* at the retired workspace and had to be dropped.
Under Queues it never leaves the retired object at all. So on `main`:

- **Clearing the alarms is the load-bearing guard.** It is what makes the reset hold.
- **The `WorkspaceDO` drop-fence is now belt-and-braces**, for the narrower window where
  an effect was already handed to the Queue before retirement. It was never exercised in
  this run (`droppedEffects: {directory: 0, regional: 0}`), which is a *weaker* result
  than the original run, not a stronger one — it means the fence is currently unproven
  on `main`.
- **The residue is inert but permanent.** Nothing leaks, nothing costs anything (no
  alarms), but three rows sit in a dead object's outbox forever. Acceptable for a demo;
  worth a deliberate decision rather than an accident.

Everything below this section is the original 1.269.0 report, unchanged except where it
is marked. Its findings on backdating, on which production paths refuse a seeded write,
and on the shape of retirement all still hold.

---

### A demo pack can be built entirely out of production write paths

Three work streams were created through `WorkstreamObjectCreationService` (the
`POST /workstreams` coordinator), their messages admitted through `SubstreamAgent`'s
`create_message`, a document created through `ResourceService.upload` and attached
through `attach_resource`, and every assistant turn produced by an ordinary harness run.
Six persona members, none of whom can ever sign in, took part as themselves.

**Verified through `GET /workstreams`, `GET /workstreams/:id` and
`GET /workspace/attention`:**

| Check | Result |
| --- | --- |
| Three work streams in the directory, correct recency order | `Northgate renewal` → `onboarding emails` → `decision memo` |
| Human turns carry historical instants | Decision memo's opening turn at `03:37:29Z`, seeded at `06:37` — 3h before, exactly as the pack specifies. The renewal room's six human turns land at `06:07 / 06:11 / 06:15 / 06:20 / 06:26 / 06:31 / 06:35`, the 30-minute window the pack specifies |
| Recorded connector calls render as collapsed plugin rows with durations | `transcript.pluginRuns` = `Google Drive 1016 ms`, `Granola 753 ms`, `Linear 1302 ms`, each `state: "completed"`, `timingAccuracy: "observed"`, one tool call each — not three ungrouped rows |
| The full activity tree is present | `response → assistant_turn → plugin → tool` with real intervals, written by the production path |
| The document is attached and cited | `resources: [{ title: "Insights pricing — decision memo", relationship: "attachment" }]`, and the closing assistant turn opens `I have put the memo together as **Insights pricing — decision memo**…` |
| The presenter is a participant of the renewal room by mention | `participants: ["Priya Raman", "Marcus Hale", "Dana Okafor", "Adam"]` |
| …with an unread mention, unopened | directory row `{ youAreMentioned: true, unseen: true }` |
| …and an open question addressed to them | one `openElicitations` entry, `status: "open"`, `responseType: "radio"`, three options, `targetUserId` = the presenter |
| Home-screen attention agrees | `{ waitingForYou: 1, waitingReason: "mentioned", hasUnreadActivity: true }` |

### Answering the question restarts the loop, and the loop reads the seeded history

The presenter answered the elicitation through `SubstreamAgent`'s `answer_elicitation`
product RPC (200). The persistent loop resumed, produced a closing assistant turn, and
the work stream went `needs_input → completed` with zero open elicitations.

The strongest evidence is the protocol array the resumed loop assembled and handed to the
provider, captured at the provider boundary:

```
roles: ["system", "user", "assistant", "user", "assistant", "tool"]
  system    "You are Rally a helpful assistant in a multi-player collaborative envi…"
  user      "Northgate renewal is up. Before we quote it I want to know what we act…"
  assistant "From the contract: Northgate are on the 2024 Growth agreement, 140 sea…"
  user      "We are going in circles and the notice window opens in eleven days. Ra…"
  assistant  (the elicitation tool call)
  tool      {"data":{"answer":"Include Insights at the $4k Growth uplift","elicita…
```

That is the seeded conversation, read back as the loop's own history. It bootstrapped
from the canonical transcript the seeder wrote, not from anything the seeder handed it.

**But note what is missing from that array** — see §2.

### The reset holds

W1 was retired, W2 was created through the ordinary onboarding path
(`POST /onboarding/workspace`), the same pack was seeded into it, and W2 verified
identically to W1 — same three rows, same order, same plugin durations, same mention,
same open elicitation, same attention payload.

Then the reset was attacked deliberately:

| Probe | Result |
| --- | --- |
| Write into a retired work stream, straight at the object with a connector principal (the shape a queue consumer uses, bypassing the edge) | `409 workspace_retired` |
| The presenter's W1 session against `GET /workstreams` | `401 session_revoked` |
| A message admitted into W1 *just before* retirement, then forced up the hierarchy *after* it | **Every envelope that arrived was dropped.** In the driver run, 2 directory envelopes; in a separate experiment that isolated this one lane, 15 directory and 7 activity/mention envelopes. Either way `workspace_workstream_directory.last_activity_at` for that room was identical before and after — `1788505292604` in the driver run |
| W2's directory, attention and transcripts, 180 s after W1 was retired | byte-identical to the reading taken immediately after seeding: same three rows, same `lastActivityAt`, same `{waitingForYou: 1, waitingReason: "mentioned"}`, same turn counts `[10, 2, 3]` |
| Alarms on W1 immediately after retirement | every object — WorkspaceDO, all three WorkstreamDOs, all three SubstreamAgents — reported `alarmAt: null` and `storedAlarms: 0` |

**Nothing from W1 reached W2.** §5 has the one loose end.

---

## 2. What was not proven

- **Only human turns carry historical time.** Assistant turns, tool receipts, activity
  intervals and the directory's `last_activity_at` are all stamped at the real clock. In
  the run above every seeded assistant turn is dated `06:37:3x` while the human turns
  around it are dated 30 minutes to 3 hours earlier. The directory's recency order came
  out right *only because the seeder happens to run in chronological order* — a demo
  that opened the sidebar would show three rooms all last active "just now". §4 has what
  it would take to fix.

- **A human message that starts no run never enters the model's context.** The four
  persona messages in the middle of the renewal conversation are in the canonical
  transcript (all ten turns render) and are absent from the protocol array above. The
  mechanism is structural rather than a spike artefact: a message admitted without
  activating the loop commits a canonical turn and no Bind transition, and a later run
  bootstraps from the Bind head rather than from the transcript. Worth confirming against
  a live workspace before trusting it — the spike bypasses the addressing classifier
  (§3), so in production some of those messages might have activated the loop instead.
  If it holds, a scripted multi-person discussion is invisible to the agent that is asked
  about it, which is a demo problem *and* a product question.

- ~~Nothing was checked in a real window.~~ **Corrected: it was.** See
  [§6](#6-visual-verification). The Electron client was run under Xvfb against the seeded pack
  and every visible claim above holds on screen. Two things only the visual inspection showed
  are recorded there.

- **Retirement was never tested against a workspace with automations.** The pack creates
  none, so the automation-pause arm of the protocol compiled and ran against an empty
  list. Its shape has a known gap: `AutomationAgent.pause` takes an *actor*, and a
  retirement has no person in it — the spike passes the automation's own author.

- **Nothing was tested under concurrency, eviction, or a partially-failed retirement.**
  The retirement walk is a straight-line loop with no receipts; a crash halfway leaves a
  workspace partly retired and there is no resume.

- **The pack is two thirds specified.** The brief describes work stream A (the decision
  memo) and one more whose content matches what the verification calls C (the renewal
  conversation). No middle work stream was specified. The seeder invents one — a short
  onboarding-email room dated 90 minutes back — purely so the directory has three rows in
  a meaningful recency order. It is scaffolding, not a pack decision.

---

## 3. The machinery that had to be built, and what was harder than expected

Six new files under `apps/api/src/spike/` (~1,500 lines) plus a driver script, and
**~400 lines of change across nine production files**, every hunk marked `SPIKE —
throwaway`. The production diff is small, which is the useful result; the surprises are
where it had to go.

### A replay context — *easier than expected*

`{ occurredAt, packRunId, actionId, workspaceId }`, threaded into the two canonical
mutations that mint a visible turn. It reaches exactly **three** production statements:
`initialize`'s `const now = Date.now()`, `createMessage`'s `const reservationNow =
Date.now()`, and the workflow input the run inherits. Both mutations already funnel their
whole timestamp story through one local — the turn's `created_at`, its UUIDv7, its
attachment stamps, the pending-input row — so one substitution per path was enough.

It is exposed on no HTTP route. The dev-gated seeding route takes a workspace id and
nothing else; every instant in the pack is an offset from the seeding moment held in
`pack.ts`.

**One trap.** `reserveInputPreparation` derived its cancellation-recovery *alarm horizon*
from the same `now` it stamps the row with. A three-hour-old instant would have armed an
alarm three hours in the past. The two had to be split — visible time from the replay
context, alarm horizon from `Date.now()`. Production behaviour is unchanged, because for
a live admission the two values are the same. **This is the shape of the whole risk in
replay-seeding: a supplied timestamp that silently becomes a scheduling decision.**

### A synthetic harness-outcome adapter — *harder than expected, and the design is now clear*

This is **not** a second transcript writer. A seeded assistant turn is produced by the
ordinary run — the same `runHarness` call, the same Bind loop, the same reserved
assistant turn, the same tool-receipt ports, the same activity upserts, the same terminal
settlement. Exactly two things are replaced, and both are the *source of model output*:

1. **`OpenRouterConfig.fetch`** — an injection point the harness already exposes, used by
   nobody in production — answers `chat/completions` from a recorded script.
2. **The plugins a recorded connector call names** are registered for that run with
   executors that return the recorded answer. Nothing outbound happens and no connector
   has to be connected; the receipt, the plugin activity row and its duration are written
   by the production path.

Four things cost real time:

- **A plugin needs more than a tool list to be usable.** Registering the fixture plugins
  was not enough: `persistWorkstreamPluginActivation` refuses any plugin without a
  **tool-surface hash**, and `beforeToolCall` refuses any credential-free plugin that is
  not in the run's **built-in set**. Both had to be populated. Until then every run died
  in 90 ms with `unauthorized: Plugin is outside this immutable run scope`.
- **An unset provider key is not an empty one.** With `OPENROUTER_API_KEY` absent, Bind
  calls `.trim()` on `undefined` and the run fails as `harness_execution_failed` before
  any fetch — including the replaced one. A placeholder had to be supplied.
- **The tool's argument schema is stricter than the model-facing one, and getting it
  wrong is silent.** The first elicitation fixture sent a plausible-looking
  `responseType` and a plain string option list. `RequestElicitationInputSchema` rejected
  it, no question opened, Bind was told to try again, and the run finished with a tool
  card and no elicitation. Nothing said why.
- **A fixture that repeats its last turn wedges the whole runtime.** The first adapter
  clamped its script index, so a one-turn fixture whose turn was a tool call was replayed
  on every model call and the loop never reached a turn that ends it. That is a tight
  infinite loop inside one isolate: the workerd process pegged a core, stopped answering
  `/health`, and printed nothing. Exhaustion is now a hard `400`.

**A recorded connector outcome cannot be seeded any other way.** The only production
writer for `connector_connections` is an OAuth callback, which needs a public HTTPS
redirect. A demo pack either registers synthetic plugins for the run, as here, or has no
connector history in it.

### A propagation barrier — *free* — **SUPERSEDED, see §0**

Nothing had to be exposed. `SubstreamAgent.flushEffectsToWorkstreamDO()` and
`WorkstreamDO.flushWorkspaceDirectoryEffects()` are already public RPC methods —
`WorkstreamObjectCreationService` calls both on every create — and
`WorkspaceDO.hasWorkstreamDirectory()` is the probe that create already refuses to
activate a route without. The seeder calls the same three, in the same order.

### A retirement protocol — *the real work, and the piece with the most residue*

Nothing in Rally retires a workspace. The nearest thing, `workspaces.abandoned_at`, is
three-quarters short of one: it is reachable only through
`WorkspaceService.leaveWorkspace`, which **refuses a workspace with more than one active
member**; it gates admission in D1 and nothing else; and every Durable Object beneath it
keeps its alarms, its outbox, and its willingness to apply whatever arrives.

The spike adds the missing halves, in an order that is not arbitrary:

1. **Reject new product work** — reuse `abandoned_at`, written directly, because it is
   already read on every authenticated request and inside every object's own membership
   check. Admission closes first so nothing new enters during the walk.
2. **Fence the WorkspaceDO** — record a retirement row and drop any effect tagged at or
   below the generation it was retired at. This goes *before* the walk, or an effect
   drained by step 4 lands on an unfenced object.
3. **Pause the automations** through `AutomationAgent.pause`, the production transition.
4. **Clear every alarm**, leaf-first, on each SubstreamAgent then each WorkstreamDO then
   the workspace object, with each class's derived-alarm hook returning empty once
   retired so the platform alarm is deleted rather than re-armed.

Two design facts fell out that a real implementation has to keep:

- **A dropped effect must still be acknowledged.** Refusing it leaves the retired
  workspace's WorkstreamDOs retrying the same envelope forever — a second way for a dead
  workspace to keep costing something.
- **The generation on an effect envelope is the *region's* work-stream authority
  generation, not the workspace's.** It is `1` for every workspace in the region, so it
  cannot distinguish "an effect from the retired workspace" from "an effect from the new
  one". The fence works only because it is per-object. A real per-workspace fence needs a
  workspace-local epoch that the objects beneath it carry on their effects.

---

## 4. Production paths that could not accept a supplied timestamp

**Accepted one** (after threading): `WorkstreamObjectProductService.initialize` and
`.createMessage`. One substitution each.

**Could not, and why:**

| Path | What stamps the time | What it would take |
| --- | --- | --- |
| The whole harness run — reserved assistant turn, tool receipts, activity intervals, terminal settlement | **22 separate `new Date().toISOString()` call sites** in `integrations.ts` alone, all feeding `occurredAtUtc` on `upsertActivity`, plus `Date.now()` in the attempt lease and inference-attempt accounting | A run-scoped clock threaded from `WorkstreamWorkflowInput` into `runWorkstreamHarness` and every activity/receipt call under it. This is the single largest piece of work the real implementation would carry, and it is the one that decides whether a seeded demo looks historical |
| `attachResource` | `const now = Date.now()`, and the object's `attach_resource` RPC has no field to carry one | One field on an internal RPC plus one substitution. Cheap; skipped here because nothing in the pack's verification depended on it |
| `openPreparedElicitation` | Takes a `now` argument, and `core_request_elicitation` passes `Date.parse(nowIso())` unconditionally | Same shape as `targetUserId` below — the port is ready, the caller is not |
| `workspace_workstream_directory.last_activity_at` | Derived from whichever effect landed last, which for a seeded room is the real-time assistant turn | Follows from the harness clock above; no separate work |
| `elicitation_requests.target_user_id` | Not a timestamp, but the same shape of gap: the column exists, `openElicitations`'s input takes it, and **no production caller has ever set it** — `core_request_elicitation` passes `null` unconditionally. A question addressed to one person is unreachable through any production write path | One argument at one call site. The spike passes it and the rest of the product honours it end to end: the elicitation reads back with its target, and the presenter answers it |

**Two more paths refused a seeded write for reasons worth knowing:**

- **`createMessage` asks a model whether the message addresses Rally.** With no provider
  configured the addressing classifier throws `OPENROUTER_API_KEY is not configured` and
  the whole admission fails. A seeded human message cannot be admitted at all without
  either a live provider or an explicit override. The spike states the answer in the
  replay context instead.
- **`POST /workstreams` always starts a run.** There is no production path that creates a
  work stream with a human message and no run, so a room that opens with people talking
  to each other cannot be seeded as specified; the pack gives the opening run a recorded
  assistant contribution instead.

**And one identity fact:** there is no product API that creates a member who never signs
in. The persona rows are written into regional D1 — identity and membership are D1's
authority — with a `google_subject` sentinel (`persona:<slug>`) that cannot collide with
a real Google subject, which are decimal strings.

---

## 5. Did anything from W1 reach W2? No. But W1 did not go fully quiet.

**No state leaked.** W2's directory, attention payload, transcripts and turn counts were
byte-identical before and after a wait spanning the longest alarm interval observed —
same three rows in the same order with the same `lastActivityAt`, same
`{waitingForYou: 1, waitingReason: "mentioned"}`, same turn counts `[10, 2, 3]`. Real
effect envelopes were pushed at the retired WorkspaceDO on purpose — 2 in the driver run,
22 in an experiment that isolated the lane — and every one was dropped; the directory
row's `last_activity_at` never moved.

**One loose end.** After that post-retirement traffic, the retired WorkspaceDO came back
holding a single stored alarm entry — `product:workspace`, armed about ten minutes out.
A *quiet* retirement stays at zero alarms across 5 s, 20 s and 60 s, so the re-arm is
traffic-driven: at least one inbound RPC on the retired object sits outside the two
lanes the spike fenced and calls `refreshProductAlarm()`. It changed no product state and
reached no other workspace. It means a retired workspace wakes on a timer forever, which
is a slow cost rather than a correctness bug — **but it is the finding that decides the
shape of the real implementation: the fence has to be one central check the object
applies to every inbound call, not a check added to the two obvious lanes.** There are
more doors than there look to be, and the one that was missed is the one that re-armed
the alarm.

### What that implies for clearing in place versus creating a fresh workspace

**Create a fresh workspace. Retire the old one; do not clear it in place.**

- Creating W2 through ordinary onboarding is one HTTP call and gives a genuinely new
  `WorkspaceDO`, `WorkstreamDO` and `SubstreamAgent` per room — new object ids, new
  SQLite databases, new alarms. Nothing has to be deleted, which means nothing can be
  *incompletely* deleted.
- Clearing in place would have to reverse every table in a WorkspaceDO plus every child
  object's transcript, loop state, receipts, reservations and outboxes, and it would have
  to do it while a straggler from the previous pack is still in flight — the exact
  situation §5 shows arriving 22 envelopes late. Under a fresh workspace those envelopes
  are addressed to an object nothing reads; under clear-in-place they would be addressed
  to the object the new pack is being written into. The retirement fence would have to be
  a *time* fence rather than an identity fence, and it would have to be right.
- The cost of the fresh-workspace route is that dead workspaces accumulate. That is a
  reaper's problem — bounded, offline, and safe to get wrong — rather than a
  correctness problem in front of an audience.

---

## 6. Visual verification

Observed in the Electron client running under Xvfb against a live local stack with the
pack seeded into it, driven over the DevTools protocol, per
`docs/dev-environment.md`. The seeded rooms are the three at the top of the sidebar; the
two under **Today** are the repository's own checked-in development fixtures.

| Surface | Observation |
| --- | --- |
| Home and sidebar | The home screen's **Needs attention** row reads *"You were mentioned — Northgate renewal is up…"*, and the sidebar shows all three seeded rooms in the pack's intended order with a participant facepile on the renewal room. This is the `attention` payload rendered. |
| Plugin rows and durations | The decision-memo transcript. The three recorded connector calls render exactly as the pack intends: collapsed under **Worked for 2s**, expanding to **Used Google Drive for 1s**, **Used Granola for 781ms**, **Used Linear for 1s**, each with its provider icon. Not three ungrouped tool rows. |
| Attached document | The work-stream context rail: Priya as **Creator**, and the memo under **Sources**. Its *Unavailable* label is the **watch** status (`watchStatus: "unsupported"`), which is correct for an uploaded file with no provider to poll — not a broken attachment. |
| Seeded conversation | The renewal room. Three personas arguing across historical timestamps — 38, 34, 30, 25, 19 and 14 minutes ago — with the header showing **Private**, **Needs input**, and a four-person facepile. |
| Open elicitation | The `@Adam` mention chip, then the open question card: the prompt, three numbered options, an **Other** free-text field, and Skip / Submit. |

**What the visual inspection showed that the API reads did not:**

1. **The historical-timestamp gap is worse on screen than in the payload.** Every seeded
   room is grouped under **Last hour** in the sidebar, and the decision memo's assistant
   reply is stamped *"7 minutes ago"* directly beneath a human message stamped *"3 hours
   ago"*. That is §2's finding rendered: a demo audience sees three rooms that all
   happened just now, with an internally inconsistent conversation inside each. It is the
   single most visible consequence of the harness clock, and it moves item 1 of the
   recommendation from "nice" to "the thing to fund first".
2. **One cosmetic artefact of the recorded run.** The renewal room's activity group
   renders as two rows, `Rally worked for 62ms` and an unlabelled `worked for 150ms`.
   Worth a look before a demo, but it is a rendering detail of a very fast recorded run
   rather than anything the reset question turns on.

Not visually inspected: the retired workspace. Retiring the local development workspace would have
made the sandbox's own dev account unusable, and the retirement evidence in §1 and §5 is
API-level and complete.

## 7. Recommendation

**Fund it, at roughly half the scope the PRD is likely to assume, and in this order.**
The visual observations in §6 sharpen this rather than change it: item 1 below is now the item
anybody looking at the demo would notice first.

The two things that looked risky are not. Seeding through production paths works and the
production diff is small; the reset holds, provably, against a deliberately-armed
straggler. The pieces that need funding are narrower than "build a demo system":

1. **A run-scoped clock through the harness** (largest item; 22 activity call sites plus
   the receipt and lease paths). Without it, every seeded assistant turn is dated "just
   now" and the sidebar shows three rooms all last active at the same second — which is
   the first thing anyone looks at. Everything else in the demo already works without it.
2. **A workspace retirement state that every inbound object call consults**, plus a
   per-workspace epoch on effect envelopes. Not the four-step walk the spike wrote —
   that part was straightforward — but one fence, checked centrally, so the count of
   doors stops mattering. Add receipts so a half-finished retirement resumes.
3. **A recorded-provider seam kept deliberately narrow.** `OpenRouterConfig.fetch` plus a
   fixture plugin surface is the whole mechanism; it needs a schema-validated fixture
   format (the two silent failures in §3 were both malformed fixtures) and a hard stop on
   exhaustion.
4. **Decide the two product questions the spike surfaced** before the PRD commits:
   whether a targeted elicitation is a feature (the schema and the port already support
   it; no caller sets it), and whether a human message that starts no run should reach
   the model's context at all.

**Do not fund** clearing a workspace in place, and do not fund a general "time travel"
mode — the replay context works precisely because it touches three statements and is
reachable from no HTTP route.

---

## Appendix: state of this branch

- **`pnpm typecheck`**: green.
- **`pnpm lint`**: green (zero warnings), after fixing the spike's own dynamic imports,
  an unused local, and one `no-console`.
- **`pnpm test`**: green — `apps/api` 234 Node files / 2544 tests and 54 workerd files /
  651 tests, `apps/desktop` 150 / 2186, plus every package suite. The workerd run prints
  its usual `uncaught exception` and `failed to invoke drain()` noise on a clean pass.
- No test was added. The spike's own claims are evidenced by the driver's output, not by
  a suite, which is why none of this should merge as-is.
- The spike deletes cleanly: everything is either under `apps/api/src/spike/`,
  `scripts/spike-demo-replay.mjs`, or a hunk marked `SPIKE — throwaway,
  spike/demo-workspace-replay only. Delete with the spike.`
- **One thing that must not survive:** the retirement flag is created with
  `CREATE TABLE IF NOT EXISTS` from a request handler, which
  `docs/durable-object-sqlite.md` forbids. It is done that way on purpose so the branch
  can be deleted without leaving a released migration behind. A real implementation puts
  it in each class's migration list.
- **Repeating the visual verification:** seed the pack into the development workspace
  (`POST /auth/dev/session`, then `POST /dev/spike/seed` with that workspace and the
  session's `sid`), then run the Electron client under Xvfb per
  `docs/dev-environment.md` and sign in with **Use local development account**. On a cold
  sandbox the Electron binary is not downloaded and `electron-vite dev` fails with
  `Error: Electron uninstall`; the documented fix
  (`node node_modules/.pnpm/electron@*/node_modules/electron/install.js`) works.
- **Running the driver:** start `pnpm dev:api:local`, run `pnpm db:open-authority`, then
  `node scripts/spike-demo-replay.mjs`. On this sandbox `dev:api:local` needs the
  documented container-flag workaround from `docs/dev-environment.md` (delete the
  `containers` array from both regional wrangler configs for the session); that edit is
  **not** committed on this branch.
- **One local-environment trap worth knowing outside the spike:** a cold
  `POST /onboarding/workspace` can answer `503 regional_onboarding_unavailable`, and that
  failure leaves a `pending` row in `platform_workspace_bindings` which `reserve` refuses
  to write past and which nothing reclaims automatically. Every later workspace create
  then answers `409 workspace_binding_conflict` until the row is deleted by hand. The
  driver warms the binding first for that reason.
