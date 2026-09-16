# Product vocabulary

This document owns **what we call the things a user sees**, and — the half that
decides whether the names survive contact with the next person — *why each one
was chosen over the ones that lost*.

**Status: decided, not implemented.** The vocabulary below is settled. No code,
schema, route, or copy has moved yet. Until it does, the tree still says
`workstream` and `substream` everywhere, and the rename's inventory and ordering
are a separate piece of work. [`rally-rebrand-inventory.md`](rally-rebrand-inventory.md)
owns the *Avalon to Rally* rename and is unrelated to this one; the two will run
over the same files and should not be interleaved.

## The vocabulary

| Layer | Was | Is |
| --- | --- | --- |
| The company | workspace | **workspace** |
| A grouping of work | project | **project** |
| A named body of work, with people and an agent in it | work stream | **rally** |
| A private fork of one, for a related piece of work | substream | **breakout** |
| A delegated worker somebody brings to a rally | automation / Sidekick | **Sidekick** (you *bring* one) |
| A rally's identity — icon, colour, title | appearance + title | **banner** |
| What a rally is for, set by a person inside it | description / `objective` | **cause** |
| The one coloured signal a rally shows a person | marker (eight ranked states) | **flag** (one) |
| The unit | message | **message** |

Six product nouns. None of them needs a glossary entry to be understood by
someone who has never used Rally.

## What was actually wrong

Three findings, in the order they landed. They matter more than the words,
because a future proposal to rename any of this has to answer them.

### 1. The old names described container shapes, not things

"Work stream" and "substream" say *where something sits in a hierarchy*. They do
not say what it is, who is in it, or what it is for. Nobody could explain either
one without drawing a diagram — which is the entire complaint, and the reason
neither word ever made it into a sentence a customer said back to us.

### 2. One primitive, four names

The architecture had already collapsed to a single object; only the vocabulary
was fragmented. [`agent-harness.md`](agent-harness.md) states it plainly: each
substream owns one persistent, tool-using loop. A work stream's main feed, a
Sidekick's authoring chat, a Sidekick run, and a private side conversation are
**all `SubstreamAgent` under a typed parent** — one class, four names bolted on
top. Occurrence counts across `apps/` and `packages/` at the time of this
decision: `automation` 1,745, `agent` 1,337, `sidekick` 878, plus
`SubstreamAgent` itself.

This is why the naming felt impossible: we were trying to find four words for
one thing.

### 3. The unit is disposable and numerous

Per [`workstream-naming.md`](workstream-naming.md), a work stream is created
faster than a model can name it — placeholder first, generated title seconds
later. They are spun up constantly and thrown away. This single fact eliminates
every social-container word on its own: nobody creates four hundred *rooms*,
four hundred *channels*, or four hundred *teams*. People do create four hundred
pieces of work.

So the container is not the people, and it is not the actor. **It is the work.**
People attach to it. An agent attaches to it.

## Why rally

Every other candidate failed one of two tests. Either it named a *place* (room,
channel, workroom) and then could not explain why hundreds of them appear
unbidden — or it named a *single actor* (agent, loop) and erased the fact that
several humans are in there too.

Rally passes both, because a rally **contains people by definition**. A room can
be empty. An agent is one thing. A rally is inherently many, and it is
inherently *about* something. That is the object.

Three live meanings, all of them true of the product:

- **Gather people around a cause.** The multiplayer part.
- **A sustained volley** — the tennis sense. Two sides, back and forth, nobody
  is finished until the point is. The conversation part.
- **Mobilize toward an outcome.** The work part.

A Slack channel has none of the three. It is a pipe with a topic on it.

**The accepted cost:** the product name doubles as the unit noun, so "Rally has
four hundred rallies" is a sentence that will get said. Figma files and Google
Docs live with the same thing, and the compensation is that every user sentence
about the product reinforces the brand. Taken knowingly.

**A register note, for copy.** The word has two poles and both are on-brand: the
racket (a volley — collaborative, in motion) and the pitchfork (a mob —
mobilized, loud). In-app copy speaks in the racket. The site and launch material
can have the pitchfork. Mixing them inverts both: mob-flavoured product copy
reads as a stunt, and tennis-flavoured marketing reads as tepid.

## Why breakout

A breakout is what the substream already is, described without a diagram:

- spun off a main event, about something that main event raised;
- a **subset** of the people — whoever is needed, for as long as they are
  needed, not a standing group;
- runs in parallel on its own agenda and **does not interrupt the main floor**,
  which is the "don't pollute the parent" motivation the feature was built for;
- private in practice — what happens there reaches the main body only if
  somebody carries it back, which matches
  [`substream-creation.md`](substream-creation.md): creator-only membership, and
  a frozen context snapshot that never flows back;
- open-ended. A breakout runs until its work is done.

