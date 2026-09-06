/** Shared pipeline retrieval granularity, measured by the embedding tokenizer. */
export interface SemanticChunkPolicy {
  maxTokens: number;
  overlapTokens: number;
  /** Counts the actual embedding input, including any model-specific framing. */
  countTokens: (text: string) => number | Promise<number>;
  /** Optional title/section context; counted in each chunk's budget. */
  prefix?: string;
}

export interface SemanticChunk {
  /** UTF-16 offsets into the original source; text is never normalized. */
  start: number;
  end: number;
  text: string;
  embeddingText: string;
  strategies: Array<"recursive" | "sliding_window">;
}

const SEPARATORS = ["\n\n", "\n", ". ", " "];

/**
 * Index both structure-preserving passages and overlapping windows. Sizes are
 * explicit pipeline policy, not guesses based on a model family's context window.
 */
export async function semanticChunks(text: string, policy: SemanticChunkPolicy): Promise<SemanticChunk[]> {
  if (!Number.isSafeInteger(policy.maxTokens) || policy.maxTokens <= 0
    || !Number.isSafeInteger(policy.overlapTokens) || policy.overlapTokens < 0
    || policy.overlapTokens >= policy.maxTokens) {
    throw new Error("invalid_semantic_chunk_policy");
  }
  if (!text) return [];
  const prefix = policy.prefix ?? "";
  const count = async (value: string): Promise<number> => {
    const tokens = await policy.countTokens(value);
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("invalid_embedding_token_count");
    return tokens;
  };
  const fits = async (start: number, end: number) =>
    await count(prefix + text.slice(start, end)) <= policy.maxTokens;

  // Code-point boundaries prevent truncating surrogate pairs, including when
  // a document has no whitespace (code, URLs, or CJK text).
  const boundaries = [0];
  for (const character of text) boundaries.push(boundaries[boundaries.length - 1]! + character.length);
  const positions = new Map(boundaries.map((offset, index) => [offset, index]));
  const chunks = new Map<string, SemanticChunk>();
  const add = (start: number, end: number, strategy: SemanticChunk["strategies"][number]) => {
    const key = `${start}:${end}`;
    const existing = chunks.get(key);
    if (existing) {
      if (!existing.strategies.includes(strategy)) existing.strategies.push(strategy);
      return;
    }
    const passage = text.slice(start, end);
    chunks.set(key, { start, end, text: passage, embeddingText: prefix + passage, strategies: [strategy] });
  };

  const windowEnd = async (start: number, end: number) => {
    let low = positions.get(start)! + 1;
    const startPosition = positions.get(start)!;
    const endPosition = positions.get(end)!;
    let high = Math.min(low, endPosition);
    let best = start;
    // Grow from the chunk start instead of repeatedly tokenizing half of the
    // entire remaining document for every window.
    while (await fits(start, boundaries[high]!)) {
      best = boundaries[high]!;
      if (high === endPosition) return best;
      low = high + 1;
      high = Math.min(endPosition, startPosition + (high - startPosition) * 2);
    }
    // Token counts need not be strictly monotonic under BPE. Binary search may
    // leave some budget unused, but every accepted candidate is measured.
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const offset = boundaries[middle]!;
      if (await fits(start, offset)) { best = offset; low = middle + 1; }
      else high = middle - 1;
    }
    if (best === start) throw new Error("semantic_chunk_budget_too_small");
    return best;
  };

  const recursive = async (start: number, end: number, level: number): Promise<void> => {
    if (await fits(start, end)) { add(start, end, "recursive"); return; }
    const separator = SEPARATORS[level];
    if (!separator) {
      while (start < end) {
        const next = await windowEnd(start, end);
        add(start, next, "recursive");
        start = next;
      }
      return;
    }
    let pieceStart = start;
    let packedStart = start;
    let packedEnd = start;
    while (pieceStart < end) {
      const found = text.indexOf(separator, pieceStart);
      const pieceEnd = found < 0 || found + separator.length >= end ? end : found + separator.length;
      if (await fits(packedStart, pieceEnd)) {
        packedEnd = pieceEnd;
      } else {
        if (packedEnd > packedStart) add(packedStart, packedEnd, "recursive");
        await recursive(pieceStart, pieceEnd, level + 1);
        packedStart = pieceEnd;
        packedEnd = pieceEnd;
      }
      pieceStart = pieceEnd;
    }
    if (packedEnd > packedStart) add(packedStart, packedEnd, "recursive");
  };
  await recursive(0, text.length, 0);

  let start = 0;
  while (start < text.length) {
    const end = await windowEnd(start, text.length);
    add(start, end, "sliding_window");
    if (end === text.length) break;
    let next = end;
    if (policy.overlapTokens > 0) {
      let low = positions.get(start)! + 1; // every window must advance
      let high = positions.get(end)!;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const offset = boundaries[middle]!;
        if (await count(text.slice(offset, end)) <= policy.overlapTokens) {
          next = offset; high = middle - 1;
        } else low = middle + 1;
      }
      // Prefix framing can leave less room than the requested overlap. Reduce
      // overlap until the next window can include new source content.
      const firstNewEnd = boundaries[positions.get(end)! + 1]!;
      while (next < end && !await fits(next, firstNewEnd)) next = boundaries[positions.get(next)! + 1]!;
    }
    start = next;
  }
  return [...chunks.values()].sort((left, right) => left.start - right.start || left.end - right.end);
}
