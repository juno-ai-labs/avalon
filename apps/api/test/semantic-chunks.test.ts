import { describe, expect, it } from "vitest";
import { semanticChunks } from "../src/services/semantic-chunks";

// A deterministic code-point tokenizer keeps these algorithm tests independent
// of external embedding providers. Production callers supply their model's count.
const countTokens = (text: string) => Array.from(text).length;

describe("semantic chunking", () => {
  it("preserves structure and adds overlapping boundary-spanning windows", async () => {
    const text = "alpha\n\nbeta\n\ngamma";
    const chunks = await semanticChunks(text, { maxTokens: 12, overlapTokens: 4, countTokens });
    const recursive = chunks.filter((chunk) => chunk.strategies.includes("recursive"));
    const windows = chunks.filter((chunk) => chunk.strategies.includes("sliding_window"));
    expect(recursive.map((chunk) => chunk.text)).toEqual(["alpha\n\n", "beta\n\n", "gamma"]);
    expect(recursive.map((chunk) => chunk.text).join("")).toBe(text);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.end).toBeGreaterThan(windows[1]!.start);
    expect(windows[0]!.text).toContain("beta");
    expect(windows[1]!.end).toBe(text.length);
    for (const chunk of chunks) {
      expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
      expect(countTokens(chunk.embeddingText)).toBeLessThanOrEqual(12);
    }
  });

  it("deduplicates a short document shared by both strategies", async () => {
    expect(await semanticChunks("short", { maxTokens: 12, overlapTokens: 4, countTokens })).toEqual([{
      start: 0, end: 5, text: "short", embeddingText: "short", strategies: ["recursive", "sliding_window"],
    }]);
  });

  it("splits unbroken Unicode without losing text or breaking surrogate pairs", async () => {
    const text = "漢🙂字🚀abcdef";
    const chunks = await semanticChunks(text, { maxTokens: 3, overlapTokens: 1, countTokens });
    expect(chunks.filter((chunk) => chunk.strategies.includes("recursive")).map((chunk) => chunk.text).join("")).toBe(text);
    for (const chunk of chunks) {
      expect(new TextDecoder().decode(new TextEncoder().encode(chunk.text))).toBe(chunk.text);
      expect(countTokens(chunk.text)).toBeLessThanOrEqual(3);
    }
  });

  it("counts context and framing and reduces overlap when necessary to advance", async () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const chunks = await semanticChunks(text, {
      maxTokens: 8, overlapTokens: 6, prefix: "Doc:",
      countTokens: async (value) => countTokens(value) + 2,
    });
    const windows = chunks.filter((chunk) => chunk.strategies.includes("sliding_window"));
    expect(windows.at(-1)!.end).toBe(text.length);
    expect(windows.every((chunk, i) => i === 0 || chunk.start > windows[i - 1]!.start)).toBe(true);
    for (const chunk of chunks) expect(countTokens(chunk.embeddingText) + 2).toBeLessThanOrEqual(8);
  });

  it("rejects an impossible budget instead of truncating content", async () => {
    await expect(semanticChunks("x", { maxTokens: 2, overlapTokens: 0, prefix: "title", countTokens }))
      .rejects.toThrow("semantic_chunk_budget_too_small");
  });

  it("omits whitespace-only passages without changing meaningful text or offsets", async () => {
    const policy = { maxTokens: 3, overlapTokens: 1, countTokens };
    expect(await semanticChunks(" \n\t ", policy)).toEqual([]);
    const text = "alpha" + " ".repeat(12) + "beta";
    const chunks = await semanticChunks(text, policy);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.embeddingText.trim().length > 0)).toBe(true);
    for (const chunk of chunks) expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
    for (const strategy of ["recursive", "sliding_window"] as const) {
      for (let i = 0; i < text.length; i += 1) {
        if (text[i]!.trim()) expect(chunks.some((chunk) => chunk.strategies.includes(strategy)
          && chunk.start <= i && chunk.end > i)).toBe(true);
      }
    }
  });

  it("handles empty content and rejects a nonadvancing overlap policy", async () => {
    expect(await semanticChunks("", { maxTokens: 3, overlapTokens: 1, countTokens })).toEqual([]);
    await expect(semanticChunks("abc", { maxTokens: 3, overlapTokens: 3, countTokens }))
      .rejects.toThrow("invalid_semantic_chunk_policy");
  });
});
