import type { RegistrablePlugin } from "./tool";

/**
 * A plugin registry, created as a **factory rather than a module singleton**.
 *
 * Monad's original registry was a module-level `Map` populated by
 * self-registration at import time. That is workable in a long-lived Node
 * process but wrong for a package targeting workerd isolates (module state is
 * per-isolate and its lifetime is not the host's) and it makes tests share
 * state implicitly. A host that wants the singleton ergonomics can still wrap
 * one instance in a module — the choice moves to the host, which is where it
 * belongs.
 */

export interface PluginSummary {
  name: string;
  description: string;
  isCorePlugin: boolean;
}

export interface ToolRegistryOptions<TPlugin extends RegistrablePlugin> {
  /**
   * Always-active plugins, loaded on every run without explicit activation.
   */
  corePlugins: readonly string[];
  /**
   * Compatibility aliases for historical plugin names, mapping an old name to
   * the current canonical one. Persisted activation state stores names, so an
   * alias is how a rename avoids silently stripping capabilities from live
   * sessions without a data migration. Entries are permanent.
   */
  aliases?: Readonly<Record<string, string>>;
  /**
   * Called after a plugin is registered. The seam for host-side side effects
   * of registration (e.g. contributing a plugin's skills into a separate
   * registry) without the harness knowing what those are.
   */
  onRegister?: (plugin: TPlugin) => void;
}

export interface ToolRegistry<TPlugin extends RegistrablePlugin> {
  register(plugin: TPlugin): void;
  /** Resolve by name (following aliases); `undefined` when absent or unavailable. */
  get(name: string): TPlugin | undefined;
  /** The canonical registered name for `name`, following any alias. */
  canonicalizeName(name: string): string;
  corePlugins(): string[];
  isCoreName(name: string): boolean;
  /** Every registered plugin, including currently-unavailable ones. */
  all(): TPlugin[];
  /** Summaries of available plugins only. */
  summaries(): PluginSummary[];
  /** Names of available plugins — the single source of truth for "what exists". */
  availableNames(): string[];
}

export function createToolRegistry<TPlugin extends RegistrablePlugin>(
  options: ToolRegistryOptions<TPlugin>,
): ToolRegistry<TPlugin> {
  const plugins = new Map<string, TPlugin>();
  const core = [...new Set(options.corePlugins)];
  const coreSet = new Set(core);
  const aliases = options.aliases ?? {};

  // Own-property check, not `aliases[name] ?? name`: a bare index reads
  // through Object.prototype, so a lookup of "constructor" or "toString"
  // returns an inherited function instead of the name. Hosts supply arbitrary
  // alias maps, and a plugin may legitimately be named either.
  //
  // The `typeof` check is not redundant with the declared type: a host may
  // build its alias map from JSON or another untyped source, and this function
  // is a hard invariant — every caller downstream treats the result as a
  // string. Falling back to the input beats returning a lie.
  const canonicalizeName = (name: string): string => {
    if (!Object.prototype.hasOwnProperty.call(aliases, name)) return name;
    const alias = aliases[name];
    return typeof alias === "string" ? alias : name;
  };
  const isAvailable = (plugin: TPlugin): boolean =>
    plugin.isAvailable?.() ?? true;

  return {
    register(plugin) {
      plugins.set(plugin.name, plugin);
      options.onRegister?.(plugin);
    },
    get(name) {
      const plugin = plugins.get(name) ?? plugins.get(canonicalizeName(name));
      return plugin && isAvailable(plugin) ? plugin : undefined;
    },
    canonicalizeName,
    corePlugins() {
      return [...core];
    },
    isCoreName(name) {
      return coreSet.has(name);
    },
    all() {
      return [...plugins.values()];
    },
    summaries() {
      return [...plugins.values()].filter(isAvailable).map((plugin) => ({
        name: plugin.name,
        description: plugin.description,
        isCorePlugin: coreSet.has(plugin.name),
      }));
    },
    availableNames() {
      return [...plugins.values()]
        .filter(isAvailable)
        .map((plugin) => plugin.name);
    },
  };
}
