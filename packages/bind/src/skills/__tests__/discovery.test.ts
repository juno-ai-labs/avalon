import { describe, expect, test } from "vitest";
import {
  AGENT_SKILLS_DISCOVERY_SCHEMA_URL,
  buildAgentSkillsDiscoveryIndex,
  getPublishedSkillMarkdown,
  skillMarkdownUrl,
} from "../discovery";
import { createSkillRegistry } from "../registry";
import { sha256Hex } from "../sha256";
import type { SkillYamlCodec } from "../skill-md";

/** Enough YAML to emit and read back a flat frontmatter block. See skill-md.test.ts. */
const yaml: SkillYamlCodec = {
  parse: (text) =>
    Object.fromEntries(
      text
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => {
          const index = line.indexOf(":");
          return [line.slice(0, index), line.slice(index + 1).trim()];
        }),
    ),
  stringify: (value) =>
    Object.entries(value)
      .map(([key, item]) => `${key}: ${String(item)}`)
      .join("\n"),
};

function fixture() {
  const registry = createSkillRegistry();
  registry.registerPlatform({
    name: "structuring-a-space",
    description: "How to structure a space.",
    whenToUse: "When setting one up.",
    render: () => "Start from the work.",
  });
  registry.registerPlatform({
    name: "internal-only",
    description: "About the internal runtime.",
    whenToUse: "Never externally.",
    render: () => "Internal.",
  });
  registry.registerPlugin("documents", {
    name: "drafting",
    description: "Draft a document.",
    whenToUse: "When writing.",
    render: () => "Lead with the decision.",
  });
  return registry;
}

const options = (include: string[]) => ({ include, registry: fixture(), yaml });

describe("buildAgentSkillsDiscoveryIndex", () => {
  test("publishes only the allowlist, sorted, with the RFC schema", () => {
    const index = buildAgentSkillsDiscoveryIndex(
      options(["internal-only", "structuring-a-space"]),
    );
    expect(index.$schema).toBe(AGENT_SKILLS_DISCOVERY_SCHEMA_URL);
    expect(index.skills.map((entry) => entry.name)).toEqual([
      "internal-only",
      "structuring-a-space",
    ]);
    expect(index.skills[0]?.type).toBe("skill-md");
    expect(index.skills[0]?.url).toBe("/.well-known/agent-skills/internal-only/SKILL.md");
  });

  test("a name not on the allowlist is not published, however it is registered", () => {
    const index = buildAgentSkillsDiscoveryIndex(options(["structuring-a-space"]));
    expect(index.skills.map((entry) => entry.name)).toEqual(["structuring-a-space"]);
  });

  test("a plugin-contributed skill is never published, even if allowlisted", () => {
    expect(buildAgentSkillsDiscoveryIndex(options(["drafting"])).skills).toEqual([]);
    expect(getPublishedSkillMarkdown("drafting", options(["drafting"]))).toBeNull();
  });

  test("an unregistered name is skipped rather than published empty", () => {
    expect(buildAgentSkillsDiscoveryIndex(options(["nope"])).skills).toEqual([]);
  });

  test("the advertised digest matches the bytes served at the advertised url", () => {
    const opts = options(["structuring-a-space"]);
    const index = buildAgentSkillsDiscoveryIndex(opts);
    const served = getPublishedSkillMarkdown("structuring-a-space", opts);
    expect(served).not.toBeNull();
    expect(index.skills[0]?.digest).toBe(`sha256:${sha256Hex(served ?? "")}`);
  });

  test("the served document round-trips the skill's frontmatter", () => {
    const served = getPublishedSkillMarkdown(
      "structuring-a-space",
      options(["structuring-a-space"]),
    ) as string;
    expect(served).toContain("name: structuring-a-space");
    expect(served).toContain("when_to_use: When setting one up.");
    expect(served.trimEnd().endsWith("Start from the work.")).toBe(true);
  });

  test("one options object serves both documents, and repeats", () => {
    // The index and every artifact fetch read the same `include`. A one-shot
    // iterable would be drained by the first read, so the index would publish
    // the allowlist and every later `SKILL.md` fetch would 404 — the reason the
    // field is typed to re-iterable forms only.
    const opts = options(["structuring-a-space"]);
    expect(buildAgentSkillsDiscoveryIndex(opts).skills).toHaveLength(1);
    expect(buildAgentSkillsDiscoveryIndex(opts).skills).toHaveLength(1);
    expect(getPublishedSkillMarkdown("structuring-a-space", opts)).not.toBeNull();
    expect(getPublishedSkillMarkdown("structuring-a-space", opts)).not.toBeNull();
  });

  test("accepts a Set allowlist and de-duplicates a repeated name", () => {
    const registry = fixture();
    const asSet = buildAgentSkillsDiscoveryIndex({
      include: new Set(["structuring-a-space", "internal-only"]),
      registry,
      yaml,
    });
    expect(asSet.skills.map((entry) => entry.name)).toEqual([
      "internal-only",
      "structuring-a-space",
    ]);
    const repeated = buildAgentSkillsDiscoveryIndex({
      include: ["structuring-a-space", "structuring-a-space"],
      registry,
      yaml,
    });
    expect(repeated.skills.map((entry) => entry.name)).toEqual(["structuring-a-space"]);
  });

  test("a base url override is honoured", () => {
    const index = buildAgentSkillsDiscoveryIndex({
      ...options(["structuring-a-space"]),
      baseUrl: "https://example.test/skills",
    });
    expect(index.skills[0]?.url).toBe(
      "https://example.test/skills/structuring-a-space/SKILL.md",
    );
    expect(skillMarkdownUrl("x")).toBe("/.well-known/agent-skills/x/SKILL.md");
  });
});
