const DEFAULT_PLUGIN_CATALOG_TOKENS = 2_500;

export function normalizedPluginSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
}

export interface PromptPluginSummary {
  pluginId: string;
  description: string;
  displayName?: string;
  searchAliases?: readonly string[];
}

export interface RenderPromptPluginCatalogInput {
  activePluginIds: ReadonlySet<string>;
  plugins: readonly PromptPluginSummary[];
  availableHeading?: string;
  maxCatalogTokens?: number;
}

function pluginLine(plugin: PromptPluginSummary): string {
  const metadata = [
    plugin.displayName && plugin.displayName !== plugin.pluginId
      ? plugin.displayName
      : null,
    plugin.searchAliases?.length
      ? `aliases: ${plugin.searchAliases.join(", ")}`
      : null,
  ].filter((value): value is string => Boolean(value));
  return `- ${plugin.pluginId}${metadata.length ? ` (${metadata.join("; ")})` : ""}: ${plugin.description}`;
}

/**
 * Render the compact plugin directory placed in an agent system prompt.
 *
 * This follows Monad's active/loadable catalog shape while keeping Avalon's
 * model-facing IDs and per-run authorization boundary. Active entries are
 * always retained; the non-active directory is bounded by the configured
 * catalog budget and can be recovered in full through Avalon's discovery
 * tools.
 */
export function renderPromptPluginCatalog(input: RenderPromptPluginCatalogInput): string {
  const unique = new Map<string, PromptPluginSummary>();
  for (const plugin of input.plugins) {
    if (!unique.has(plugin.pluginId)) unique.set(plugin.pluginId, plugin);
  }
  const plugins = [...unique.values()].sort((left, right) =>
    left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0);
  if (!plugins.length) return "";

  const active = plugins.filter((plugin) => input.activePluginIds.has(plugin.pluginId));
  const available = plugins.filter((plugin) => !input.activePluginIds.has(plugin.pluginId));
  const sections: string[] = [];

  if (active.length) {
    sections.push(`Currently active:\n${active.map(pluginLine).join("\n")}`);
  }

  if (available.length) {
    const maxChars = Math.max(256, (input.maxCatalogTokens ?? DEFAULT_PLUGIN_CATALOG_TOKENS) * 4);
    const bounded: string[] = [];
    let used = 0;
    for (const plugin of available) {
      const line = pluginLine(plugin);
      if (used + line.length + 1 > maxChars) break;
      bounded.push(line);
      used += line.length + 1;
    }
    if (bounded.length) {
      const omitted = available.length - bounded.length;
      if (omitted > 0) {
        bounded.push(`- … ${omitted} more; use list_plugins or search_plugins to inspect them.`);
      }
      sections.push(`${input.availableHeading ?? "Available to load:"}\n${bounded.join("\n")}`);
    }
  }

  return sections.join("\n\n");
}
