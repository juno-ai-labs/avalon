import { renderWorkstreamSystemPrompt, type WorkstreamAutomationPromptContext } from "@avalon/agent-harness";
import type { AutomationDraft, Scope } from "@avalon/contracts";

/**
 * What a durable table's identifiers read as before the automation exists.
 *
 * A saved automation's memory tables are rows, and their ids are minted in the
 * same batch that writes the subscription. A draft has no subscription yet, so
 * the preview cannot know them and must not invent them: a fresh `newId()` per
 * request would render a different prompt every time the viewer opened it, and
 * a plausible-looking uuid would be a value someone could try to look up. The
 * placeholder says what it is instead.
 */
const UNASSIGNED_IDENTIFIER = "(assigned when this automation is created)";

/**
 * The system prompt a run of this draft would start from.
 *
 * It is rendered by the same `renderWorkstreamSystemPrompt` the run itself
 * uses, from the values `AutomationService.create` would persist, so the
 * preview cannot drift from the prompt as a second copy of the policy text
 * would. Everything a run resolves from its own row is derived here the way
 * creation derives it: the work stream a run opens takes its title and
 * objective from the automation's name and description, the first version of a
 * new automation is version 1, a saved automation starts with no subscription
 * overrides, and the execution authority follows the chosen scope.
 *
 * Three things are knowingly approximate. Durable-table identifiers do not
 * exist yet, per the constant above. A run's untrusted trigger evidence,
 * recalled memory, and loaded plugin catalog are user-role messages assembled
 * per run rather than part of the system prefix — they are not missing from
 * this preview, they are not in the system prompt at all. And the work stream's
 * title is the automation's name, which is what `AutomationService.createRun`
 * writes for a manual, scheduled, or email-opened run; a run opened by matching
 * connector activity titles its work stream `<automation>: <activity title>`
 * (`queues/activity-consumer.ts`), and no rendering here can know an activity
 * that has not happened. The objective, which carries the automation's meaning,
 * is the description in both.
 *
 * Everything that *is* derivable is derived the way the run derives it, not the
 * way the draft happens to be ordered — see `orderedDurableTables` below.
 */
export function renderAutomationDraftSystemPrompt(input: { draft: AutomationDraft; scope: Scope }): string {
  return renderWorkstreamSystemPrompt({
    title: input.draft.name,
    objective: input.draft.description,
    executionAuthority: input.scope === "workspace" ? "workspace" : "user",
    automation: {
      name: input.draft.name,
      versionNumber: 1,
      instructions: input.draft.instructions,
      expectedOutputs: input.draft.expectedOutputs,
      defaultBehavior: input.draft.defaultBehavior,
      overrides: {},
      durableTables: orderedDurableTables(input.draft.memoryTables),
    },
  });
}

/**
 * The durable tables as a run reads them back, not as the draft declares them.
 *
 * `loadAutomationMemoryTableContext` selects `ORDER BY name COLLATE NOCASE` and
 * rebuilds each `keyColumns` by filtering the table's columns — in stored column
 * position — down to the key ids. A draft that declares two tables in the other
 * order, or a composite key in an order its columns are not in, therefore runs
 * against a prompt this would not have predicted. Both are reproduced here so
 * the only differences left between preview and run are the ones the doc
 * comment above names.
 *
 * The sort compares lowercased names directly rather than through
 * `localeCompare`, because `COLLATE NOCASE` is ASCII case folding over code
 * units and a locale-aware comparison would reorder names it treats as
 * equivalent. Names outside ASCII can still order differently in the two, which
 * is a limit of predicting SQLite's collation rather than something to work
 * around here.
 */
function orderedDurableTables(
  memoryTables: AutomationDraft["memoryTables"],
): WorkstreamAutomationPromptContext["durableTables"] {
  return [...memoryTables]
    .sort((left, right) => {
      const leftName = left.name.toLowerCase();
      const rightName = right.name.toLowerCase();
      return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
    })
    .map((table) => {
      const keyNames = new Set(table.keyColumns.map((name) => name.toLocaleLowerCase()));
      const columns = table.columns.map((column) => ({
        memoryTableColumnId: UNASSIGNED_IDENTIFIER,
        name: column.name,
        description: column.description,
        type: column.type,
        required: column.required,
        searchable: column.searchable,
      }));
      return {
        memoryTableId: UNASSIGNED_IDENTIFIER,
        memoryScopeId: UNASSIGNED_IDENTIFIER,
        scopeKind: "automation" as const,
        name: table.name,
        description: table.description,
        usageInstructions: table.usageInstructions,
        // The column's own spelling, like the run's, rather than the one the
        // key list happened to use — the contract matches the two case-blind.
        keyColumns: columns
          .filter((column) => keyNames.has(column.name.toLocaleLowerCase()))
          .map((column) => column.name),
        columns,
      };
    });
}
