import { auditToolsInPlace, auditedToolCall, auditedTools, type StorageNameAuditOptions } from "@rally/contracts/model-names-audit";

import { __integrationTesting } from "../../src/services/integrations";

/**
 * Rally's core tools, each walking what it returns for a storage name
 * (`docs/agent-tools.md`, rule 10). A suite that builds its tools through
 * this proves, with every call it already makes, that the result a model
 * reads says Canvas, Sidekick and Organization and never the stored word.
 *
 * Fixture prose is a person's data, so a retired product word in a sentence
 * (a title that says "project") is not a finding here; a key, an enum value
 * and a storage name anywhere still are.
 */
export const AUDIT_FIXTURE_PROSE: StorageNameAuditOptions = { dataProse: true };

export function auditedAvalonTools(...args: Parameters<typeof __integrationTesting.createAvalonTools>) {
  return auditedTools(__integrationTesting.createAvalonTools(...args), AUDIT_FIXTURE_PROSE);
}

/** Any tools, audited as fixture-driven suites need them. */
export function audited<Tool extends Parameters<typeof auditedTools>[0][number]>(tools: readonly Tool[]): Tool[] {
  return auditedTools(tools, AUDIT_FIXTURE_PROSE);
}

/** A plugin whose tools are audited; `null` stays `null`. */
export function auditedPlugin<Plugin extends { tools: Parameters<typeof auditedTools>[0][number][] } | null>(plugin: Plugin): Plugin {
  return plugin === null ? plugin : { ...plugin, tools: audited(plugin.tools) };
}

/** Executors keyed by tool name (Terminal's), each audited. */
export function auditedExecutors<Executors extends Record<string, (...args: never[]) => Promise<{ output: unknown }>>>(executors: Executors): Executors {
  return Object.fromEntries(Object.entries(executors).map(([name, execute]) => [
    name,
    (...args: never[]) => auditedToolCall(name, () => execute(...args), AUDIT_FIXTURE_PROSE),
  ])) as Executors;
}

/**
 * A run's whole tool surface, as `loadHarnessTools` builds it, with every
 * tool audited. In place, because the host knows a refusing tool by the
 * object it is, and the surface was built for this caller alone.
 */
export async function auditedHarnessTools(...args: Parameters<typeof __integrationTesting.loadHarnessTools>) {
  const loaded = await __integrationTesting.loadHarnessTools(...args);
  const every = new Set([...loaded.tools, ...loaded.plugins.flatMap((plugin) => plugin.tools),
    ...loaded.corePlugins.flatMap((plugin) => plugin.tools)]);
  auditToolsInPlace([...every], AUDIT_FIXTURE_PROSE);
  return loaded;
}
