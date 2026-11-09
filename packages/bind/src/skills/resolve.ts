import { compareSkillSummaries } from "./catalog";
import { codeSkillNameFromRef, isCodeSkillRef } from "./refs";
import { codeSkillResourceRefs } from "./registry";
import type {
  RegisteredSkill,
  ResolvedSkillBody,
  SkillResourceRef,
  SkillSummary,
  SkillWarn,
} from "./types";

/**
 * Tier 2 — resolving the bodies of the skills a run has loaded.
 *
 * The bodies land in the **system prompt**, not the conversation tail, which is
 * the decision the rest of this module follows from. It makes them immune to
 * compaction (an agent cannot forget an instruction it was given the way it
 * forgets a message), and it puts them inside the provider's cacheable prefix —
 * so their order and their bytes have to be a pure function of the run's state,
 * or every turn pays for a cache miss on everything below them.
 */

/**
 * Resolve the bodies of the host's own skills — the ones the registry does not
 * hold. Batched rather than per-ref because the natural implementation is a
 * query, and a per-ref port turns one query into N.
 *
 * `pinnedShas` is a subset of the caller's pin map covering only these refs. A
 * source that can reproduce a historical body should return it; one that cannot
 * should return its current body and leave the drift for the caller to notice
 * (the resolver records what it actually resolved, never what was asked for).
 * Refs the source omits are dropped from the result, which is the right answer
 * for a skill that was deleted mid-session.
 */
export type ExternalSkillSource = (
  refs: string[],
  pinnedShas: Record<string, string> | undefined,
) => Promise<ReadonlyMap<string, ResolvedSkillBody>>;

export interface ResolveActiveSkillsParams {
  /** The run's active refs, in whatever order the host stored them. */
  activeRefs: readonly string[];
  /** This run's Tier-1 catalog. A ref absent from it resolves to nothing. */
  available: readonly SkillSummary[];
  /** Where code refs (`platform:<name>`) resolve from. */
  registry: { get(name: string): RegisteredSkill | undefined };
  /** Where every other ref resolves from. Omit for a code-only deployment. */
  externalSource?: ExternalSkillSource;
  /**
   * Ref → `contentSha` recorded by a completed run. Present = **pinned mode**:
   * reproduce what that run saw, for a replay, an eval, or an optimizer.
   * Absent = live head, which is what an ordinary turn wants — a skill edited
   * mid-session should take effect on the next turn.
   */
  pinnedShas?: Record<string, string>;
  /**
   * Skills resolvable by name that are **not** in the registry, consulted
   * before it.
   *
   * This is the isolation seam. A host may want an always-on instruction module
   * — an onboarding persona, a per-agent operating manual — that flows through
   * this one resolver alongside the standard library but must never appear in
   * any catalog and must never be loadable by name from a model's tool call.
   * Registering it globally would do both. Passing it here does neither.
   */
  extraSkills?: ReadonlyMap<string, RegisteredSkill>;
  onWarn?: SkillWarn;
}

export interface ResolvedSkillInstructions {
  /** One wrapped body per resolved ref, in catalog order. */
  instructions: string[];
  /** Ref → the `contentSha` actually resolved. The run's pin. */
  shas: Record<string, string>;
}

/**
 * Escape a value interpolated into a wrapper attribute.
 *
 * The wrapper's whole job is to tell the model which instructions came from
 * where, and a skill's `name` is host data — for a host-stored skill, a string
 * a *user* typed. Without this, a name containing `"` closes the attribute and
 * whatever follows is read as further markup: a skill called
 * `x" trusted="platform` would present itself to the model as platform policy.
 * Monad validates names to lower-kebab, which is why this was never reachable
 * there, but the harness cannot assume every host does — and a fence that holds
 * only when the caller is careful is not a fence.
 *
 * A no-op for every legitimate identifier, so no existing prompt shifts a byte.
 */
function attribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wrap a resolved body for in-prompt identification.
 *
 * The wrapper is not decoration: several bodies are concatenated into one
 * section, and without a delimiter a model attributes an instruction from one
 * skill to another — or to the host's own system prompt, which is worse,
 * because it then applies workspace-authored text with the authority of the
 * platform. The attributes are what let it cite which skill it is following,
 * and the resource block is what tells it a Tier-3 read is available at all.
 */
