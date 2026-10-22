import type { HarnessSkill } from "./index";

/** Shared by independent runs that have authorized durable Tables access. */
export const TRACKING_SEEN_OR_DONE_ITEMS_SKILL: HarnessSkill = {
  name: "tracking-seen-or-done-items",
  description: "Give each Sidekick or other type of run a way to know what other runs have already seen or done. Keep a durable table with stable source keys, establish a baseline, overlap reads, and record completed work so later runs skip it.",
  whenToUse: "When configuring or executing a workflow whose runs need to know what other runs have seen or done. Every activation of a Sidekick gets its own independent run and conversation. Use this to track completed work or coordinate runs updating the same output.",
  ownerPlugin: "rally:tables",
  body: `Give each Sidekick (every activation of a Sidekick gets its own independent
run) or other type of run a way to know what other runs have already seen or done.
Instructions on how to keep a durable table with stable source keys, establish
a baseline, overlap reads, and record completed work so later runs skip it.

Shared files do not automatically record completed work and can be lost after a
reset or expiry. Keep those records in the durable table described here.

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

Include processing state and claim ownership as well as the source key. A row
that says work was discovered or claimed is different from one that records
successful completion. Save the ownership identifier supplied by the execution
context or tools so another run can distinguish its claim from yours.

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

## 4. Claim work before acting and mark completion after success

Read the relevant rows and skip work marked completed. For new candidates,
atomically insert rows with stable natural keys and a pending claim owned by
this execution. Act only on rows the insert result says **this call newly
inserted**. Querying an absent key is not a claim: another run can see the same
absence. A row skipped as an existing key is not yours to process.

After the external action succeeds, update the claimed row to completed and
record its result or success timestamp. Complete only a claim still owned by
this execution. Use the row ID and current revision
returned by a read for the revision-checked update. If an update conflicts,
reread the exact row and reconcile its ownership and state before proceeding.

Keep unfinished claims recoverable: an existing pending row is not completed
work. Reclaim it only after verifying the previous owner has stopped. Also
verify that the action did not succeed or that replay is safe using the same
provider idempotency key. Transfer ownership with a revision-checked update; only the
run whose update succeeds may retry. Never steal a claim merely because it is
old. If the owner or external outcome cannot be verified, leave it pending for
reconciliation and report that uncertainty rather than discarding it or
performing the action again. For safe retries, use a provider idempotency key
derived from the source item and intended action whenever the tool supports it.

Overlap the read window deliberately rather than asking for strictly-newer
items: a "since" argument alone drops anything that arrives late or shares a
timestamp with the last thing you saw. Let the table discard the overlap.

## Coordinate runs that update the same output

A claim on a source item does not prevent another run from processing a different
item into the same files or site. Before a multi-step update, claim one shared
coordination row keyed by the output's stable ID. Include state (available or
claimed), the owning run or agent ID, and its result.

On first use, insert the claimed row and proceed only if newly inserted. On
later uses, claim an available row with a revision-checked update. If another
run owns it, leave the source work pending: send the change to that owner or
arrange a retry after it finishes. Do not edit or publish concurrently. Reclaim
an abandoned row only after verifying its owner stopped and reconciling any
uncertain publication, using a revision-checked update. Release your own claim
back to available after the update settles; retain unfinished work for recovery.

For a site refresh, hold this claim across importing current source, editing,
checking, and publishing. Terminal's per-tool lease does not cover that sequence.

## 5. Establish the first-run baseline

When configuring the workflow, say what the **first** run does, because the table
is empty and everything looks new. For a polling backlog, record what predates
the watch's baseline without reporting it, unless the person asked to be caught
up. Label those rows as baseline items rather than successful external actions.
An event that triggered the first run is new work: process it normally even if
the table is empty. Silent baselining applies to the pre-existing backlog, not
the triggering event. Save that distinction in the workflow's baseline policy.

## Anti-patterns

- **A key column the run invents** — a row number, a hash of a summary, the
  time it was seen — or one that expires, like a signed URL. Use stable source
  identifiers that the next run can reconstruct.
- **Treating an inserted claim as completed work.** Claim before acting, then
  mark completion only after success; retain pending work for recovery.
- **Acting after only a read.** Two runs can both read an absent key. Act only
  after winning an atomic insert or a verified recovery claim.
- **Silently baselining the first triggering event.** Process that event;
  suppress only the pre-existing backlog covered by the baseline policy.`,
};
