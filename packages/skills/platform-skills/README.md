# Platform skills

Platform skills explain **how to use Rally itself**: configuring Sidekicks,
tracking work in Tables, publishing reactive sites and feeds, and using the
in-app browser. Keep each skill in its own TypeScript file here, and export it
from [`index.ts`](index.ts).

Skills for **doing requested work** belong in [`../task-skills/`](../task-skills/):
research, email, calendar events, external data, meeting notes, reports, apps
and podcast episodes. A task skill can compose platform skills when it needs
Rally's capabilities. Choose the directory by what the skill teaches, not
whether Rally ships it.

Every skill lives in this package; none lives in the harness. Standing policies
stay in [`@rally/prompts`](../../prompts/); skill loading and registration stay
in the harness's [`skills.ts`](../../agent-harness/src/skills.ts), and its
[`built-in-skills.ts`](../../agent-harness/src/built-in-skills.ts) assembles the
default catalog from what this package exports. Connection-specific skills are
bound by the host.

A skill here imports only from this package (`HarnessSkill` from
[`../types.ts`](../types.ts)) and `@rally/contracts`, never from the harness:
the harness depends on this package, so the reverse would be a cycle.

See [Writing a skill](../../../docs/writing-skills.md) for authoring guidance.