It also supplies the verb unprompted: *break this out into its own thing.*

**And the child needed no noun of its own.** That was the mistake inside
"substream" — someone assumed a nested thing requires a nested word. Folders do
not have a separate noun for sub-folders. This is also the shape of the code,
where parent and child are the same class.

## Banner, cause, flag, bring

These four were not renames for their own sake. Each replaces a name that was
already failing, and two of them carry a product change that must be designed
rather than find-and-replaced.

**Banner** — a rally's icon, colour, and title. One object, currently described
badly across two documents ([`workstream-appearance.md`](workstream-appearance.md)
and [`workstream-naming.md`](workstream-naming.md)). A banner is what a group
carries to say what it is; that is exactly the job.

**Cause** — what the rally is for, **set by a person once they are inside it**.
Today this is `workstream.description` (aliased as `objective` in the desktop
directory model), and per
[`workstream-descriptions.md`](workstream-descriptions.md) it is almost never
authored: a generation loop keeps it true precisely because nobody writes one.
The authored path already exists (`update` in
`workstream-object-product.ts` marks a person's text `authored`). Naming it
*cause* promotes that path from an escape hatch to the intended act. **Open
question, recorded rather than answered:** whether the generation loop survives
as the provisional cause before a person sets one, or whether cause is
human-only and the generated text stays an internal routing/search field under a
different name. That is a product decision, not a rename.

**Flag** — one signal, not eight. Today
[`workstream-markers.md`](workstream-markers.md) ranks eight competing states
(five belonging to the run, three to the reader) through `MARKER_PRECEDENCE`,
with a design token per state. The decision here is to collapse that to a single
flag: *a flag has been raised in the marketing rally.* **This is a behaviour
change, not a rename** — it touches the ranking, the `sys.color.workstream`
token group, the per-state rules in `app.css`, and the accessible label every
state carries. It needs its own design pass, and it must not ride in on a
find-and-replace.

**Bring** — the verb for putting a Sidekick in a rally. Today a Sidekick is
*attached* or *loaded*. You bring your Sidekick to a rally. No new noun, a
better verb, and it explains the ownership split in
[`conversation-surfaces.md`](conversation-surfaces.md) for free: the Sidekicks a
rally owns, versus the ones somebody brought.

## What is deliberately not renamed

- **Workspace, project, message.** They were never unclear. A rename that
  reaches a working noun costs migration and teaches nobody anything.
- **Sidekick.** It names an *actor*, not a container, so it never competed with
  the container words — which is why this was hard until the two were
  separated. It is warm, differentiated, and already shipped. The word to
  retire in that family is **automation**, which at the time of this decision
  still outnumbers `sidekick` in the tree roughly two to one.
- **The Cloudflare account.** Worker, queue, bucket, and lakehouse names are out
  of scope, the same as in
  [`rally-rebrand-inventory.md`](rally-rebrand-inventory.md#2-cloudflare-infrastructure--out-of-scope-not-renamed).

### Stop before it gets cute

**Rally**, **breakout**, and **bring** are load-bearing: each replaces a name
that was actively confusing. **Banner**, **cause**, and **flag** are earned, and
each fixes a real ambiguity. That is the end of it.

Do not extend the metaphor to `participant`, `attachment`, `resource`, `run`, or
anything else because the theme permits it. Slack never renamed messages to
"slacks." A vocabulary that reaches every noun stops being a vocabulary and
becomes a bit, and users stop parsing it.

## Candidates considered and rejected

Kept so this is not re-argued from scratch. Occurrence counts are whole-word
matches across `apps/` and `packages/` at the time of the decision, and are
magnitudes rather than exact figures.

### For the container (now *rally*)

| Candidate | Why it lost |
| --- | --- |
| **room** | The strongest runner-up, and already the tree's informal word for the thing (`automation-do-protocol.ts`, `search-authorization-universe.ts`, Ace's retirement copy, `automation-lifecycle.md` all say "room" when a comment has to explain a work stream). Lost to finding 3: a room is a place you keep, and these are created and discarded constantly. |
| **channel** | Zero learning cost, but ~1,091 occurrences already mean a *Slack* channel (111 in `packages/connectors/src/slack.ts` alone), it imports the broadcast-pipe metaphor, and it implies DMs exist, which they do not. |
| **agent** | The insight that broke the problem open — it exposed that we had four words for one primitive. Rejected as the container word because it names the member, not the assembly: you would never say "add Sarah to the Northgate agent." |
| **team** | Names a standing group; you do not spin up four hundred teams. ~271 occurrences, mostly Linear and GitHub. |
| **brief / assignment / case / job** | Correctly named *the work*, which was the right insight, but none of them nests — "sub-brief" is not a word. Also `case` collides with ~1,151 switch statements. |
| **loop** | Accurate (the harness doc calls the primitive a loop), and it brings three usable idioms — loop someone in, in the loop, close the loop. Rejected as tonally flat for a multiplayer product: nobody joins a loop. |
| **branch** | Nests natively and is already the code's word for the operation (`branchProvenance` in `substream-launch.tsx`), but *branch* implies merging back, and a fork here never flows back into its parent. The name would be a lie. |
| **table** | Warm and collaborative, but ~2,829 occurrences meaning SQL tables makes it unusable as an identifier — a permanent split between what users say and what the schema says. |
| **workroom, desk, beat, lane, post, bench, front, studio** | Each either fights finding 3 (persistent places), needs a sentence of onboarding (*beat*), or is a synonym with nothing behind it. |

### For the child (now *breakout*)

| Candidate | Why it lost |
| --- | --- |
| **thread** | The obvious analogy, and wrong on the facts. A Slack thread is visible to the whole channel, shares history implicitly, and is a display grouping. A breakout is private by default, starts from a *frozen summary* of the parent, and is a separate agent with its own context and compaction. A thread is an attention device; a breakout is a context device. Also ~469 existing occurrences already mean Slack threads. |
| **huddle** | Semantically perfect — a small group stepping aside to confer, then rejoining. Slack owns the word as a shipped feature and we integrate with Slack. |
| **caucus** | Exactly right (a subset of an assembly meeting separately to decide something), but stacking a second political word on *rally* is too much. |
| **room** | Considered as the child once *rally* took the parent slot. A breakout is defined by its work, not by who is in it — and its participants are transient, so no room-of-people framing holds. |

## What implementation still has to decide

Not answered here, and each one is a real decision rather than a mechanical
substitution:

- **How deep the rename goes.** User-facing copy only, or stored D1 and Durable
  Object column values, wire contracts, route paths (`POST /workstreams`),
  branded id types in [`branded-ids.md`](branded-ids.md), and the
  `list_workstreams` / `list_substreams` MCP tool surface. These have different
  reversibility costs and should not be decided as one.
- **Compatibility.** Which old names stay accepted as aliases and for how long,
  in the same spirit as the already-shipped Avalon compatibility surfaces.
- **The two behaviour changes.** Single flag, and person-set cause. Both need a
  design pass independent of the rename, and neither should ship inside a
  find-and-replace commit.
- **Ordering.** Roughly fifteen documents carry an old term in their filename
  (`workstream-*.md`, `substream-creation.md`), which means the rename lands in
  `docs/README.md` as well as in prose.
- **The email domain and deep links.** Out of scope here;
  [`domain-migration.md`](domain-migration.md) is authoritative for both.

## Changelog

### 2026-09-16 — Work stream becomes rally, substream becomes breakout

**What changed:** The product's user-facing vocabulary was decided in full:
*rally*, *breakout*, *banner*, *cause*, *flag*, and *bring a Sidekick*, with
workspace, project, message, and Sidekick deliberately unchanged. This document
is new and records the decision and the argument. No code has moved.

**Why:** "Work stream" and "substream" name positions in a hierarchy rather than
things, so neither could be explained without a diagram. Underneath that, the
architecture had already collapsed to one primitive — every conversation is a
`SubstreamAgent` under a typed parent — while the vocabulary had grown four
names for it (`automation`, `agent`, `sidekick`, `substream`). The decisive
constraint turned out to be lifecycle rather than taste: because a work stream
is created before a model can name it, hundreds exist, which rules out every
standing-place and standing-group word. *Rally* is the only candidate that is
inherently plural in its people, singular as an object, disposable, and already
the product's name.

**Considered and rejected:** *Room*, which the codebase itself already uses
informally, lost because rooms are kept and these are discarded. *Agent* as the
container name lost because it erases the humans, though the idea is what
revealed the one-primitive-four-names problem. *Thread* for the child lost on
the facts — Slack threads are public, share context implicitly, and are a
display grouping, where a breakout is private, starts from a frozen summary, and
is a separate agent. *Branch* lost because it promises a merge that never
happens. The full table of losers is above, kept so this is not re-argued.

**Consequences:** Two of the new names carry product changes that are not
renames and must not ride in on one: a single **flag** replaces the eight ranked
marker states and their per-state design tokens, and **cause** promotes the
rarely used authored-description path to the intended act, which leaves the
generation loop in `workstream-description-service.ts` needing an explicit role.
The depth of the rename — copy only, versus stored values, wire contracts, route
paths, branded ids, and the MCP tool surface — is deliberately left open, since
those differ in how cheaply they can be reversed. This rename is independent of
the Avalon-to-Rally work in
[`rally-rebrand-inventory.md`](rally-rebrand-inventory.md); the two touch the
same files and should not be interleaved.
