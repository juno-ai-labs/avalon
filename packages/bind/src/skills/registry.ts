import { codeSkillRef } from "./refs";
import { computeSkillContentSha } from "./sha";
import { sha256Hex as defaultSha256Hex, utf8ByteLength, type Sha256Hex } from "./sha256";
import type {
  RegisteredSkill,
  SkillDef,
  SkillResourceDef,
  SkillResourceRef,
  SkillSummary,
  SkillWarn,
} from "./types";

/**
 * The code-skill registry — what a deployment's own source contributes, as
 * against what its users author.
 *
 * **A factory, not a module singleton**, for the same two reasons the tool
 * registry is one: module state in a workerd isolate has a lifetime the host
 * does not control, and an implicit global makes every test share a registry
 * with every other. A host that wants singleton ergonomics wraps one instance
 * in a module of its own — that decision belongs to the host.
 *
 * The registry is deliberately **not** the whole skill library. It holds code
 * skills, whose bodies are build artifacts and whose version history is source
 * control. Host-stored skills never enter it; they meet code skills only in the
 * resolved {@link SkillSummary} catalog, which is source-agnostic by design.
 */
export interface SkillRegistry {
  /**
   * Register a standalone skill with no owning plugin — available to every
   * agent.
   *
   * `ownerPlugin` on the def is **ignored** and warned about. A platform skill
   * is unowned by definition, and honouring a stray field here would make the
   * loader auto-activate a plugin and mislabel the skill as that plugin's.
   */
  registerPlatform(def: SkillDef): void;
  /**
   * Register a skill contributed by a tool plugin. `ownerPlugin` is filled from
   * `pluginName` rather than the def, so a recipe is only ever offered to an
   * agent that can load the tools it describes.
   */
  registerPlugin(pluginName: string, def: SkillDef): void;
  get(name: string): RegisteredSkill | undefined;
  all(): RegisteredSkill[];
  /** Tier-1 summaries, gated to the plugins available on this run. */
  summaries(options?: { availablePlugins?: Iterable<string> }): SkillSummary[];
  /** Drop every registration. For a test that wants a controlled set. */
  clear(): void;
}

export interface SkillRegistryOptions {
  /**
   * Observe a likely author bug: a name collision, or a platform registration
   * carrying an owner. Both overwrite/ignore and continue — a bad skill must
   * not take down agent startup — so this is the only signal they happened.
   */
  onWarn?: SkillWarn;
  /** Override the content digest. Must be synchronous SHA-256 (see `sha256.ts`). */
  sha256Hex?: Sha256Hex;
}

/** The Tier-3 listing for a code skill: metadata, with sizes measured in UTF-8 bytes. */
export function codeSkillResourceRefs(def: SkillDef): SkillResourceRef[] {
  return (def.resources ?? []).map((resource) => ({
    path: resource.path,
    kind: resource.kind,
    bytes: utf8ByteLength(resource.render()),
  }));
}

/** Project a registered code skill into the source-agnostic Tier-1 summary. */
export function toCodeSkillSummary(skill: RegisteredSkill): SkillSummary {
  return {
    ref: codeSkillRef(skill.def.name),
    name: skill.def.name,
    description: skill.def.description,
    whenToUse: skill.def.whenToUse ?? null,
    ownerPlugin: skill.ownerPlugin,
    origin: skill.origin,
  };
}

export function createSkillRegistry(options: SkillRegistryOptions = {}): SkillRegistry {
  const skills = new Map<string, RegisteredSkill>();
  const sha256Hex = options.sha256Hex ?? defaultSha256Hex;
  const warn: SkillWarn = options.onWarn ?? (() => {});

  const digestResources = (resources: SkillResourceDef[] | undefined) =>
    (resources ?? []).map((resource) => ({
      path: resource.path,
      contentType: resource.contentType,
      contentHash: sha256Hex(resource.render()),
    }));

  const register = (
    def: SkillDef,
    origin: RegisteredSkill["origin"],
    ownerPlugin: string | null,
  ): void => {
    const existing = skills.get(def.name);
    // Re-registering the *same* def is ordinary — a module imported twice, a
    // host that re-runs its bootstrap — and is silent. Two distinct defs under
    // one name is a copy-paste or a cross-plugin clash: last wins, loudly.
    if (existing && existing.def !== def) {
      warn("code skill name collision — overwriting", {
        name: def.name,
        previousOrigin: existing.origin,
        previousOwnerPlugin: existing.ownerPlugin,
        newOrigin: origin,
        newOwnerPlugin: ownerPlugin,
      });
    }
    const contentSha = computeSkillContentSha(
      {
        name: def.name,
        description: def.description,
        whenToUse: def.whenToUse ?? null,
        body: def.render(),
        ownerPlugin,
        metadata: null,
        resources: digestResources(def.resources),
      },
      sha256Hex,
    );
    skills.set(def.name, { def, origin, ownerPlugin, contentSha });
  };

  return {
    registerPlatform(def) {
      if (def.ownerPlugin != null) {
        warn("platform skill declared an ownerPlugin; ignoring it", {
          name: def.name,
          ignoredOwnerPlugin: def.ownerPlugin,
        });
      }
      register(def, "platform", null);
    },
    registerPlugin(pluginName, def) {
      register({ ...def, ownerPlugin: pluginName }, "plugin", pluginName);
    },
    get(name) {
      return skills.get(name);
    },
    all() {
      return [...skills.values()];
    },
    summaries(summaryOptions) {
      const availablePlugins =
        summaryOptions?.availablePlugins === undefined
          ? undefined
          : new Set(summaryOptions.availablePlugins);
      const out: SkillSummary[] = [];
      for (const skill of skills.values()) {
        if (skill.origin === "plugin" && availablePlugins) {
          if (!skill.ownerPlugin || !availablePlugins.has(skill.ownerPlugin)) continue;
        }
        out.push(toCodeSkillSummary(skill));
      }
      return out;
    },
    clear() {
      skills.clear();
    },
  };
}
