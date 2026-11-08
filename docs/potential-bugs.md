# Potential bugs and coverage gaps

Things found while reading the code that look wrong, or that nothing proves are
right. Each entry says what was observed, why it is suspicious, and — the part
that matters — **what would settle it**.

Nothing here is a confirmed defect. A confirmed defect gets fixed in the change
that finds it, or filed as work; this file is for the ones where the evidence
stops short of proof and the next person should not have to rediscover the
question. An entry is deleted when it is resolved, with the resolution recorded
in the owning module document's changelog, or when the code it describes is
deleted.

**Read this before assuming a suspicious-looking path is fine because tests
pass.** Entries here have repeatedly turned out to be covered only by tests
that exercised unreachable code. The method that settles one is tracing the
*control flow* to the suspicious statement — every early return and guard above
it — not tracing a table to a query and stopping.

## How entries are written

- **Observed** — what the code does, with `file:line`.
- **Why it is suspicious** — the invariant it appears to break, or the claim
  nothing checks.
- **What would settle it** — the specific evidence that turns this into either
  a fix or a deletion. An entry without this is an opinion, not a finding.
- **Severity** — `data-loss`, `wrong-answer`, `waste`, or `coverage-gap`.

---

## A Sidekick triggered only on `resource_watch` may never start

**Severity:** wrong-answer

**Observed** — `resource_watch` is a submittable trigger: it is in the
`submit_draft` type enum with its own `resourceId`
(`packages/agent-harness/src/index.ts:2756`) and defined in the trigger union
(`packages/contracts/src/index.ts:1159`). But `HostedSidekick`'s accept path
builds it nothing. The schedule loop handles `interval` and skips anything that
is not `calendar` (`apps/api/src/durable-objects/hosted-sidekick.ts:2885-2905`),
and `isExternalEventTrigger` covers only `connector_activity`,
`semantic_activity` and `webhook` (`contracts/src/index.ts:1191`), so no
evaluator is built either. The tool's own schema description now calls it
legacy and says it "does not start Sidekick runs".

**Why it is suspicious** — a draft whose only trigger is `resource_watch`
appears to be accepted and activated with nothing armed to start it: the
silent inertness the `eventTypes` schema description warns about elsewhere,
but reached through a trigger kind rather than a mistyped event name. The
`resource_watches` table in WorkspaceDO is a different mechanism with its own
writers, and nothing found so far connects a Sidekick's trigger to it.

**What would settle it** — accept a Sidekick whose only trigger is
`resource_watch`, change the watched resource, and see whether a run starts.
If none does, either wire the trigger or refuse it at submission, because a
trigger the draft tool offers and the accept path drops is worse than one
that does not exist. If one does start, find the writer that arms it and
record it here before deleting this entry.

**Noticed while** adding the `polling-for-events` skill, which is the one
place that talks a model through "tell me when this thing changes" — the
request most likely to reach for this trigger. The skill and the tool schema
steer off it in the meantime, which is a workaround, not the fix: the enum still
admits it.

---

## The conversation composer's own length refusal is unexercised

**Severity:** coverage-gap

**Observed.** `sendMessage` in
`apps/desktop/src/renderer/screens/conversation-surface.tsx` (`:1997`-`:2017`)
refuses a message over `MESSAGE_MAX_CHARACTERS` before the optimistic turn is
inserted, setting `sendError` to `MESSAGE_TOO_LONG_MESSAGE` and throwing. Nothing
tests it: `canvas.test.tsx` replaces `ConversationSurface` with a mock,
`sidekick-conversation.test.tsx` renders the real surface over mocked sockets but
never sends an over-long message, and the composer's own tests run the composer
against a mock.

**Why it is suspicious.** It has already been wrong once. The guard shipped into
review returning rather than throwing, and `WorkstreamComposer.send` clears the
draft *before* awaiting `onSend` and restores it only if `onSend` rejects — so
the refusal deleted the message it was asking the person to shorten. A review bot
caught it on the pull request that introduced it; nothing in the suite did, and
the composer's own reject-restores-the-draft tests passed throughout, because
they exercise the composer against a mock rather than against this screen.

That is the shape of the gap: the guard holds a rule across a contract — resolve means
sent — that only the screen and the component together express, and rests on a
code read. Its failure is not silent at the server: `AgentLoopDO` answers
the same refusal with the same sentence, which
`test-workers/message-to-output-pipeline.test.ts` proves. But everything between
the keystroke and that socket frame — the draft surviving, the optimistic turn
never appearing — nothing checks.

**What would settle it.** A case in `sidekick-conversation.test.tsx`, which
already renders `ConversationSurface` for real over mocked sockets, asserting
that a message over the ceiling shows `MESSAGE_TOO_LONG_MESSAGE`, never calls
`createMessage` on the socket, keeps the draft, and leaves the transcript
untouched.

---

## Two of three ordinary-run readers have no behavioural assertion

**Severity:** coverage-gap

**Observed.** The rule that a conversation's ordinary run is never one of its
inline children — `parent_tool_call_id IS NULL` — is now issued inside the
conversation object, by three queries in
`apps/api/src/durable-objects/workstream-harness-run-storage.ts` (`:369`,
`:393`, `:404`). `test-workers/ordinary-harness-run-selection.test.ts` asserts it
behaviourally against a real object, but only through the reader that suite
reaches, the conversation's detail projection. It replaced a Node test that
asserted the SQL *text* of the queries, which was not coverage.

**Why it is suspicious.** Dropping the predicate from either of the other two
queries goes unnoticed. Reusing an inline child as a Sidekick's run attaches a
scheduled run to a tool's private run.

**What would settle it.** Trace each of the other two queries to its callers,
and add one `test-workers/` case per caller over an object seeded with an
ordinary run (*oldest*) and two inline children, asserting the ordinary run is
the one returned.

---

## A conversation's targeting facts can be cached from before it was written

**Severity:** wrong-answer

**Observed.** `flag-targeting-attributes.ts:314-343` reads a conversation's
origin, scope, creator, opportunity and system flags through `loadIdentity`, and
`cached(...)` stores whatever that read *resolves* for
`ATTRIBUTE_CACHE_TTL_MS`. A conversation's identity root is written by
`bootstrapWorkstreamRuntimeEnvironment` with its defaults (`origin_type`
`'ad_hoc'`, no creator) before the product row that carries the real origin and
creator.

**Why it is suspicious.** A model resolution for a conversation id between
those two writes would cache the root's defaults, and every targeting rule would
see an ad-hoc conversation created by nobody for as long as the entry holds. A
miss is deliberately not remembered; a premature hit is.

**What would settle it.** First, whether any resolver reads in that window:
`scheduledWorkstreamModel` is called from `sidekick-run-provisioning.ts:106` and
from `workstream-service.ts`, and each call has to be placed against its
object's bootstrap and product writes. If one does, the fix is to not cache an
identity whose product state has not landed, rather than to widen the window.
