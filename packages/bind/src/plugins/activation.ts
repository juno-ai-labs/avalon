import type { PluginSummary } from "./registry";

/**
 * Progressive tool disclosure: which plugins are loaded right now, and how a
 * persisted set is restored across a run boundary.
 *
 * Two-tier disclosure exists because tool-selection accuracy degrades once a
 * model sees more than a few dozen tools, and because every tool's JSON Schema
 * is resent on every turn. Core plugins load unconditionally; the rest are
 * announced as a compact catalog and activated on demand.
 *
 * The governing rule for restoring a persisted set is that **it is a hint, not
 * a fact**. Names are persisted; implementations are resolved at load time, and
 * anything that no longer resolves is dropped rather than reported as active —
 * a plugin can be renamed, gated off, or (for a dynamically connected one) fail
 * to reconnect between runs.
 */

/** Why a persisted activation could not be restored. */
export type ActivationDropReason =
  | "unknown" // no plugin resolves under this name any more
  | "unavailable" // resolves, but its availability gate is closed this run
  | "unreachable" // a dynamic plugin that failed to (re)connect
  | "error"; // the host's resolver threw; the entry's status is unknown

export interface DroppedActivation {
  /** The canonicalized name that was dropped. */
  name: string;
  reason: ActivationDropReason;
}

export interface RehydrateResult {
  /** Canonicalized, de-duplicated names that resolved and stay active. */
  active: string[];
  /** Everything that did not survive, for the host to log. */
  dropped: DroppedActivation[];
}

export interface RehydrateOptions {
  /** Map a persisted (possibly legacy) name to its current canonical name. */
  canonicalizeName: (name: string) => string;
  /**
   * Can this name be activated on THIS run? Async because restoring a
   * dynamically connected plugin may require re-establishing a connection —
   * the harness owns the policy, the host owns the transport.
   *
   * Return `true` to keep, or a drop reason to discard.
   */
  resolve: (name: string) => ActivationDropReason | true | Promise<ActivationDropReason | true>;
  /**
   * Observe a resolver rejection. The entry is dropped as `"error"` either way,
   * and an observer that throws is swallowed — reporting a failure must not
   * turn one bad name into a failed restore.
   */
  onResolveError?: (name: string, error: unknown) => void;
}

/**
 * Restore a persisted activation set, re-validating every entry against
 * current reality. Order is preserved; duplicates (including two legacy names
 * that canonicalize to the same plugin) collapse to the first occurrence.
 */
export async function rehydrateActivation(
  persisted: readonly string[],
  options: RehydrateOptions,
): Promise<RehydrateResult> {
  const active: string[] = [];
  const dropped: DroppedActivation[] = [];
  const seen = new Set<string>();

  for (const rawName of persisted) {
    const name = options.canonicalizeName(rawName);
    if (seen.has(name)) continue;
    seen.add(name);
    // A throwing resolver drops its entry rather than failing the walk. The
    // contract is best-effort restoration, and a host resolver that reaches a
    // database or decrypts a credential can reject transiently — one bad name
    // must not cost the caller every other restored plugin.
    let verdict: ActivationDropReason | true;
    try {
      verdict = await options.resolve(name);
    } catch (error) {
      try {
        options.onResolveError?.(name, error);
      } catch {
        // An observer that throws (a logger choking on a circular error, a
        // metrics client rejecting) would otherwise defeat the very guarantee
        // this catch exists to provide.
      }
      // Not `unreachable`: that reason means a dynamic plugin failed to
      // reconnect, and a resolver can just as well throw while checking a
      // static plugin. Reporting the failure as its own kind keeps the host's
      // drop logging honest about what it knows.
      verdict = "error";
    }
    if (verdict === true) active.push(name);
    else dropped.push({ name, reason: verdict });
  }

  return { active, dropped };
}

/** The activation set a fresh run starts from. */
export function initialActivePlugins(
  corePlugins: readonly string[],
): string[] {
  return [...new Set(corePlugins)];
}

export interface CatalogPartition {
  active: PluginSummary[];
  loadable: PluginSummary[];
}

/**
 * Split the catalog into what is already active and what the model may load.
 *
 * This returns **data, not prose**: the wording of a catalog belongs to the
 * host's system prompt, which is a product surface with its own voice and
 * (in Monad's case) its own byte-for-byte prompt-cache concerns.
 */
export function partitionPluginCatalog(
  activePlugins: ReadonlySet<string>,
  allSummaries: readonly PluginSummary[],
): CatalogPartition {
  return {
    active: allSummaries.filter((summary) => activePlugins.has(summary.name)),
    loadable: allSummaries.filter((summary) => !activePlugins.has(summary.name)),
  };
}
