# Discussion brief: Slack conversation bindings and Sidekick replies

> Prepared 2026-09-24 from the design conversation. This records the questions,
> corrections, decisions, and proposed direction discussed together. It is not
> an implementation plan or a claim that the proposed routing is already live.
> Product proposal: [`prd.md`](prd.md). Architecture sketch: [`design.md`](design.md).

## The scenario that started the discussion

The Northstar weekly call prep Sidekick sent Morgan a Slack DM asking for two
sections, **Updates** and **Asks**, by 2:00 PM PT. Morgan replied in the message
thread, “Nothing from me.” Rally acknowledged the reply as an ordinary Agent
interaction and opened separate work for it. The question was whether the
Sidekick that sent the request actually received that answer and could use it
with the other founders' answers to prepare the agenda. The observed behavior
did not demonstrate that collection path.

The original request appeared to be associated with an initiating Rally
Breakout. We distinguished three things that are easy to conflate:

1. The **authoring Breakout** where the Sidekick was set up or invoked.
2. The **Sidekick** that owns scheduled runs.
3. The **1 PM run child**, a separate substream Durable Object created under
   the Sidekick when that run starts.

The user's correction established the third item as the starting point for
this design. The 1 PM child already provides a durable conversation for the
outreach run. We should use it as the collection destination rather than
inventing a separate “Sidekick collection” object. The authoring Breakout is
not automatically the place where outbound DM replies should accumulate.

## Topics covered

| Topic | Question we worked through | Direction reached |
| --- | --- | --- |
| The specific Slack reply | Did Morgan's thread reply return to the Sidekick? | It was handled as ordinary Agent work, so the present routing did not establish the collection path we want. |
| Conversation hierarchy | How should Slack channels and threads relate to Rally? | A shared Slack conversation maps to a Space; a request thread maps to a Channel in that Space. |
| Group DMs | Should a group DM containing Rally be special? | Treat it like another shared conversation with a linked Space. Reserve special policy for a one-to-one Rally/user DM. |
| Joining Slack rooms | Should Rally discover rooms by joining them? | Stop proactive joins. An invitation establishes the shared-room link; a tag in a thread starts a Channel. |
| Outbound Sidekick messages | Where should a reply to a Sidekick DM go? | Bind the exact outbound reply thread to the intended Rally conversation, which in this scenario is the 1 PM Sidekick run child. |
| Collection object | Is a new Sidekick collection primitive needed? | No. The Sidekick-owned run child is the proposed container for the answers. |
| Cross-run handoff | How does the 2 PM run see the answers? | The Sidekick parent identifies the matching 1 PM run; Rally passes a fixed, attributed snapshot into the 2 PM run's opening context. |
| Agent tools | Can the 2 PM model decide to read a sibling run itself? | It receives tools, but the discussion found no existing model-facing prior-run feed tool. For this fixed workflow, the host supplies the answers before the model starts. |
| Connector scope | Should this be Slack-only code? | No. The routing mechanism should describe external rooms and threads generically; Slack supplies one adapter's identities and events. |

## How the design changed during the conversation

1. We first asked whether the existing Slack reply had reached the Sidekick.
   Its treatment as ordinary Agent work exposed a missing reply destination.
2. We explored directing replies to the Breakout that initiated the Sidekick.
   That would store a reply somewhere relevant, but it would not by itself tell
   a scheduled run which answers to use for the agenda.
3. We used “Sidekick collection” as a working term, then rejected it as a new
   object. The user identified the 1 PM Sidekick-owned child substream as the
   existing durable place to collect answers.
4. We separated the **routing** question from the **synthesis** question:
   replies enter the 1 PM child; a new 2 PM child needs a deliberate handoff.
5. We checked whether the 2 PM agent could simply read the earlier child. The
   host can address another child conversation, but the model is not given its
   identity or a prior-run feed tool. For this fixed task, a host-prepared
   opening snapshot became the favored design.

## Decisions and design direction

These are the choices made or explicitly favored in the discussion. They
remain design decisions for a proposed change, not descriptions of shipped
behavior.

### 1. A shared external room links to a Space

When Rally is invited to a public Slack channel, private Slack channel, or
group DM, Rally creates or reuses one linked Space with an initial name derived
from that conversation. Rally does not proactively join public channels. The
link follows the provider room's stable identity, not its display name. A
renamed conversation therefore remains linked to the same Space.

A one-to-one DM between Rally and a user needs a different policy. Opening that
DM does not, by itself, create a Space. Its outbound Sidekick threads can still
carry explicit reply bindings.

### 2. An addressed external thread links to a Channel

When someone tags Rally in a message or thread in a linked shared room, Rally
creates or reuses a Channel in the linked Space. Subsequent replies in that
same external thread continue the Channel without another tag. An unrelated
thread does not silently join it. If the provider has no stable thread
identity, Rally cannot guess that a later unaddressed message is a reply.

This is a routing relationship. A link back to the original Slack thread is
useful provenance but is not sufficient to route future messages.

