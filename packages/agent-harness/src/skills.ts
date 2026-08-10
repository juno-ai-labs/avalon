import {
  admitSkillLoad,
  codeSkillNameFromRef,
  codeSkillResourceRefs,
  createSkillActivation,
  createSkillRegistry,
  estimateSkillBodyTokens,
  isCodeSkillRef,
  resolveActiveSkillInstructions,
  type RegisteredSkill,
  type SkillActivation,
  type SkillRegistry,
  type SkillSummary,
} from "@juno-ai/bind/skills";
import type { ToolDefinition } from "@avalon/contracts";
import type { HarnessSkill, HarnessTool, HarnessToolResult } from "./index";

/**
 * Skills — loadable instructions, as against loadable tools.
 *
 * A plugin gives the model a *capability*; a skill gives it a *procedure*: how
 * this workspace triages a queue, what its brand voice is, which fields a
 * handover note must carry. Both use the same progressive disclosure, and for
 * the same reason — a catalog line costs about fifty tokens and a body costs
 * thousands, so the run pays for a body only once the model asks for it.
 *
 * Everything mechanical here is `@juno-ai/bind/skills`. What this module owns
 * is Avalon's frozen-scope reading of it: **a run's skills are fixed at
 * admission**, exactly like its plugins. They arrive on `RunHarnessInput`
 * having already been resolved against the execution principal, so nothing
 * below reaches a store, and `load_skill` can only surface a body the host
 * already decided this run was allowed to read.
 *
 * A skill is knowledge, not authority: loading one never activates a plugin,
 * never widens the frozen scope, and never makes a tool callable. Where a
 * skill names a plugin as its owner, the model is told to load that plugin
 * itself — an auto-activation here would be a capability grant issued by a
 * document.
 */

export const AVALON_SKILLS_PLUGIN_ID = "avalon.skills";

export const AVALON_SKILL_TOOL_DEFINITIONS = [
  {
    name: "load_skill",
    description:
      "Load a skill's full instructions by its exact name. Its body is added to your active instructions and stays available for the rest of the run.",
    capability: "avalon.skills.load",
    // Activation changes only Avalon's in-run prompt surface — no external
    // write, and safe to resume from the same receipt.
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string", minLength: 1 } },
      required: ["name"],
    },
  },
  {
    name: "read_skill_resource",
    description:
      "Read a reference file bundled with a skill you have already loaded, by its exact path.",
    capability: "avalon.skills.read_resource",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string", minLength: 1 }, path: { type: "string", minLength: 1 } },
      required: ["name", "path"],
    },
  },
] as const satisfies readonly ToolDefinition[];

export const AVALON_SKILLS_SYSTEM_MESSAGE = [
  "Skills are reusable procedures and reference knowledge authorized for this run.",
  "When a request matches a skill's stated purpose, load it before answering rather than improvising the procedure.",
  "Its instructions appear under Active Skill Instructions and stay for the rest of the run.",
  "Loading a skill grants no new authority: if a skill describes a plugin's tools, load that plugin separately.",
].join(" ");

export interface SkillRuntime {
  /** Tier-1 catalog for this run, in the harness's total order. */
  summaries: readonly SkillSummary[];
  /** Refs loaded so far. Mutated in place by activation; read by the prompt render. */
  activeRefs: Set<string>;
  /** Ref → content hash of the body actually injected, for the run record. */
  loadedShas: Record<string, string>;
  /** Wrapped bodies for the active set, in the same total order as the catalog. */
  instructions: readonly string[];
  activation: SkillActivation;
  /** The always-active plugin carrying `load_skill` / `read_skill_resource`. */
  tools: HarnessTool[];
  /** Whether this run has any skills at all — false suppresses both prompt sections. */
  enabled: boolean;
}

function toDefinition(skill: HarnessSkill) {
  return {
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    ...(skill.ownerPlugin ? { ownerPlugin: skill.ownerPlugin } : {}),
    render: () => skill.body,
    ...(skill.resources?.length
      ? {
          resources: skill.resources.map((resource) => ({
            path: resource.path,
            kind: "reference" as const,
            contentType: resource.contentType ?? "text/markdown",
            render: () => resource.body,
          })),
        }
      : {}),
  };
}

function stringArgument(raw: unknown, key: string): string {
  return typeof raw === "object" && raw !== null && key in raw
    ? String((raw as Record<string, unknown>)[key]).trim()
    : "";
}

