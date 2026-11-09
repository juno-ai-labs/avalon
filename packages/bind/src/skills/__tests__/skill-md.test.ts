import { describe, expect, test } from "vitest";
import { parseSkillMarkdown, serializeSkillMarkdown, type SkillYamlCodec } from "../skill-md";

/**
 * A deliberately minimal flat-mapping YAML, not a real one. The package takes
 * peer dependencies only, so its suite cannot reach for `js-yaml`; and the
 * contract under test is the *seam* — that the codec is consulted, that a throw
 * drives the repair pass, that the repaired text is what gets re-parsed. A real
 * parser here would test `js-yaml` rather than this module.
 *
 * It supports exactly what the fixtures need: `key: value`, double-quoted
 * strings with escaped quotes, `[a, b]` flow sequences, and integers. Anything
 * else throws, which is what the repair path needs it to do.
 */
const yaml: SkillYamlCodec = {
  parse(text) {
    const out: Record<string, unknown> = {};
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) throw new Error(`not a mapping line: ${line}`);
      const key = match[1]!;
      const raw = match[2]!;
      const value = raw.trim();
      if (value.startsWith('"')) {
        // A quoted scalar must terminate on the same line, escapes honoured.
        if (!/^"(?:[^"\\]|\\.)*"$/.test(value)) throw new Error(`bad quoted scalar: ${value}`);
        out[key] = value.slice(1, -1).replace(/\\"/g, '"');
      } else if (value.startsWith("[")) {
        if (!value.endsWith("]")) throw new Error(`bad flow sequence: ${value}`);
        const inner = value.slice(1, -1).trim();
        out[key] = inner ? inner.split(",").map((item) => item.trim()) : [];
      } else if (value.includes(":")) {
        // The mistake this module repairs: an unquoted value with a colon reads
        // as a nested mapping, which this parser rejects exactly as YAML does.
        throw new Error(`unquoted colon in value: ${value}`);
      } else if (/^-?\d+$/.test(value)) {
        out[key] = Number(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  },
  stringify(value) {
    return Object.entries(value)
      .map(([key, item]) =>
        Array.isArray(item) ? `${key}: [${item.join(", ")}]` : `${key}: ${String(item)}`,
      )
      .join("\n");
  },
};

const doc = (frontmatter: string, body: string) => `---\n${frontmatter}\n---\n\n${body}\n`;

describe("parseSkillMarkdown", () => {
  test("reads the canonical shape", () => {
    const result = parseSkillMarkdown(
      doc(
        ["name: writing-a-brief", "description: How to write a brief.", "when_to_use: When asked."].join(
          "\n",
        ),
        "Lead with the decision.",
      ),
      yaml,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill).toEqual({
      name: "writing-a-brief",
      description: "How to write a brief.",
      whenToUse: "When asked.",
      body: "Lead with the decision.",
      metadata: null,
    });
    expect(result.warnings).toEqual([]);
  });

  test("accepts all three spellings of the activation hint", () => {
    for (const key of ["when_to_use", "whenToUse", "when-to-use"]) {
      const result = parseSkillMarkdown(doc(`description: d\n${key}: hint`, "body"), yaml);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.skill.whenToUse).toBe("hint");
    }
  });

  test("preserves unknown keys as metadata for a lossless round-trip", () => {
    const result = parseSkillMarkdown(
      doc("name: n\ndescription: d\nlicense: MIT\nversion: 3", "body"),
      yaml,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.metadata).toEqual({ license: "MIT", version: 3 });
  });

  test("repairs an unquoted colon and says so", () => {
    const result = parseSkillMarkdown(
      doc("name: n\ndescription: Use when triaging: sort by risk", "body"),
      yaml,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.description).toBe("Use when triaging: sort by risk");
    expect(result.warnings).toEqual([
      "Frontmatter had unquoted colon values; auto-quoted them on import.",
    ]);
  });

  test("the repair pass leaves a flow sequence alone", () => {
    // One bad line forces the whole block through the repair; a naive pass
    // would quote `[a, b]` into the string "[a, b]" as collateral.
    const result = parseSkillMarkdown(
      doc("description: Use when triaging: sort by risk\ntags: [ops, triage]", "body"),
      yaml,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.metadata).toEqual({ tags: ["ops", "triage"] });
  });

  test("warns rather than fails on a name that is not lower-kebab", () => {
    const result = parseSkillMarkdown(doc("name: Writing A Brief\ndescription: d", "body"), yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.name).toBe("Writing A Brief");
    expect(result.warnings[0]).toContain("not lower-kebab-case");
  });

  test("fails only on the two unrecoverable defects", () => {
    const noFence = parseSkillMarkdown("# Just a document", yaml);
    expect(noFence.ok).toBe(false);
    if (!noFence.ok) expect(noFence.error).toContain("expected a `---` YAML frontmatter block");

    const unterminated = parseSkillMarkdown("---\nname: n\n", yaml);
    expect(unterminated.ok).toBe(false);

    const notYaml = parseSkillMarkdown(doc("- just\n- a list", "body"), yaml);
    expect(notYaml.ok).toBe(false);
    if (!notYaml.ok) expect(notYaml.error).toBe("Frontmatter is not valid YAML.");

    const noDescription = parseSkillMarkdown(doc("name: n", "body"), yaml);
    expect(noDescription.ok).toBe(false);
    if (!noDescription.ok) expect(noDescription.error).toContain("missing a required `description`");
  });

  test("tolerates a BOM and CRLF line endings", () => {
    const result = parseSkillMarkdown(
      "﻿---\r\nname: n\r\ndescription: d\r\n---\r\n\r\nbody\r\n",
      yaml,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skill.description).toBe("d");
  });

  test("a missing name is null rather than invented", () => {
    const result = parseSkillMarkdown(doc("description: d", "body"), yaml);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skill.name).toBeNull();
  });
});

describe("serializeSkillMarkdown", () => {
  test("writes canonical keys last so stray metadata cannot clobber them", () => {
    const text = serializeSkillMarkdown(
      {
        name: "real-name",
        description: "real description",
        whenToUse: "real hint",
        body: "body",
        metadata: { name: "stale", description: "stale", when_to_use: "stale", license: "MIT" },
      },
      yaml,
    );
    const parsed = parseSkillMarkdown(text, yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skill.name).toBe("real-name");
    expect(parsed.skill.description).toBe("real description");
    expect(parsed.skill.whenToUse).toBe("real hint");
    expect(parsed.skill.metadata).toEqual({ license: "MIT" });
  });

  test("omits when_to_use entirely when there is none", () => {
    const text = serializeSkillMarkdown(
      { name: "n", description: "d", whenToUse: null, body: "b", metadata: { when_to_use: "x" } },
      yaml,
    );
    expect(text).not.toContain("when_to_use");
  });

  test("round-trips a parsed document", () => {
    const original = doc("name: n\ndescription: d\nwhen_to_use: w\nlicense: MIT", "the body");
    const first = parseSkillMarkdown(original, yaml);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = parseSkillMarkdown(
      serializeSkillMarkdown({ ...first.skill, name: first.skill.name ?? "n" }, yaml),
      yaml,
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.skill).toEqual(first.skill);
  });
});
