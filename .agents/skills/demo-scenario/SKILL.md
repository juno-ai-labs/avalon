---
name: demo-scenario
description: Add a scenario to the demo workspace's seed pack from a plain-language description — a new Canvas with its conversation and artifact versions, a document someone attaches, a Sidekick that has already run and written its Canvas — and open the pull request for it. Use when someone invokes /demo-scenario, or describes something they want a freshly prepared demo workspace to already contain.
user-invocable: true
---

# Adding a scenario to the demo pack

Somebody has described, in ordinary words, something they want a freshly
prepared demo workspace to *already contain*: two colleagues working on a
report with Rally, a plan that goes through versions, a document someone
attached, a Sidekick that has already run and written its weekly Canvas. Turn
that into steps in the checked-in seed pack, prove the pack is still playable,
and open the pull request.

**Assume the person who asked does not read TypeScript, and do not make them.**
They own the scenario — who is in it, what they say, what Rally says back, what
it publishes, how it ends. You own everything else. Never ask them about a step
kind, a role token, a schema rule, a test, or a file; show them prose and keep
the code to yourself.

## Read before you write

- [`docs/demo-workspaces.md`](../../../docs/demo-workspaces.md), the section
  **Seeding a demo from a pack**. It owns this feature and says why the pack is
  shaped as it is.