### 3. Outbound messages can bind their reply threads explicitly

The same binding idea must cover a message Rally sends first. The source is the
exact external room and root message thread returned by the provider. The
destination is a Rally conversation address chosen by the outbound action. A
reply in that provider thread resolves the recorded destination before the
ordinary “create an Agent Channel” path runs.

This is a general capability for Slack-like connectors. It does not imply that
every external message should create a Space or Channel; outbound one-to-one
DMs are an important counterexample.

### 4. The 1 PM Sidekick child collects the founders' answers

At 1 PM, the Sidekick owns a newly created child substream for its outreach
run. Each founder DM from that run should bind its exact reply thread to that
same child. The binding retains which founder and which outbound request it
represents. Answers from separate DMs then converge in one run transcript with
source and author attribution.

The 1 PM model may have finished sending requests before any founder answers.
Receiving an answer should record an external turn in the child without
starting a new Agent Channel, creating another Sidekick run, or restarting the
completed 1 PM inference. The discussion favored an explicit non-activating
ingress path for this case.

### 5. The 2 PM run receives a deliberate handoff

At 2 PM, the Sidekick starts a different child run. Its own transcript does not
automatically contain the 1 PM child's answers. Although Rally can address a
specific child conversation internally, the model currently has no stated
instruction, prior run ID, or model-facing tool that would make it reliably
find and read that feed.

For this fixed agenda workflow, the proposed handoff is host-driven: identify
the matching 1 PM run, take an answer snapshot at a defined cutoff, and put
one durable opening message in the 2 PM child. That message gives the model
the attributed answers, missing founders, source references, and the explicit
task to synthesize **Updates** and **Asks**. The model then works from a known
input rather than discovering a sibling run by inference or search. This does
not preclude a general prior-run reading tool later if another workflow needs
one.

### 6. Preserve provider and Rally authority boundaries

The provider identifies a room, thread, and sender. Rally decides the linked
Space or Channel, who may see its content, and whether a reply is admitted to
the bound conversation. A Slack sender does not become a Rally member merely
because they answered a Sidekick DM. Private channels and group DMs must not
be widened to an Organization-wide audience to make placement convenient.

## Walkthrough of the Northstar flow we want

```text
1 PM  Sidekick creates outreach child A
      A sends a separate Slack DM request to each founder
      Each successful send binds its exact Slack reply thread -> A

Before 2 PM
      Founder replies in that thread
      Rally resolves the binding and records an attributed answer in A
      The completed 1 PM model is not resumed

2 PM  Sidekick creates synthesis child B
      Rally identifies A for this week's collection
      Rally snapshots A's answers at the cutoff and opens B with that evidence
      B drafts the Updates / Asks agenda and delivers it to the chosen target
```

An unthreaded message elsewhere in the one-to-one DM is not the same answer.
A reply whose outbound root identity was never confirmed cannot be claimed as
collected. A late answer can remain in A's history, but it should not silently
rewrite an agenda already sent.

## What this does and does not add

The Sidekick, its run children, and their transcripts are existing concepts in
this discussion. The design does **not** require a new collection entity.

The proposed platform mechanism is an explicit external-conversation binding:
a stable provider room or thread identity resolves to a Rally destination.
That mechanism is shared by inbound tagged threads and outbound reply threads,
while their activation policies differ. The Northstar flow also needs a way to
record late external answers in a completed run child and a deliberate handoff
from one scheduled child to the next. Those are behaviors to design; the
conversation has not established them as existing product behavior.

## Unanswered questions

### Sidekick collection and synthesis

1. **How are the two scheduled runs paired?** If 1 PM and 2 PM are separate
   schedule occurrences, what stable identifier says that these two runs are
   the outreach and synthesis phases for the same Northstar week? Time proximity
   or matching prompt text is not a reliable key.
2. **What exactly is the cutoff?** Does the 2 PM snapshot use provider event
   time, Rally receipt time, or the moment B begins? How do we treat a reply
   sent before 2 PM but received after the snapshot?
3. **What counts as one founder's answer?** Can a founder send several replies,
   amend an earlier answer, or answer in a new thread? Should the agenda use
   all replies, the latest answer, or a structured interpretation of them?
4. **What if a founder never answers?** Should B list the founder as missing,
   omit them, or ask for follow-up? “Nothing from me” is an answer, distinct
   from no answer.
5. **What happens to late answers?** The draft direction records them in A
   without silently revising the posted agenda. Whether Rally should send a
   follow-up or create a revision remains undecided.
6. **Where is the finished agenda posted?** The owning Channel's Main
   conversation and the initiating authoring Breakout are different targets.
   The conversation has not selected one as the required destination.
7. **Is this handoff a general Sidekick pattern?** The host-provided opening
   snapshot is suited to this fixed weekly task. If many workflows need agents
   to inspect arbitrary previous runs, a scoped agent tool may be more useful.

### External binding behavior

8. **What happens when an outbound send succeeds but its receipt is lost?** A
   reply cannot be routed by guessing the root thread from text or timing. Is
   there a provider-supported recovery path, or must the collection remain
   visibly unconfirmed?