export async function createSkillRuntime(input: {
  skills: readonly HarnessSkill[];
  /**
   * Refs the host durably recorded as loaded on an earlier attempt. Like a
   * plugin activation hint this is a *hint*, not a fact: a ref that no longer
   * resolves against this run's catalog is dropped rather than restored, since
   * the frozen scope may have narrowed between attempts.
   */
  activationHints?: readonly string[];
  maxActiveSkills?: number;
  maxActiveSkillBodyTokens?: number;
  onWarn?: (message: string, fields: Record<string, unknown>) => void;
}): Promise<SkillRuntime> {
  const registry: SkillRegistry = createSkillRegistry({
    ...(input.onWarn ? { onWarn: input.onWarn } : {}),
  });
  for (const skill of input.skills) {
    // Owner is authoritative from the registration path, never from the def —
    // a skill cannot name itself into a plugin it was not contributed by.
    if (skill.ownerPlugin) registry.registerPlugin(skill.ownerPlugin, toDefinition(skill));
    else registry.registerPlatform(toDefinition(skill));
  }

  const summaries = registry.summaries();
  const byName = new Map(summaries.map((summary) => [summary.name, summary]));
  const activeRefs = new Set<string>();
  const loadedShas: Record<string, string> = {};
  let instructions: string[] = [];

  const resolveActiveInstructions = (refs: string[]) =>
    resolveActiveSkillInstructions({
      activeRefs: refs,
      available: summaries,
      registry,
      ...(input.onWarn ? { onWarn: input.onWarn } : {}),
    });

  const runtime: SkillRuntime = {
    summaries,
    activeRefs,
    loadedShas,
    get instructions() {
      return instructions;
    },
    activation: createSkillActivation({
      availableSkills: summaries,
      activeSkills: activeRefs,
      loadedSkillShas: loadedShas,
      store: { resolveActiveInstructions },
      applyInstructions: (next) => {
        instructions = next;
      },
      ...(input.onWarn ? { onWarn: input.onWarn } : {}),
    }),
    tools: [],
    enabled: summaries.length > 0,
  };

  const registered = (summary: SkillSummary): RegisteredSkill | undefined =>
    isCodeSkillRef(summary.ref) ? registry.get(codeSkillNameFromRef(summary.ref)) : undefined;

  const notFound = (name: string): HarnessToolResult => ({
    output: {
      error: "skill_not_available",
      available: summaries.map((summary) => summary.name).sort(),
    },
    summary: `Skill ${name || "(unnamed)"} is not available to this run`,
  });

  runtime.tools = AVALON_SKILL_TOOL_DEFINITIONS.map((definition): HarnessTool => ({
    definition,
    // Serial: a skill loaded in one batch must be readable by a
    // `read_skill_resource` later in the same batch.
    serial: true,
    execute: async (raw) => {
      const name = stringArgument(raw, "name");
      const summary = byName.get(name);
      if (!summary) return notFound(name);

      if (definition.name === "load_skill") {
        const alreadyActive = activeRefs.has(summary.ref);
        if (!alreadyActive) {
          // Bind judges; Avalon measures. The token half needs the resolver,
          // because the only honest measurement of what a load costs the
          // prompt is the wrapped bodies it would actually inject.
          const projected = await resolveActiveInstructions([...activeRefs, summary.ref]);
          const decision = admitSkillLoad({
            activeCount: activeRefs.size,
            ...(input.maxActiveSkills === undefined ? {} : { maxActive: input.maxActiveSkills }),
            projectedBodyTokens: estimateSkillBodyTokens(projected.instructions),
            ...(input.maxActiveSkillBodyTokens === undefined
              ? {}
              : { maxBodyTokens: input.maxActiveSkillBodyTokens }),
          });
          if (!decision.admitted) {
            return {
              output: {
                error: "skill_limit_reached",
                reason: decision.reason,
                loaded: [...activeRefs].map(refName).sort(),
              },
              summary: `Cannot load ${summary.name}: ${decision.reason}`,
            };
          }
        }

        const resources = registered(summary);
        return {
          output: {
            loaded: summary.name,
            status: alreadyActive ? "already_active" : "loaded",
            ...(summary.ownerPlugin
              ? {
                  // Stated, not acted on: a skill must not be able to activate
                  // a plugin the frozen run scope did not already allow.
                  ownerPlugin: summary.ownerPlugin,
                  note: `This skill describes tools from the ${summary.ownerPlugin} plugin; load that plugin separately if you need them.`,
                }
              : {}),
            resources: resources ? codeSkillResourceRefs(resources.def).map((ref) => ref.path) : [],
          },
          summary: alreadyActive
            ? `Skill ${summary.name} was already loaded`
            : `Loaded skill ${summary.name}`,
          // Bind's control signal: the loop calls activateSkills with this ref
          // before any later tool in the same batch runs.
          loadedSkillRef: summary.ref,
        } satisfies HarnessToolResult;
      }

      // read_skill_resource. Tier-3 belongs to a *loaded* skill: requiring the
      // load first is what stops a model reading every catalog skill's
      // references without ever paying for — or being seen to take on — its
      // instructions.
      if (!activeRefs.has(summary.ref)) {
        return {
          output: { error: "skill_not_loaded" },
          summary: `Skill ${summary.name} must be loaded with load_skill before reading its resources`,
        };
      }
      const path = stringArgument(raw, "path");
      const resource = registered(summary)?.def.resources?.find((entry) => entry.path === path);
      if (!resource) {
        return {
          output: {
            error: "resource_not_found",
            available: (registered(summary)?.def.resources ?? []).map((entry) => entry.path),
          },
          summary: `Skill ${summary.name} has no resource ${path || "(unnamed)"}`,
        };
      }
      return {
        output: { name: summary.name, path: resource.path, contentType: resource.contentType, content: resource.render() },
        summary: `Read ${resource.path} from skill ${summary.name}`,
      };
    },
  }));

  function refName(ref: string): string {
    return isCodeSkillRef(ref) ? codeSkillNameFromRef(ref) : ref;
  }

  if (input.activationHints?.length) {
    await runtime.activation.activateSkills(input.activationHints);
  }

  return runtime;
}
