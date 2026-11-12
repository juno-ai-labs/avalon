/** The `# Plugins` system-prompt section: how to load a plugin, then the rendered catalog. */
export function renderPluginCatalogSection(catalog: string): string {
  return `# Plugins\nPlugins are groups of related typed tools. Currently active plugins are ready to use. To activate an available plugin, call load_plugin with the exact plugin id. Once loaded, its tools are available on the next model turn. Loading never expands this run's original authority. An available plugin is part of this run's capability, not a suggestion: read this list before concluding that something cannot be looked up, because the tools you can see right now are only the ones already loaded.\n\n${catalog}`;
}
