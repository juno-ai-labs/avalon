import { renderWorkstreamSystemPrompt } from "@avalon/agent-harness";
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
 * Two things are knowingly approximate, and both are named in the surface that
 * shows this. Durable-table identifiers do not exist yet, per the constant
 * above. And a run's untrusted trigger evidence, recalled memory, and loaded
 * plugin catalog are user-role messages assembled per run rather than part of
 * the system prefix — they are not missing from this preview, they are not in
 * the system prompt at all.
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
      durableTables: input.draft.memoryTables.map((table) => ({
        memoryTableId: UNASSIGNED_IDENTIFIER,
        memoryScopeId: UNASSIGNED_IDENTIFIER,
        scopeKind: "automation" as const,
        name: table.name,
        description: table.description,
        usageInstructions: table.usageInstructions,
        keyColumns: table.keyColumns,
        columns: table.columns.map((column) => ({
          memoryTableColumnId: UNASSIGNED_IDENTIFIER,
          name: column.name,
          description: column.description,
          type: column.type,
          required: column.required,
          searchable: column.searchable,
        })),
      })),
    },
  });
}
