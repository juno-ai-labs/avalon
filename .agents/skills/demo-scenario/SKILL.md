---
name: demo-scenario
description: Add a scenario to the demo workspace's seed pack from a plain-language description — a new work stream, a private side thread, a document, a Sidekick that has already run — and open the pull request for it. Use when someone invokes /demo-scenario, or describes something they want a freshly prepared demo workspace to already contain.
user-invocable: true
---

# Adding a scenario to the demo pack

Somebody has described, in ordinary words, something they want a freshly
prepared demo workspace to *already contain*: three colleagues arguing about a
decision, a document that goes through drafts, a private side thread, a Sidekick
that has already filed a briefing. Turn that into steps in the checked-in seed
pack, prove the pack is still playable, and open the pull request.

**Assume the person who asked does not read TypeScript, and do not make them.**
They own the scenario — who is in it, what they say, what Rally says back, how it
ends. You own everything else. Never ask them about a step kind, a role token, a
schema rule, a test, or a file; show them prose and keep the code to yourself.

## Read before you write

- [`docs/demo-workspaces.md`](../../../docs/demo-workspaces.md), the section
  **Seeding a demo from a pack**. It owns this feature and says why the pack is
  shaped as it is.
- The schema at the top of
  [`apps/api/src/services/demo-pack.ts`](../../../apps/api/src/services/demo-pack.ts),
  and `PLACEHOLDER_DEMO_PACK` at the bottom of the same file — the pack that
  ships. The existing scenarios are the register to write in.
- [`AGENTS.md`](../../../AGENTS.md) and
  [`docs/pull-requests.md`](../../../docs/pull-requests.md) before committing.

## The cast

Four roles, and the pack's prose names people by **role token** — `@{priya}` —
never by name, because the operator types a different name over each one for
every demo. A name written into the text would read as a stranger.

| Token | Opens as | Plays |
| --- | --- | --- |
| `presenter` | the real person signing in | the customer being presented to |
| `priya` | Emma Shipman | product |
| `marcus` | Sam Burton | sales |
| `dana` | Ben Diaz | legal |

**The presenter never speaks.** They are who the demo is waiting for, and a pack
that has them talking has them opening rooms — which changes what their home
screen shows and makes the readiness block below stop being derivable. Pull them
in with a mention instead.

Reuse the three personas unless a fourth person is genuinely the scenario. A new
role adds a field to the operator's New demo form and changes `apps/ace`'s tests
as well as everything below; say so before doing it.

## What they said, and what it is

| They say | The pack calls it | Step |
| --- | --- | --- |
| a conversation, a thread, a project | a work stream | `create_workstream` |
| a private side chat, taking it offline | a substream | `create_substream` |
| a doc, a draft, an attachment | an upload | `upload` |
| an automation, a bot, a daily thing | a Sidekick | `sidekick` |
| Rally answers, weighs in, sorts it out | `assistant: { kind: "say" }` |
| Rally asks them to pick | `assistant: { kind: "ask" }` |

Ask only what changes the work, in **one** `AskUserQuestion` batch, once:

1. Which of the three are in it, and who starts it.
2. Does it end with Rally answering, or with Rally asking the presenter to
   decide? (One room ending on a question is the demo's opening beat. The
   shipped pack already has one, in the renewal room — a second is a second
   thing waiting for the presenter, so confirm that is wanted.)
3. Is there a document, and does it go through versions?
4. Is anything said privately, away from the main thread?

Infer the rest, and say plainly what you inferred. If they gave you enough, do
not ask at all — write it and show them the words.

## Writing the steps

Add them to `PLACEHOLDER_DEMO_PACK.steps`. Position matters: the sidebar orders
rooms by the index of each room's **last main-conversation step**, so steps
appended at the end make the new room list first. Decide where the scenario
should sit in that order and say which you chose.

The schema refuses an unplayable pack before the first write. Write so you never
meet these:

- A room is created once, by `create_workstream`, before anything else in it.
- Only somebody already in a conversation may speak in it. A mention in a room's
  main conversation seats the person mentioned; a mention **inside a substream
  does not** — a substream's roster belongs to its parent, so anyone mentioned
  there must be listed in its `participants`.
- **One question per conversation, and nothing after it.** A room and each of
  its substreams count separately.
- Every `@{role}` must be in the cast — in a person's message, in Rally's own
  turn, in a Sidekick's description, overview, instructions or first run, and in
  a substream's starting context.
- A substream states its `participants` up front and never lists its creator. A
  substream of a `personal` room can only hold people already in that room.
- Two Sidekicks cannot share a name, and a Sidekick's `schedule` always names its
  `timezone`.
- Step `id`s are unique across the pack, lower-case, `[a-z0-9-]`, 80 characters
  at most. Name them after the room: `press-dana-1`.

**Every `assistant` turn is a real model-less run the seeder starts and then
waits to settle**, one at a time, before the next step. A reply on every line
makes an operator wait minutes longer to present. Give Rally the turns that
carry the scenario and let the people talk to each other for the rest.

