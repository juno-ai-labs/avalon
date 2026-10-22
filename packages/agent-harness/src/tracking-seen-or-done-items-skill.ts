import type { HarnessSkill } from "./index";

/** Shared by independent runs that have authorized durable Tables access. */
export const TRACKING_SEEN_OR_DONE_ITEMS_SKILL: HarnessSkill = {
  name: "tracking-seen-or-done-items",
  description: "Give each Sidekick or other type of run a way to know what other runs have already seen or done. Keep a durable table with stable source keys, establish a baseline, overlap reads, and record completed work so later runs skip it.",
  whenToUse: "When configuring or executing a workflow whose runs need to know what other runs have seen or done. Every activation of a Sidekick gets its own independent run; use this for Sidekicks and other workflows that need shared state across runs.",
  ownerPlugin: "rally:tables",
  body: `Give each Sidekick (every activation of a Sidekick gets its own independent
run) or other type of run a way to know what other runs have already seen or done.
Instructions on how to keep a durable table with stable source keys, establish
a baseline, overlap reads, and record completed work so later runs skip it.

## Terms used in this skill

- **Memory table:** A typed, durable collection of rows shared by authorized
  runs, such as processed document IDs or the last published snapshot.
  Rows are read through the Tables plugin rather than loaded automatically
  into the conversation.
- **Natural key:** The columns whose values identify one source item across
  runs. Two sightings with the same key refer to the same item.

## 1. Load the Tables plugin

Load the **Tables** plugin (\`rally_tables\`) before using this procedure. If it
is already active, use its tools directly. Loading this skill supplies
instructions; it does not activate tools or load table rows into the conversation.

## 2. Choose stable keys and a scope shared by the runs

Choose \`keyColumns\` from the item's own stable identity in the source — a
message id, a meeting id, an issue key — never a value the run makes up and never one that
expires, because a later run has to rebuild the same value from the outside
world. Every key column has to be one of the table's declared \`columns\` as
well. Rows deduplicate on those columns, which is what makes a second sighting
cheap to ignore.

Choose the narrowest authorized scope that all relevant runs share. Set
\`scopeKind: "sidekick"\` for activations of the same installed Sidekick,
\`workstream\` for runs in one thread, \`user\` for workflows shared by one
person, or \`workspace\` for workflows shared across the organization. Scope
selection does not grant access; use only kinds the run is authorized to use.

When configuring a Sidekick's own table, declare it in the draft's
\`memoryTables\`; those declarations create tables in that Sidekick's scope.
For any workflow, save the chosen scope, table declaration, baseline policy and
processing steps in durable workflow instructions so later runs can find them.
A later run follows those instructions rather than relying on an earlier run's
conversation.

## 3. Find or create the shared table

Publishing a Sidekick with triggers creates or reopens its declared
\`memoryTables\`. Other workflows create the table when they first need it.
Search by the declared table name or purpose, choose the result in the intended
shared scope, copy its \`memoryTableId\`, describe its schema and usage
instructions, and query only the rows and columns needed for this run. There
is no separate table-loading step. If the table does not exist yet, create it
in the chosen shared scope with the saved name, description, usage instructions,
columns and key columns, then use the returned \`memoryTableId\`. Later runs
find and reuse that table instead of creating one per run.

## 4. Skip completed items and record successful work

Read the table first, fetch what the connection reports since a little before
the last recorded item, skip anything already recorded, act on the rest, and
record each item **after** it has been acted on — the other order loses an item
to any run that fails midway.

Overlap the read window deliberately rather than asking for strictly-newer
items: a "since" argument alone drops anything that arrives late or shares a
timestamp with the last thing you saw. Let the table discard the overlap.

## 5. Establish the first-run baseline

When configuring the workflow, say what the **first** run does, because the table
is empty and everything looks new: record what is already there and report
nothing, unless the person asked to be caught up. A run follows that saved
baseline policy rather than treating the whole backlog as new work.

## Anti-patterns

- **A key column the run invents** — a row number, a hash of a summary, the
  time it was seen — or one that expires, like a signed URL. Use stable source
  identifiers that the next run can reconstruct.
- **Recording an item before acting on it.** A run that fails after recording
  has silently dropped it. Record last.`,
};