- [`docs/canvases.md`](../../../docs/canvases.md) for who can open a Canvas and
  how its artifacts version, and
  [`docs/automation-lifecycle.md`](../../../docs/automation-lifecycle.md#the-shared-conversation)
  for a Sidekick's shared conversation and its runs.
- The schema at the top of
  [`apps/api/src/services/demo-pack.ts`](../../../apps/api/src/services/demo-pack.ts),
  and `PLACEHOLDER_DEMO_PACK` at the bottom of the same file — the pack that
  ships. The existing scenarios are the register to write in.
- [`docs/pull-requests.md`](../../../docs/pull-requests.md) before committing.

## The cast

Three roles, and the pack's prose names people by **role token** — `@{priya}` —
never by name, because a different colleague is cast into each part for every
demo. A name written into the text would read as a stranger. A token is written
as the person's display name; it is not a mention and seats nobody.

| Token | Labelled | Plays |
| --- | --- | --- |
| `presenter` | — | Maya: the real person signing in, who is showing the demo |
| `theo` | Finance lead | the numbers and the plans |
| `priya` | Engineering lead | the systems, the incidents, the migrations |

The **label** is `roleLabels[token]`, and it is what the New demo form titles
that part's dropdown; a colleague put in the wrong part has the pack's scripted
words attributed to them under their real name
([`docs/demo-workspaces.md`](../../../docs/demo-workspaces.md#casting-a-demo)).

**The presenter speaks only where the scenario is theirs.** In the shipped pack
Maya opens the Q4 review and says nothing else. Whatever the presenter has not
made or written in is unread to them when the demo opens, which is the point of
the demo; every line they speak takes that away for that Canvas.

Reuse the parts unless another person is genuinely the scenario. A new role
needs a label, adds a dropdown to the operator's New demo form, changes
`apps/ace`'s tests, and raises the number of colleagues a demo cannot be
prepared without; say so before doing it.

## What they said, and what it is

| They say | The pack calls it | Step |
| --- | --- | --- |
| a conversation, a project, a doc we work on with Rally | a Canvas | `create_canvas` (title, who made it, `sharedWith`, an optional first `prompt`) |
| somebody says something there | a Canvas message | `canvas_message` |
| Rally writes, updates or publishes the doc | an artifact version | `canvas_artifact` (the same `path` again is the next version) |
| somebody attaches a file | an upload | `upload` |
| an automation, a bot, a weekly thing | a Sidekick | `sidekick` (`sharedWith`, a schedule, `firstRun`, and its `canvas`) |
| somebody replies to the Sidekick | a Sidekick message | `sidekick_message` |
| shared with everyone | `sharedWith: "organization"` | |
| shared with some people | `sharedWith: ["theo"]` (never the creator) | |
| private | `sharedWith: []` | |
| Rally answers, weighs in, sorts it out | `assistant: { kind: "say" }` | |
| Rally asks them to pick | `assistant: { kind: "ask" }` | |

There is no Thread, Channel, Breakout, Space, room or private side thread any
more: those surfaces are retired. Somebody who asks for "a private side chat"
wants a Canvas shared with the two of them.

Ask only what changes the work, in **one** `AskUserQuestion` batch, once:

1. Who is in it, who starts it, and is it shared with everyone or a few people?
2. Does it end with Rally answering, or with Rally asking the presenter to
   decide? (The shipped pack ends nothing on a question; a question changes
   what the presenter's demo opens on, so confirm it is wanted.)
3. Does Rally publish a document, and does it go through versions?
4. Is there a Sidekick, and should it have already run and written its Canvas?

Infer the rest, and say plainly what you inferred. If they gave you enough, do
not ask at all — write it and show them the words.

## Writing the steps

Add them to `PLACEHOLDER_DEMO_PACK.steps`. Position matters only for reading:
the Canvas list orders by when each Canvas's Chat last moved, which the
seeding order decides but the readiness check does not compare.

The schema refuses an unplayable pack before the first write. Write so you never
meet these:

- A Canvas is made once, by `create_canvas`, before anything else in it; a
  Sidekick is published once, by `sidekick`, before any `sidekick_message`.
- Canvas and Sidekick keys share one namespace: two cannot have the same key.
- Only somebody the Canvas or Sidekick is shared with may speak in it — its
  creator, anyone in its `sharedWith`, or anyone at all for `"organization"`.
- `assistant` on `create_canvas` needs a `prompt` to answer.
- A `canvas_artifact` needs Rally to have run in that Canvas already — a
  `create_canvas` or `canvas_message` with an `assistant` before it — because
  the version is attributed to that run. Put it right after the turn where
  Rally says it published.
- A Sidekick's `canvas` needs a `firstRun`, which is a `say`; its `schedule`
  always names its `timezone`; two Sidekicks cannot share a name.
- **One question per Canvas, and nothing after it.**
- A `sidekick_message` starts no run: the people there talk to each other.
- Every `@{role}` must be in the cast — in any message, Rally's turns, an
  artifact's or upload's content, and a Sidekick's prose.
- Step `id`s are unique across the pack, lower-case, `[a-z0-9-]`, 80
  characters at most. Name them after the Canvas: `launch-v2`.
- The pack's `verify` list names who the readiness check reads the demo as;
  keep it `["presenter"]`.

**Every `assistant` turn and every Sidekick `firstRun` is a real model-less
run the seeder starts and then waits to settle**, one at a time. A reply on
every line makes an operator wait minutes longer to present. Give Rally the
turns that carry the scenario and let the people talk to each other for the
rest.

### How Rally has to sound

A seeded run makes **no tool calls**. Rally has not read Drive, Linear,
Granola, mail or the web, and a turn that claims otherwise is fabricated
history in a transcript a customer is going to read.

- Every fact in Rally's turn must already be in that Canvas's own messages. If
  a number matters, have a person say it first.
- An artifact's content says what Rally's turn said it would; nothing more.
- Rally takes a position and shows the reasoning. It does not summarize what
  was just said back at the people.
- Short. An `ask` is a real question: a prompt naming what is unresolved, plus
  two to four concrete options.

## Readiness, which you do not write by hand

The operator's demo stays in **Waiting for workspace** until the presenter's
Canvas and Sidekick lists, and each Canvas's artifacts and Chat, match what
the steps say. The barrier derives all of it from the steps and the receipts;
there is no block to author. What you check instead is that the shipped pack's
test still describes it.

## The files a scenario touches

| File | What to change |
| --- | --- |
| `apps/api/src/services/demo-pack.ts` | The steps, and the doc comment above `PLACEHOLDER_DEMO_PACK` that lists what the pack carries. |
| `apps/api/test/demo-pack.test.ts` | `accepts the placeholder pack` names the Canvases and Sidekicks the presenter is offered and the review's versions. Extend those lists. |
| `apps/api/test/demo-readiness.test.ts` | `derives the presenter's view of the placeholder pack` asserts each Canvas with its `unread`, artifacts and state, and each Sidekick with its audience. |
| `docs/demo-workspaces.md` | The prose naming the pack's scenarios, and a changelog entry. |
| `docs/demo-presenter-guide.md` | The table row a presenter opens the scenario from. |

Nothing under `apps/api/test-workers/` reads the shipped pack — those suites use
their own miniature packs. Adding a **role** reaches `apps/ace`, and so does
bumping the version below.

### Bumping the pack version

`PLACEHOLDER_DEMO_PACK.version` is recorded on every demo operation when it
starts, and every phase refuses an operation whose recorded version is not the
one now deployed (`demo_pack_changed`). **Bump it.** The literals in
`apps/ace/test/demos.test.ts` and `apps/ace/test/demos-client.test.tsx` name the
version and change with it; run `pnpm --filter @rally/ace test` after. What the
new version should be *called* is the team's to say — propose one, and ask if
nobody has.

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

Read the scenario back once as a customer would — the whole Canvas, in order,
Rally's turns and each artifact version included — before calling it done.

## Documenting it

`docs/demo-workspaces.md` owns this module, so per
[`docs/module-documents.md`](../../../docs/module-documents.md) the change lands
with a changelog entry at the top of that document's changelog. Say what the
pack now carries and **what the demo could not show without it** — that
pressure is the *why*, and "added a scenario" is not one.

## Opening the pull request

Follow [`docs/pull-requests.md`](../../../docs/pull-requests.md): the required
sections, ready for review, never a draft. In the **Summary**, lead with what a
presenter will now find in a fresh demo, not with the files. Quote a line or two
of the scenario — the words are the change.

## Reporting back

Answer in plain language, no code and no file names:

- What a demo prepared from this pack will now contain, Canvas by Canvas and
  Sidekick by Sidekick.
- What the presenter sees first, and what is unread for them.
- Anything you inferred that they should overrule.
- The pull request link.