9. **What is the one-to-one DM fallback?** For a reply outside a bound thread,
   should Rally start ordinary Agent work, decline it, or ask the person to
   reply in the original thread?
10. **How do edits and deletions affect collected answers?** A provider can
    change or remove a message after Rally recorded it. The draft has not
    decided whether the agenda is based on the received snapshot, a current
    provider view, or an explicit amendment event.
11. **How does the binding end?** The Sidekick run may be complete while its
    reply threads remain useful. We need an explicit policy for when a binding
    stops accepting answers and what a sender sees afterward.
12. **Who may answer a bound request?** A one-to-one DM strongly suggests one
    expected founder; shared rooms may not. The admission rule should follow
    the request's intended audience rather than assuming any reply in a bound
    thread is an authorized answer.

### Shared rooms and migration

13. **What happens when a person leaves a private Slack channel or group DM?**
    Does Rally access remain until changed in Rally, or follow provider
    membership? The policy must preserve the audience of retained content.
14. **How are already-joined rooms selected?** Stopping proactive joins does
    not make every historical bot membership a new invitation. Which explicit
    action links those existing rooms to Spaces?
15. **Can a linked Channel move between Spaces?** If it moves, does its
    provider room remain a required placement, or is the external link
    independent of placement?
16. **How do provider renames affect Rally names?** The initial Space name is
    clear; later rename synchronization is not.
17. **How do rooms with changed provider IDs behave?** Slack Connect changes
    and group DM participant changes can yield new identities. The design
    favors explicit identity migration where the provider confirms continuity,
    and a new source otherwise; exact product behavior needs agreement.

## Edge cases already raised

| Case | Principle to preserve |
| --- | --- |
| A provider retries an invite, tag, or reply | The same event does not create another Space, Channel, answer, or run. |
| Invite and first tag arrive out of order | Both converge on one shared-room binding and one thread destination. |
| Two tagged threads exist in one Slack channel | They create distinct Rally Channels placed in the same linked Space. |
| A tagged shared-room thread and a bound outbound Sidekick DM both receive replies | Each follows its explicit destination; neither is routed by a global “all Slack replies” rule. |
| An outbound reply arrives after the 1 PM model completes | It is recorded without reactivating that model. |
| A reply arrives after the 2 PM snapshot | It remains traceable without silently altering the agenda. |
| A group DM grows and Slack creates a new conversation | A similar participant list is insufficient reason to merge Rally history. |
| The bot leaves, a room archives, or the connection disconnects | Stop new routing while retaining existing Rally work and its source identity. |

## Follow-up discussion, 2026-09-24

A second session, working from a whiteboard sketch of the Northstar flow, changed
several directions above. The PRD and design now reflect these; the sections
above remain the record of the first discussion.

- **One binding record.** Room and thread bindings are the same record over an
  external path of any depth. They differ only in policy (deliver, spawn).
- **The home Breakout joins the runs.** The 1 PM run forwards each reply to
  the Breakout where the Sidekick was set up; the 2 PM run reads that Breakout
  and posts the agenda there. This replaces the host-prepared snapshot
  (decision 5 above) and removes the need to pair runs (question 1) or pick an
  agenda destination (question 6).
- **A reply wakes the run.** It is not recorded silently (decision 4 above),
  because the run's model does the forwarding.
- **Input to a Sidekick run continues that run,** reopening it if completed,
  with the Sidekick's instructions, tools, and run-as authority.
- **Anyone who can reach a run may continue it.** This settles question 12:
  anyone in a bound thread may answer.
- **A Sidekick's home is an owning substream.** `owning_workstream_id` becomes
  a full conversation address, and the Slack-only `authoringOrigin` prompt field
  is removed.
- **Conversation tools are general.** Any Rally agent can be given list, read,
  and post with a scope; a Channel or Breakout agent can read its own Channel
  and Breakout. `sidekick_post_result` is removed so it is not confused with
  the post tool.
- **Rebased on hosted conversation parents ([#984](https://github.com/juno-ai-labs/avalon/pull/984)).** Channel and Space
  parents now live in WorkspaceDO, so a spawned Channel's birth, placement and
  binding commit together, and conversation attachments get their own
  WorkspaceDO table instead of reusing the skill attachment tables.
- **Sidekick scope.** Runs can list, read, and post to attached Channels and
  Breakouts. The Sidekick's config conversation (substream `"0"`) has all
  four tools, and is the only place that can attach.

## Conversation boundaries

The discussion did **not** authorize implementation, decide every unanswered
policy, or establish that the future binding path already handled Morgan's past
reply. The historical “Nothing from me” message remains an example of the gap.
The proposed architecture, as revised in the follow-up discussion above,
directs a future reply to the Sidekick's 1 PM run, which continues and forwards
the answer to the Sidekick's home Breakout. The 2 PM run reads that Breakout and
posts the agenda there; no handoff passes directly from one run to the other.
