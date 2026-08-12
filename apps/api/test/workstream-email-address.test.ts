import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WORKSTREAM_ADDRESS_ADJECTIVES_V1,
  WORKSTREAM_ADDRESS_ANIMALS_V1,
  WORKSTREAM_ADDRESS_COMBINATION_COUNT_V1,
  WORKSTREAM_ADDRESS_NOUNS_V1,
  WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1,
  allocateWorkstreamEmailAddressCandidate
} from "../src/lib/workstream-email-address";

const testKey = "avalon-workstream-address-test-key-v1";
const workstreamId = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0";

function documentedVocabulary(section: string): string[] {
  const documentation = readFileSync(
    new URL("../../../docs/workstream-email-addresses.md", import.meta.url),
    "utf8"
  );
  const headingStart = documentation.indexOf(`## Frozen v1 ${section} (`);
  const contentStart = documentation.indexOf("```text\n", headingStart) + "```text\n".length;
  const contentEnd = documentation.indexOf("\n```", contentStart);
  if (headingStart < 0 || contentStart < "```text\n".length || contentEnd < 0) {
    throw new Error(`Missing ${section} vocabulary in work-stream email documentation`);
  }
  return documentation.slice(contentStart, contentEnd).split(",").map((word) => word.trim());
}

describe("work-stream address vocabulary", () => {
  it("freezes the exact v1 vocabulary sizes and combination count", () => {
    expect(WORKSTREAM_ADDRESS_ADJECTIVES_V1).toHaveLength(128);
    expect(WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1).toHaveLength(256);
    expect(WORKSTREAM_ADDRESS_ANIMALS_V1).toHaveLength(256);
    expect(WORKSTREAM_ADDRESS_NOUNS_V1).toHaveLength(512);
    expect(WORKSTREAM_ADDRESS_COMBINATION_COUNT_V1).toBe(
      128 * 127 * 126 * 512
    );
    expect(Object.isFrozen(WORKSTREAM_ADDRESS_ADJECTIVES_V1)).toBe(true);
    expect(Object.isFrozen(WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1)).toBe(true);
    expect(Object.isFrozen(WORKSTREAM_ADDRESS_ANIMALS_V1)).toBe(true);
    expect(Object.isFrozen(WORKSTREAM_ADDRESS_NOUNS_V1)).toBe(true);
  });

  it("contains unique lowercase ASCII tokens and disjoint noun groups", () => {
    const allLists = [
      WORKSTREAM_ADDRESS_ADJECTIVES_V1,
      WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1,
      WORKSTREAM_ADDRESS_ANIMALS_V1,
      WORKSTREAM_ADDRESS_NOUNS_V1
    ];

    for (const list of allLists) {
      expect(new Set(list).size).toBe(list.length);
      for (const token of list) {
        expect(token).toMatch(/^[a-z]+$/);
      }
    }

    const scientists = new Set<string>(WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1);
    expect(WORKSTREAM_ADDRESS_ANIMALS_V1.some((animal) => scientists.has(animal))).toBe(false);
    expect(WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1).toContain("lovelace");
    expect(WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1).toContain("chandrasekhar");
    expect(WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1).toContain("carver");
    expect(WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1).not.toContain("archimedes");
    expect(WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1).not.toContain("heisenberg");
    expect(WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1).not.toContain("marconi");

    const adjectiveLengths = WORKSTREAM_ADDRESS_ADJECTIVES_V1
      .map((word) => word.length)
      .sort((left, right) => right - left);
    const longestNoun = Math.max(...WORKSTREAM_ADDRESS_NOUNS_V1.map((word) => word.length));
    expect(
      adjectiveLengths[0]! + adjectiveLengths[1]! + adjectiveLengths[2]! + longestNoun + 3
    ).toBeLessThanOrEqual(64);
  });

  it("keeps the documented frozen lists byte-for-byte aligned with code", () => {
    expect(documentedVocabulary("adjectives")).toEqual(WORKSTREAM_ADDRESS_ADJECTIVES_V1);
    expect(documentedVocabulary("scientist surnames")).toEqual(
      WORKSTREAM_ADDRESS_SCIENTIST_SURNAMES_V1
    );
    expect(documentedVocabulary("animals")).toEqual(WORKSTREAM_ADDRESS_ANIMALS_V1);
  });
});

describe("allocateWorkstreamEmailAddressCandidate", () => {
  it("is deterministic for a fixed work stream and attempt", async () => {
    const first = await allocateWorkstreamEmailAddressCandidate({
      secretKey: testKey,
      workstreamId,
      attempt: 0
    });
    const second = await allocateWorkstreamEmailAddressCandidate({
      secretKey: testKey,
      workstreamId,
      attempt: 0
    });

    expect(first).toBe(second);
    expect(first).toBe("linear-seamless-clear-wu");
  });

  it("generates a lowercase adjective-adjective-adjective-noun local part", async () => {
    const candidate = await allocateWorkstreamEmailAddressCandidate({
      secretKey: testKey,
      workstreamId,
      attempt: 7
    });
    const [firstAdjective, secondAdjective, thirdAdjective, noun] = candidate.split("-");

    expect(candidate).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/);
    expect(firstAdjective).not.toBe(secondAdjective);
    expect(firstAdjective).not.toBe(thirdAdjective);
    expect(secondAdjective).not.toBe(thirdAdjective);
    expect(WORKSTREAM_ADDRESS_ADJECTIVES_V1).toContain(firstAdjective);
    expect(WORKSTREAM_ADDRESS_ADJECTIVES_V1).toContain(secondAdjective);
    expect(WORKSTREAM_ADDRESS_ADJECTIVES_V1).toContain(thirdAdjective);
    expect(WORKSTREAM_ADDRESS_NOUNS_V1).toContain(noun);
    expect(new TextEncoder().encode(candidate).byteLength).toBeLessThanOrEqual(64);
  });

  it("uses the attempt when deriving collision candidates", async () => {
    const candidates = await Promise.all(
      Array.from({ length: 8 }, (_, attempt) =>
        allocateWorkstreamEmailAddressCandidate({ secretKey: testKey, workstreamId, attempt })
      )
    );

    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("never repeats an adjective in sampled candidates", async () => {
    const candidates = await Promise.all(
      Array.from({ length: 128 }, (_, attempt) =>
        allocateWorkstreamEmailAddressCandidate({ secretKey: testKey, workstreamId, attempt })
      )
    );

    for (const candidate of candidates) {
      const adjectives = candidate.split("-").slice(0, 3);
      expect(new Set(adjectives).size).toBe(3);
    }
  });

  it("rejects weak keys and invalid allocator inputs", async () => {
    await expect(allocateWorkstreamEmailAddressCandidate({
      secretKey: "too-short",
      workstreamId
    })).rejects.toThrow("at least 32 bytes");
    await expect(allocateWorkstreamEmailAddressCandidate({
      secretKey: testKey,
      workstreamId: ""
    })).rejects.toThrow("non-empty");
    await expect(allocateWorkstreamEmailAddressCandidate({
      secretKey: testKey,
      workstreamId,
      attempt: -1
    })).rejects.toThrow("non-negative safe integer");
  });
});
