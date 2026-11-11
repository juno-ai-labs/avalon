# Platform skills

Platform skills explain **how to use Rally itself**: configuring Sidekicks,
tracking work in Tables, publishing live sites, and using the in-app browser.
Keep each skill in its own TypeScript file here.

Skills for **doing requested work** belong in [`packages/skills/task-skills/`](../../../skills/task-skills/):
research, email, calendar events, external data, meeting notes, reports and apps.
A task skill can compose platform skills when it needs Rally's capabilities.
Choose the directory by what the skill teaches, not whether Rally ships it.

Standing policies stay in `../prompts/`; skill loading and registration stay in
`../skills.ts`. Neither belongs here. `../built-in-skills.ts` assembles the
default catalog; connection-specific skills are bound by the host.

See [Writing a skill](../../../../docs/writing-skills.md) for authoring guidance.
