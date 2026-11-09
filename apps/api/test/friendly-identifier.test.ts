import { describe, expect, it } from "vitest";
import {
  FRIENDLY_IDENTIFIER_ADJECTIVES_V1,
  FRIENDLY_IDENTIFIER_ANIMALS_V1,
  FRIENDLY_IDENTIFIER_COMBINATION_COUNT_V1,
  FRIENDLY_IDENTIFIER_NOUNS_V1,
  FRIENDLY_IDENTIFIER_SCIENTIST_SURNAMES_V1,
  friendlyIdentifierCandidate
} from "../src/lib/friendly-identifier";

const testKey = "avalon-workstream-address-test-key-v1";
const id = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0";

describe("friendly identifier vocabulary", () => {
  it("freezes the exact v1 vocabulary sizes and combination count", () => {
    expect(FRIENDLY_IDENTIFIER_ADJECTIVES_V1).toHaveLength(128);
    expect(FRIENDLY_IDENTIFIER_SCIENTIST_SURNAMES_V1).toHaveLength(256);
    expect(FRIENDLY_IDENTIFIER_ANIMALS_V1).toHaveLength(256);
    expect(FRIENDLY_IDENTIFIER_NOUNS_V1).toHaveLength(512);
    expect(FRIENDLY_IDENTIFIER_COMBINATION_COUNT_V1).toBe(
      128 * 127 * 126 * 512
    );
    expect(Object.isFrozen(FRIENDLY_IDENTIFIER_ADJECTIVES_V1)).toBe(true);
    expect(Object.isFrozen(FRIENDLY_IDENTIFIER_SCIENTIST_SURNAMES_V1)).toBe(true);
    expect(Object.isFrozen(FRIENDLY_IDENTIFIER_ANIMALS_V1)).toBe(true);
    expect(Object.isFrozen(FRIENDLY_IDENTIFIER_NOUNS_V1)).toBe(true);
  });

  it("contains unique lowercase ASCII tokens and disjoint noun groups", () => {
    const allLists = [
      FRIENDLY_IDENTIFIER_ADJECTIVES_V1,
      FRIENDLY_IDENTIFIER_SCIENTIST_SURNAMES_V1,
      FRIENDLY_IDENTIFIER_ANIMALS_V1,
      FRIENDLY_IDENTIFIER_NOUNS_V1
    ];

    for (const list of allLists) {
      expect(new Set(list).size).toBe(list.length);
      for (const token of list) {
        expect(token).toMatch(/^[a-z]+$/);
      }
    }

    const scientists = new Set<string>(FRIENDLY_IDENTIFIER_SCIENTIST_SURNAMES_V1);
    expect(FRIENDLY_IDENTIFIER_ANIMALS_V1.some((animal) => scientists.has(animal))).toBe(false);
    expect(FRIENDLY_IDENTIFIER_SCIENTIST_SURNAMES_V1).toContain("lovelace");
    expect(FRIENDLY_IDENTIFIER_SCIENTIST_SURNAMES_V1).toContain("chandrasekhar");
    expect(FRIENDLY_IDENTIFIER_SCIENTIST_SURNAMES_V1).toContain("carver");
    expect(FRIENDLY_IDENTIFIER_SCIENTIST_SURNAMES_V1).not.toContain("archimedes");
    expect(FRIENDLY_IDENTIFIER_SCIENTIST_SURNAMES_V1).not.toContain("heisenberg");
    expect(FRIENDLY_IDENTIFIER_SCIENTIST_SURNAMES_V1).not.toContain("marconi");

    const adjectiveLengths = FRIENDLY_IDENTIFIER_ADJECTIVES_V1
      .map((word) => word.length)
      .sort((left, right) => right - left);
    const longestNoun = Math.max(...FRIENDLY_IDENTIFIER_NOUNS_V1.map((word) => word.length));
    expect(
      adjectiveLengths[0]! + adjectiveLengths[1]! + adjectiveLengths[2]! + longestNoun + 3
    ).toBeLessThanOrEqual(64);
  });


});

describe("friendlyIdentifierCandidate", () => {
  it("is deterministic for a fixed identifier and attempt", async () => {
    const first = await friendlyIdentifierCandidate({
      secretKey: testKey,
      id,
      attempt: 0
    });
    const second = await friendlyIdentifierCandidate({
      secretKey: testKey,
      id,
      attempt: 0
    });

    expect(first).toBe(second);
    expect(first).toBe("linear-seamless-clear-wu");
  });

  it("generates a lowercase adjective-adjective-adjective-noun local part", async () => {
    const candidate = await friendlyIdentifierCandidate({
      secretKey: testKey,
      id,
      attempt: 7
    });
    const [firstAdjective, secondAdjective, thirdAdjective, noun] = candidate.split("-");

    expect(candidate).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/);
    expect(firstAdjective).not.toBe(secondAdjective);
    expect(firstAdjective).not.toBe(thirdAdjective);
    expect(secondAdjective).not.toBe(thirdAdjective);
    expect(FRIENDLY_IDENTIFIER_ADJECTIVES_V1).toContain(firstAdjective);
    expect(FRIENDLY_IDENTIFIER_ADJECTIVES_V1).toContain(secondAdjective);
    expect(FRIENDLY_IDENTIFIER_ADJECTIVES_V1).toContain(thirdAdjective);
    expect(FRIENDLY_IDENTIFIER_NOUNS_V1).toContain(noun);
    expect(new TextEncoder().encode(candidate).byteLength).toBeLessThanOrEqual(64);
  });

  it("uses the attempt when deriving collision candidates", async () => {
    const candidates = await Promise.all(
      Array.from({ length: 8 }, (_, attempt) =>
        friendlyIdentifierCandidate({ secretKey: testKey, id, attempt })
      )
    );

    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("never repeats an adjective in sampled candidates", async () => {
    const candidates = await Promise.all(
      Array.from({ length: 128 }, (_, attempt) =>
        friendlyIdentifierCandidate({ secretKey: testKey, id, attempt })
      )
    );

    for (const candidate of candidates) {
      const adjectives = candidate.split("-").slice(0, 3);
      expect(new Set(adjectives).size).toBe(3);
    }
  });

  it("rejects weak keys and invalid allocator inputs", async () => {
    await expect(friendlyIdentifierCandidate({
      secretKey: "too-short",
      id
    })).rejects.toThrow("at least 32 bytes");
    await expect(friendlyIdentifierCandidate({
      secretKey: testKey,
      id: ""
    })).rejects.toThrow("non-empty");
    await expect(friendlyIdentifierCandidate({
      secretKey: testKey,
      id,
      attempt: -1
    })).rejects.toThrow("non-negative safe integer");
  });
});
