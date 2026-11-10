import { serializeSkillMarkdown, type SkillYamlCodec } from "./skill-md";
import { sha256Hex as defaultSha256Hex, type Sha256Hex } from "./sha256";
import type { RegisteredSkill } from "./types";

/**
 * The Agent Skills **discovery index** — how a deployment advertises skills to
 * agents that are not its own.
 *
 * Per the Agent Skills Discovery RFC v0.2.0
 * (https://github.com/cloudflare/agent-skills-discovery-rfc,
 * https://agentskills.io/), an external agent fetches
 * `/.well-known/agent-skills/index.json`, reads the `skills[]` catalogue, pulls
 * each `SKILL.md` from its advertised `url`, and verifies the bytes against the
 * published `digest`. Both documents are generated from the same registry here,
 * so the digest a reader sees always matches the bytes served.
 *
 * **What to publish is a product decision and stays with the host** — hence the
 * explicit `include` allowlist rather than "every platform skill". The
 * criterion that matters is whether a skill helps an outside agent drive
 * *something the deployment actually exposes externally*. A skill about the
 * host's internal agent runtime cannot help an external client and does not
 * belong in a public document; a plugin-contributed skill is tied to tools that
 * are not on the external surface; a workspace's own skills are private data.
 * Making the list an argument also means dropping a new file into a skills
 * folder never publishes it by accident.
 */

/** The RFC v0.2.0 schema URL advertised in the index's `$schema` field. */
export const AGENT_SKILLS_DISCOVERY_SCHEMA_URL =
  "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

/** Root of the well-known discovery namespace (host-relative per RFC 3986). */
export const AGENT_SKILLS_WELL_KNOWN_BASE = "/.well-known/agent-skills";

/** Host-relative URL of the `SKILL.md` artifact for a skill name. */
export function skillMarkdownUrl(name: string, base = AGENT_SKILLS_WELL_KNOWN_BASE): string {
  return `${base}/${name}/SKILL.md`;
}

/** One entry in the discovery index's `skills[]` array. */
export interface DiscoverySkillEntry {
  /** Lower-kebab skill identifier. */
  name: string;
  /** Distribution format. Single-file `SKILL.md` skills only. */
  type: "skill-md";
  /** Tier-1 catalogue line (≤ 1024 chars per the RFC). */
  description: string;
  /** Location of the `SKILL.md`, resolved per RFC 3986. */
  url: string;
  /** SHA-256 of the served `SKILL.md` bytes, `sha256:{64-hex}`. */
  digest: string;
}

/** The full `/.well-known/agent-skills/index.json` document. */
export interface AgentSkillsDiscoveryIndex {
  $schema: string;
  skills: DiscoverySkillEntry[];
}

export interface SkillDiscoveryOptions {
  /**
   * Names to publish. Anything not registered as a `platform` skill is skipped.
   *
   * Deliberately **not** `Iterable<string>`: this options object is built once
   * and read by both functions below, and a one-shot iterable (a generator, a
   * `Map.keys()`) would be drained by the first call — so the index would
   * publish the allowlist and every subsequent `SKILL.md` fetch would 404, with
   * nothing in either signature to suggest why. Both accepted forms are
   * re-iterable, which makes that failure unrepresentable rather than merely
   * documented.
   */
  include: readonly string[] | ReadonlySet<string>;
  /** The registry to read from; the host bootstraps it before calling. */
  registry: { get(name: string): RegisteredSkill | undefined };
  yaml: SkillYamlCodec;
  /** Base for the advertised `url`. Host-relative by default. */
  baseUrl?: string;
  sha256Hex?: Sha256Hex;
}

/**
 * Canonical `SKILL.md` bytes for a published skill — exactly the text served at
 * its `url` and hashed for its `digest`.
 *
 * `metadata` is null because a code skill has none to preserve: it is
 * registered from name, description, hint and body, so anything else in the
 * document it was authored from was already dropped at registration. Emitting
 * it here would put bytes in the artifact that the digest of a re-registered
 * skill could not reproduce.
 */
function skillMarkdownFor(skill: RegisteredSkill, yaml: SkillYamlCodec): string {
  return serializeSkillMarkdown(
    {
      name: skill.def.name,
      description: skill.def.description,
      whenToUse: skill.def.whenToUse ?? null,
      body: skill.def.render(),
      metadata: null,
    },
    yaml,
  );
}

/** Only `platform`-origin skills are publishable; a name that is not one is not published. */
function publishable(
  name: string,
  registry: SkillDiscoveryOptions["registry"],
): RegisteredSkill | null {
  const skill = registry.get(name);
  return skill && skill.origin === "platform" ? skill : null;
}

/** The allowlist as a set — de-duplicated, and O(1) to test. */
function allowlist(include: SkillDiscoveryOptions["include"]): ReadonlySet<string> {
  return include instanceof Set ? include : new Set(include);
}

/** Build the discovery index from the allowlisted, registered platform skills. */
export function buildAgentSkillsDiscoveryIndex(
  options: SkillDiscoveryOptions,
): AgentSkillsDiscoveryIndex {
  const sha256Hex = options.sha256Hex ?? defaultSha256Hex;
  const skills = [...allowlist(options.include)]
    .map((name) => publishable(name, options.registry))
    .filter((skill): skill is RegisteredSkill => skill !== null)
    .sort((a, b) => a.def.name.localeCompare(b.def.name))
    .map<DiscoverySkillEntry>((skill) => ({
      name: skill.def.name,
      type: "skill-md",
      description: skill.def.description,
      url: skillMarkdownUrl(skill.def.name, options.baseUrl),
      digest: `sha256:${sha256Hex(skillMarkdownFor(skill, options.yaml))}`,
    }));
  return { $schema: AGENT_SKILLS_DISCOVERY_SCHEMA_URL, skills };
}

/**
 * The published `SKILL.md` text for a name, or `null` when it is not published.
 *
 * One return value for "not on the allowlist", "not registered", and
 * "registered but not a platform skill": the caller serves a 404 for all three,
 * and distinguishing them would tell an anonymous reader which internal skills
 * exist.
 */
export function getPublishedSkillMarkdown(
  name: string,
  options: SkillDiscoveryOptions,
): string | null {
  // Allowlist first: an unknown name short-circuits without touching the registry.
  if (!allowlist(options.include).has(name)) return null;
  const skill = publishable(name, options.registry);
  return skill ? skillMarkdownFor(skill, options.yaml) : null;
}
