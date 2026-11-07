# Demo presenter guide

You present as **Maya**, signed in as yourself; the demo's other two people
are **Theo** (finance) and **Priya** (engineering), cast as colleagues or as
personas who cannot sign in. The Organization opens on the Canvases home, the
way the [Canvases and Sidekicks mockup](PRDs/2026-11-06_canvases-and-sidekicks/design.html)
draws it. Choose the story from discovery: start with the Q4 revenue review by
default, then show at most one other matched to the prospect's pain. These are
presentation guidance, not measured popularity. Do not put the discovery
questions or this table into the demo's Canvases.

| Pain | Where to open | What the presenter shows |
| --- | --- | --- |
| Shared work with an AI that everyone can see and steer | **Q4 revenue review** (Canvas, Maya and Theo) | Maya asked Rally for the board draft; Theo asked for churn from the October cohort, and Rally published version 2 of the review with it. The versions menu shows v1 and v2. Theo's last line keeps the three accounts board-only. Continue by asking Rally for a change and watch version 3 land. |
| Planning across a team | **Launch plan** (Canvas, the whole Organization) | Theo's plan with owners and a December 3 launch; Priya attached the billing migration checklist and Rally confirmed the dates still hold. Open to everyone, so it is unread to Maya until she opens it. |
| Repetitive reports | **Weekly changelog** (Sidekick, the Organization) and **Weekly changelog · Nov 6** (its Canvas) | A published Sidekick on a Friday 2 PM schedule, with one run in its conversation and the changelog Canvas that run wrote. **Open run** shows the run's own conversation. |
| Watching for things that break | **Incident triage** (Sidekick, shared with Maya, Theo and Priya) | Its morning run reported a rolled-back deploy; Priya took the fix in the Sidekick's conversation. Ask it something there to start the next run. |

Maya speaks first in the Q4 review and nowhere else. Nothing ends in an
artificial pending question: every seeded run completed, and the presenter can
continue normally.

Business names, figures and the changelog are fictional. Personas cannot sign
in. No real customer or guest is seeded.

## Demonstration boundaries

- **Audience:** the Q4 review is shared with Theo alone; Launch plan and the
  Weekly changelog are Organization-wide; Incident triage is shared with the
  three named people, and so is nothing else. No external guest is seated.
- **Artifacts:** each version is a real publication through Rally's publish
  path, attributed to the run that announced it, not an upload pretending to
  be one. A seeded run makes no tool call, so the version is published right
  after the run rather than from inside it.
- **Sidekicks:** both are real published Sidekicks with real schedules and one
  seeded run each, answered from the pack rather than a model. No connector is
  bound: the changelog's contents and the overnight alert are illustrative,
  and the first scheduled run is the demo's own and must say when it has no
  source.

## Changelog

### 2026-11-07 — The guide follows the Canvases and Sidekicks pack

The stories are now the mockup's Canvases and Sidekicks — Q4 revenue review,
Launch plan, Weekly changelog and Incident triage, with Maya, Theo and Priya —
replacing the Acme, vendor-selection and call-review Channels and their
Breakouts. Why: the pack was rewritten around the two modes when Threads,
Channels and Breakouts were retired
([`demo-workspaces.md`](demo-workspaces.md#2026-11-07--the-pack-seeds-canvases-and-sidekicks)),
and a guide that sends the presenter to a Channel sends them nowhere.
