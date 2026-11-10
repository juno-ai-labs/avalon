/**
 * `SKILL.md` — the interchange format.
 *
 * A deployment's canonical storage is its own (a database row, a directory of
 * files), but the portable form is the de-facto `SKILL.md` bundle: a `---`
 * fenced YAML frontmatter block followed by a markdown body, as used by
 * Anthropic's skills and agentskills.io. It is how a skill authored in one
 * place is read in another, which makes both directions of this file a
 * compatibility surface rather than an internal convenience.
 *
 * **Import is deliberately lenient and export is deliberately strict.** The
 * input is a document a person wrote, often in another tool, and the two
 * outcomes are not symmetric: refusing a skill over a cosmetic frontmatter
 * mistake loses knowledge the author already wrote down, while accepting a
 * malformed one costs a warning. So parsing repairs what it can, warns about
 * what it repaired, and fails on exactly two things — frontmatter that is not
 * YAML at all, and a missing `description`, which is the one field with no
 * sensible default because it is the entire Tier-1 catalog line.
 *
 * **YAML arrives as a port.** The package takes peer dependencies only, and a
 * YAML implementation is neither a peer the harness can assume nor something
 * it should bundle. Every host that reads `SKILL.md` already has one — the
 * seam is two functions wide.
 */

/**
 * The host's YAML implementation. `js-yaml`'s `load`/`dump` and the `yaml`
 * package's `parse`/`stringify` both satisfy it directly.
 *
 * `parse` must **throw** on invalid YAML rather than returning a sentinel: the
 * repair pass below is driven by the throw, so a parser that returns
 * `undefined` instead would skip the repair and reject documents this module
 * is meant to accept.
 */
export interface SkillYamlCodec {
  parse: (text: string) => unknown;
  /** Must emit block-style YAML and must not wrap long lines. */
  stringify: (value: Record<string, unknown>) => string;
}

export interface ParsedSkillMd {
  /** `null` when frontmatter omits it — the caller supplies a fallback (usually the filename). */
  name: string | null;
  description: string;
  whenToUse: string | null;
  body: string;
  /** Unknown frontmatter keys, preserved for round-trip and read-only display. */
  metadata: Record<string, unknown> | null;
}

export type SkillMdParseResult =
  | { ok: true; skill: ParsedSkillMd; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

/**
 * Frontmatter keys this module owns. Everything else is preserved verbatim in
 * `metadata` — a host or another tool may put anything here, and dropping it
 * would make an import/export round-trip lossy.
 */
const KNOWN_KEYS = new Set(["name", "description", "when_to_use", "whenToUse", "when-to-use"]);

/** Lower-kebab, at most 64 characters — the shape a skill name must canonicalize to. */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 64;

function splitFrontmatter(raw: string): { frontmatter: string; body: string } | null {
  const text = raw.replace(/^\uFEFF/, ""); // a BOM before the fence is common from Windows editors
  if (!text.startsWith("---")) return null;
  const rest = text.slice(3).replace(/^\r?\n/, "");
  const endIndex = rest.search(/\r?\n---\s*(\r?\n|$)/);
  if (endIndex === -1) return null;
  return {
    frontmatter: rest.slice(0, endIndex),
    body: rest.slice(endIndex).replace(/^\r?\n---\s*(\r?\n)?/, ""),
  };
}

/**
 * Repair the one frontmatter mistake that dominates real imports: an unquoted
 * value containing a colon (`description: Use when X: do Y`), which YAML reads
 * as a nested mapping and rejects. Quote any `key: value` whose value has an
 * unquoted inner colon.
 *
 * A value opening with `[` or `{` is a flow collection — valid YAML where the
 * colons are structural — and is skipped. Without that exception a single
 * unrelated bad line, which forces this whole-block pass, would collateral-
 * quote a legitimate inline array or object into a plain string.
 */
function repairUnquotedColons(frontmatter: string): string {
  return frontmatter
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\s*[A-Za-z0-9_-]+:\s+)(.*)$/);
      if (!match) return line;
      const value = match[2]!;
      const trimmed = value.trim();
      const structured = /^["'[{]/.test(trimmed) || trimmed.length === 0;
      if (structured || !value.includes(":")) return line;
      return `${match[1]}"${value.replace(/"/g, '\\"')}"`;
    })
    .join("\n");
}

function loadYaml(
  frontmatter: string,
  yaml: SkillYamlCodec,
): { object: Record<string, unknown>; warnings: string[] } | null {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = yaml.parse(frontmatter);
  } catch {
    try {
      parsed = yaml.parse(repairUnquotedColons(frontmatter));
      warnings.push("Frontmatter had unquoted colon values; auto-quoted them on import.");
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return { object: parsed as Record<string, unknown>, warnings };
}

/** Parse a raw `SKILL.md` (frontmatter + body) into importable fields. */
export function parseSkillMarkdown(raw: string, yaml: SkillYamlCodec): SkillMdParseResult {
  const split = splitFrontmatter(raw);
  if (!split) {
    return {
      ok: false,
      error: "Not a SKILL.md — expected a `---` YAML frontmatter block.",
      warnings: [],
    };
  }

  const loaded = loadYaml(split.frontmatter, yaml);
  if (!loaded) {
    return { ok: false, error: "Frontmatter is not valid YAML.", warnings: [] };
  }
  const { object, warnings } = loaded;

  const description = typeof object.description === "string" ? object.description.trim() : "";
  if (!description) {
    return {
      ok: false,
      error: "SKILL.md is missing a required `description`.",
      warnings,
    };
  }

  const rawName = typeof object.name === "string" ? object.name.trim() : "";
  const name = rawName.length > 0 ? rawName : null;
  if (name && (name.length > NAME_MAX || !NAME_PATTERN.test(name))) {
    warnings.push(
      `Frontmatter name "${name}" is not lower-kebab-case ≤ ${NAME_MAX} chars; it will be normalized.`,
    );
  }

  // Three spellings, because all three appear in the wild.
  const hintRaw = object.when_to_use ?? object.whenToUse ?? object["when-to-use"] ?? null;
  const whenToUse = typeof hintRaw === "string" && hintRaw.trim() ? hintRaw.trim() : null;

  const extra = Object.entries(object).filter(([key]) => !KNOWN_KEYS.has(key));
  const metadata = extra.length > 0 ? Object.fromEntries(extra) : null;

  return {
    ok: true,
    skill: { name, description, whenToUse, body: split.body.trim(), metadata },
    warnings,
  };
}

/**
 * Serialize a stored skill back to canonical `SKILL.md` text.
 *
 * Preserved unknown keys are written first and the canonical keys last, so a
 * stray `name` / `description` / `when_to_use` that ended up inside `metadata`
 * — which an earlier lenient import makes possible — cannot clobber the real
 * value on the way out.
 */
export function serializeSkillMarkdown(
  skill: {
    name: string;
    description: string;
    whenToUse: string | null;
    body: string;
    metadata: Record<string, unknown> | null;
  },
  yaml: SkillYamlCodec,
): string {
  const front: Record<string, unknown> = { ...(skill.metadata ?? {}) };
  front.name = skill.name;
  front.description = skill.description;
  if (skill.whenToUse) front.when_to_use = skill.whenToUse;
  else delete front.when_to_use;
  return `---\n${yaml.stringify(front).trimEnd()}\n---\n\n${skill.body.trim()}\n`;
}