### How Rally has to sound

A seeded run makes **no tool calls**. Rally has not read Drive, Linear, Granola,
mail or the web, and a turn that claims otherwise is fabricated history in a
transcript a customer is going to read.

- Every fact in Rally's turn must already be in that conversation's own messages.
  If a number matters, have a person say it first.
- Rally takes a position and shows the reasoning. It does not summarize what was
  just said back at the room.
- Short. Bold lead-ins for the two or three beats, as the shipped pack does.
- An `ask` is a real question addressed to the room: a prompt naming what is
  unresolved and who wants what, plus two to four concrete options.

## The readiness block, which you must not reason out by hand

`expect` states what the presenter's home screen and sidebar should show once the
demo is prepared. It is not decoration: the operator's demo stays in **Waiting
for workspace** until reality matches it, so a wrong flag is a demo that never
becomes Ready and no test that fails.

Do not derive it yourself. Let the code do it:

1. Write the steps. Leave `expect` alone.
2. Run the three suites under **Verify** below.
3. The schema refuses the pack until `expect` names exactly the rooms the
   presenter will see — most of `demo-operations.test.ts` fails with a
   `ZodError` naming the room that is missing. Add the room with any flags.
4. The test *"expects of the presenter exactly what an idle viewer's flags
   derive to"* now fails with a diff of the whole block. **Its `- Expected`
   side is the correct block** — the pack is what is under test and the
   derivation is the answer. Copy those values in and re-run until green.

`demoIdleViewerExpectation` in `demo-pack.ts` is what computes it, and its
comment says which rule each flag comes from. A **substream contributes nothing**
— it takes no sidebar row and seats nobody in its parent — so a scenario that
only adds a private side thread leaves `expect` untouched.

## The files a scenario touches

| File | What to change |
| --- | --- |
| `apps/api/src/services/demo-pack.ts` | The steps, the `expect` block, and the doc comment above `PLACEHOLDER_DEMO_PACK` that lists what the pack carries. |
| `apps/api/test/demo-pack.test.ts` | `accepts the placeholder pack` hard-codes the room keys, the id of every `ask`, every Sidekick's name/scope/zone, and every substream. Extend those lists. |
| `apps/api/test/demo-readiness.test.ts` | A new room needs an id in `WORKSTREAM_IDS`; `derives the presenter's view of the placeholder pack` asserts the room order, each room's participants, attachments and closing state. |
| `docs/demo-workspaces.md` | The prose naming the pack's scenarios, and a changelog entry. |

Nothing under `apps/api/test-workers/` reads the shipped pack — those suites use
their own miniature packs — so a scenario change does not reach them. Adding a
**role** reaches `apps/ace`, and so does bumping the version below.

### Bumping the pack version

`PLACEHOLDER_DEMO_PACK.version` is recorded on every demo operation when it
starts, and `checking_template` refuses an operation whose recorded version is
not the one now deployed (`demo_pack_changed`). So changing the pack's contents
under the same version lets a demo that was already being prepared resume onto
half of the new pack; bumping it stops that demo loudly instead, and the
operator starts a fresh one — a matter of minutes.

**Bump it.** Three literals in `apps/ace/test/demos.test.ts` and
`apps/ace/test/demos-client.test.tsx` name the version and change with it; run
`pnpm --filter @rally/ace test` after. What the new version should be *called*
is the team's to say, not yours — propose one, and ask if nobody has.

## Verify

```bash
pnpm --filter @rally/api exec vitest run \
  test/demo-pack.test.ts test/demo-readiness.test.ts test/demo-operations.test.ts \
  &> /tmp/demo-pack.log
pnpm lint
pnpm typecheck
```

`demo-operations.test.ts` is in the list because it parses the shipped pack: if
most of it fails with a `ZodError`, the pack itself is refused and the message
names the rule you broke. Delete the log when done.

Read the scenario back once as a customer would — the whole room, in order,
including Rally's turns — before calling it done.

## Documenting it

`docs/demo-workspaces.md` owns this module, so per
[`docs/module-documents.md`](../../../docs/module-documents.md) the change lands
with a changelog entry at the top of that document's changelog, newest first. Say
what the pack now carries and **what the demo could not show without it** —
that pressure is the *why*, and "added a scenario" is not one. Update the
sentence in the same document that lists the pack's scenarios, or it goes stale
the moment this merges.

## Opening the pull request

Follow [`docs/pull-requests.md`](../../../docs/pull-requests.md): the required
sections, ready for review, never a draft. In the **Summary**, lead with what a
presenter will now find in a fresh demo, not with the files. Quote a line or two
of the scenario — the description is where a reviewer judges the words, and the
words are the change.

## Reporting back

Answer in plain language, no code and no file names:

- What a demo prepared from this pack will now contain, room by room.
- What the presenter sees first, and what is waiting for them.
- Anything you inferred that they should overrule.
- The pull request link.