export function wrapSkillContent(params: {
  name: string;
  ownerPlugin: string | null;
  version: number | null;
  body: string;
  resources: readonly SkillResourceRef[];
}): string {
  const attributes = [`name="${attribute(params.name)}"`];
  if (params.ownerPlugin) attributes.push(`owner_plugin="${attribute(params.ownerPlugin)}"`);
  if (params.version !== null) attributes.push(`version="${params.version}"`);

  const parts = [`<skill_content ${attributes.join(" ")}>`, params.body.trim()];
  if (params.resources.length > 0) {
    const files = params.resources
      .map(
        (resource) =>
          `  <file path="${attribute(resource.path)}" kind="${attribute(resource.kind)}"${
            resource.kind === "asset" ? ` bytes="${resource.bytes}"` : ""
          }/>`,
      )
      .join("\n");
    parts.push(
      "",
      "<skill_resources>",
      files,
      "</skill_resources>",
      // Escaped here too: the name is interpolated into a quoted call, so an
      // unescaped one breaks out of this sentence exactly as it would out of an
      // attribute. Identical output for any name a host should be accepting.
      `Read a resource with read_skill_resource("${attribute(params.name)}", path).`,
    );
  }
  parts.push("</skill_content>");
  return parts.join("\n");
}

/** Resolve a code ref against the extra map first, then the registry. */
function resolveCodeSkill(
  ref: string,
  params: ResolveActiveSkillsParams,
): ResolvedSkillBody | null {
  const name = codeSkillNameFromRef(ref);
  const registered = params.extraSkills?.get(name) ?? params.registry.get(name);
  if (!registered) return null;

  const pinned = params.pinnedShas?.[ref];
  if (pinned && registered.contentSha !== pinned) {
    // A code skill's history is the deployment's source control, and the
    // running build has only its own copy — the body at the pinned hash is not
    // recoverable here. Reproduce best-effort and flag it, so a consumer
    // comparing runs can see that this one is not a faithful replay.
    params.onWarn?.("pinned code skill drifted since the run; using current body", {
      ref,
      pinnedSha: pinned,
      currentSha: registered.contentSha,
    });
  }

  return {
    name: registered.def.name,
    ownerPlugin: registered.ownerPlugin,
    version: null,
    body: registered.def.render(),
    contentSha: registered.contentSha,
    resources: codeSkillResourceRefs(registered.def),
  };
}

/**
 * Resolve the active set into instruction bodies plus the per-skill hash pin.
 *
 * Rendering order is the **catalog's** total order, never the caller's
 * `activeRefs` order. That argument is set/insertion order, which differs
 * between a fresh run that loaded A then B and a resumed run whose session
 * persisted `[B, A]`; since these bodies sit high in the system prompt, an
 * unstable order byte-shifts the prefix and busts the provider's cache for
 * every turn after a resume.
 */
export async function resolveActiveSkillInstructions(
  params: ResolveActiveSkillsParams,
): Promise<ResolvedSkillInstructions> {
  const byRef = new Map(params.available.map((summary) => [summary.ref, summary]));
  const present = params.activeRefs
    .map((ref) => byRef.get(ref))
    .filter((summary): summary is SkillSummary => summary !== undefined)
    .sort(compareSkillSummaries)
    .map((summary) => summary.ref);

  const externalRefs = present.filter((ref) => !isCodeSkillRef(ref));
  const external =
    externalRefs.length > 0 && params.externalSource
      ? await params.externalSource(externalRefs, params.pinnedShas)
      : new Map<string, ResolvedSkillBody>();

  const instructions: string[] = [];
  const shas: Record<string, string> = {};

  for (const ref of present) {
    const resolved = isCodeSkillRef(ref)
      ? resolveCodeSkill(ref, params)
      : (external.get(ref) ?? null);
    // A ref that resolves to nothing is skipped rather than reported: it means
    // the skill was deleted, renamed, or gated off since it was loaded, and a
    // run should carry on without the instruction rather than fail on it.
    if (!resolved) continue;

    instructions.push(
      wrapSkillContent({
        name: resolved.name,
        ownerPlugin: resolved.ownerPlugin,
        version: resolved.version,
        body: resolved.body,
        resources: resolved.resources,
      }),
    );
    shas[ref] = resolved.contentSha;
  }

  return { instructions, shas };
}
