/**
 * Exact token counts for many spans of one text, from a counter that is
 * additive at known cut positions.
 *
 * A cut `c` is a position where, for any span `[start, end)` that contains the
 * cut's context (`before` characters before it and `after` characters from it),
 * `count(text[start, end)) = count(text[start, c)) + count(text[c, end)) - framing`,
 * `framing` being the count of the empty string (special tokens a tokenizer adds
 * once per call). Whether a position is a cut is the tokenizer's property, and
 * the caller that knows its tokenizer supplies them.
 *
 * Chunk planning measures hundreds of overlapping spans per window. Counting a
 * span here tokenizes only its two edges, up to the nearest cut on each side;
 * the segments between cuts are tokenized once per text, lazily and in order.
 */
export function additiveSpanCounter(text: string, count: (value: string) => number,
  cuts: Int32Array, context: { before: number; after: number }): (start: number, end: number) => number {
  const framing = count("");
  const content = (start: number, end: number) => count(text.slice(start, end)) - framing;
  // tokens[j] holds the content tokens of text[cuts[0], cuts[j]), filled left to right.
  const tokens = new Float64Array(cuts.length);
  let filled = 0;
  const through = (index: number) => {
    for (; filled < index; filled += 1) tokens[filled + 1] = tokens[filled]! + content(cuts[filled]!, cuts[filled + 1]!);
    return tokens[index]!;
  };
  const firstAtOrAfter = (position: number) => {
    let low = 0;
    let high = cuts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cuts[middle]! < position) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  // Planning searches hold one end of a span while moving the other: packing
  // and window growth keep the start, overlap search keeps the end. Remember
  // the last edge on each side so a held end is tokenized once.
  let left = { start: -1, cut: -1, tokens: 0 };
  let right = { cut: -1, end: -1, tokens: 0 };
  return (start, end) => {
    const first = firstAtOrAfter(start + context.before);
    const last = firstAtOrAfter(end - context.after + 1) - 1;
    if (first > last) return count(text.slice(start, end));
    const leftCut = cuts[first]!;
    const rightCut = cuts[last]!;
    if (left.start !== start || left.cut !== leftCut) left = { start, cut: leftCut, tokens: content(start, leftCut) };
    if (right.cut !== rightCut || right.end !== end) right = { cut: rightCut, end, tokens: content(rightCut, end) };
    return framing + left.tokens + through(last) - through(first) + right.tokens;
  };
}
