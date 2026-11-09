import { sha256Hex as defaultSha256Hex, type Sha256Hex } from "./sha256";

/**
 * A skill's content hash — the value that makes a replay honest.
 *
 * A run records which skills it loaded, and an eval, a regression harness, or a
 * GEPA-style optimizer later asks what the agent was actually told. The name is
 * not enough: skills are edited. So a run pins a hash per loaded skill, and the
 * hash must cover **every input that changes the model's instructions** — body,
 * catalog line, activation hint, owner, preserved frontmatter, and each bundled
 * resource. Anything left out is a way to change what the agent reads while the
 * pin still claims the run is reproducible.
 *
 * Resources are hashed by digest rather than by content so a large reference
 * costs one pass, and they are sorted by path so listing order — which is
 * incidental, and differs between a directory scan and a hand-written array —
 * never changes the result.
 */
export interface SkillShaInput {
  name: string;
  description: string;
  whenToUse: string | null;
  body: string;
  ownerPlugin: string | null;
  /** Preserved unknown frontmatter keys, or null. */
  metadata: Record<string, unknown> | null;
  /** One entry per resource; order-independent. */
  resources: ReadonlyArray<{
    path: string;
    contentType: string;
    contentHash: string;
  }>;
}

/**
 * Deterministic, compact JSON with object keys sorted recursively — the
 * canonical form the content hash is taken over.
 *
 * Two details are load-bearing. Keys are sorted because a `metadata` object
 * that arrived from a YAML parse, a JSON column, or a hand-written literal has
 * no reliable key order, and unsorted output would rotate the hash for content
 * nobody edited. A `Date` serializes to its ISO string because `typeof
 * new Date() === "object"` with no own keys, so recursing into it would
 * collapse every distinct timestamp to `{}` — and a YAML timestamp in
 * frontmatter is exactly how one gets here.
 */
export function stableSkillJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
    return sorted;
  }
  return value;
}

/**
 * Compute a skill's content hash from its version-defining inputs.
 *
 * `sha256Hex` defaults to the package's own implementation; pass a host digest
 * only if it is synchronous and genuinely SHA-256 (see `sha256.ts`).
 */
export function computeSkillContentSha(
  input: SkillShaInput,
  sha256Hex: Sha256Hex = defaultSha256Hex,
): string {
  const canonical = {
    name: input.name,
    description: input.description,
    whenToUse: input.whenToUse,
    body: input.body,
    ownerPlugin: input.ownerPlugin,
    // Stringified rather than nested so a `metadata` key named `body` or
    // `resources` cannot collide with a sibling of the canonical object.
    metadata: stableSkillJson(input.metadata),
    resources: [...input.resources]
      .map((resource) => ({
        path: resource.path,
        contentType: resource.contentType,
        contentHash: resource.contentHash,
      }))
      // `localeCompare`, not a code-unit comparison, because hosts already
      // store hashes computed this way and any reordering rotates them —
      // orphaning every version snapshot a pinned replay resolves against.
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  return sha256Hex(stableSkillJson(canonical));
}

export { defaultSha256Hex as sha256Hex, type Sha256Hex };
