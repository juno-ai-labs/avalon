import { describe, expect, test } from "vitest";
import { sha256Hex, utf8ByteLength } from "../sha256";
import { computeSkillContentSha, stableSkillJson } from "../sha";

describe("sha256Hex", () => {
  // A hash that is subtly wrong still looks like a hash, so the published
  // vectors are the only thing that proves this implementation at all.
  test("matches the FIPS 180-4 vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  test("spans multiple blocks and the length-field boundary", () => {
    // 1,000,000 × "a" — the vector that catches a broken block loop.
    expect(sha256Hex("a".repeat(1_000_000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
    // 55 and 56 bytes straddle the padding boundary: at 56 the length field no
    // longer fits in the same block, so a wrong `total` shows up here first.
    expect(sha256Hex("a".repeat(55))).toBe(
      "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
    );
    expect(sha256Hex("a".repeat(56))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
    );
  });

  test("hashes UTF-8 bytes, not UTF-16 code units", () => {
    // "é" is one code unit and two UTF-8 bytes; "😀" is two code units and four.
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(sha256Hex("é")).toBe(
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
    );
    expect(sha256Hex("😀")).toBe(
      "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9",
    );
  });
});

describe("stableSkillJson", () => {
  test("sorts object keys recursively and keeps array order", () => {
    expect(stableSkillJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(stableSkillJson([3, 1, 2])).toBe("[3,1,2]");
  });

  test("serializes a Date to its ISO string rather than collapsing it to {}", () => {
    const early = stableSkillJson({ at: new Date("2020-01-01T00:00:00.000Z") });
    const late = stableSkillJson({ at: new Date("2026-01-01T00:00:00.000Z") });
    expect(early).not.toBe(late);
    expect(early).toBe('{"at":"2020-01-01T00:00:00.000Z"}');
  });
});

describe("computeSkillContentSha", () => {
  const base = {
    name: "writing-a-brief",
    description: "How to write a brief.",
    whenToUse: "When asked for a brief.",
    body: "Lead with the decision.",
    ownerPlugin: null,
    metadata: null,
    resources: [],
  };

  test("is stable for identical input and changes for any version-defining edit", () => {
    const sha = computeSkillContentSha(base);
    expect(computeSkillContentSha({ ...base })).toBe(sha);

    for (const mutated of [
      { ...base, name: "writing-a-memo" },
      { ...base, description: "Something else." },
      { ...base, whenToUse: "Never." },
      { ...base, body: "Bury the decision." },
      { ...base, ownerPlugin: "documents" },
      { ...base, metadata: { license: "MIT" } },
      {
        ...base,
        resources: [{ path: "references/spec.md", contentType: "text/markdown", contentHash: "a" }],
      },
    ]) {
      expect(computeSkillContentSha(mutated)).not.toBe(sha);
    }
  });

  test("ignores resource ordering but not resource content", () => {
    const one = {
      path: "references/a.md",
      contentType: "text/markdown",
      contentHash: "hash-a",
    };
    const two = {
      path: "references/b.md",
      contentType: "text/markdown",
      contentHash: "hash-b",
    };
    expect(computeSkillContentSha({ ...base, resources: [one, two] })).toBe(
      computeSkillContentSha({ ...base, resources: [two, one] }),
    );
    expect(computeSkillContentSha({ ...base, resources: [one, two] })).not.toBe(
      computeSkillContentSha({ ...base, resources: [one, { ...two, contentHash: "other" }] }),
    );
  });

  test("accepts a host digest", () => {
    expect(computeSkillContentSha(base, () => "fixed")).toBe("fixed");
  });
});
