interface CaretNode { type: string; tagName?: string; properties?: Record<string, unknown>; children?: CaretNode[]; value?: string }
interface CaretParent extends CaretNode { children: CaretNode[] }

/**
 * Blocks the caret descends into. An inline element (a link, a citation pill,
 * emphasis) is not one: the caret follows it in its paragraph rather than
 * taking on its styling. Nor is a `div`: the citation pass groups embeds into
 * rows whose children must all be cells.
 */
const CARET_CONTAINERS = new Set([
  'p', 'li', 'ul', 'ol', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'pre', 'code',
]);

export const STREAMING_CARET_CLASS = 'streaming-caret';

function lastContentChild(parent: CaretParent): CaretNode | undefined {
  for (let index = parent.children.length - 1; index >= 0; index -= 1) {
    const child = parent.children[index]!;
    if (child.type === 'text' && !child.value?.trim()) continue;
    // GFM appends the footnote list after everything, wherever the
    // definitions were written; the caret belongs to the prose.
    if (child.type === 'element' && child.properties?.dataFootnotes) continue;
    return child;
  }
  return undefined;
}

/**
 * Put the streaming caret after the last character of a growing message, in
 * the block that holds it. Drawn outside the markdown body, the caret fell to
 * a line of its own under the closing paragraph and read as a second letter.
 */
export function rehypeStreamingCaret() {
  return (tree: CaretParent): void => {
    let parent = tree;
    for (;;) {
      const last = lastContentChild(parent);
      if (last?.type !== 'element' || !last.tagName || !CARET_CONTAINERS.has(last.tagName) || !last.children) break;
      parent = last as CaretParent;
    }
    parent.children.push({
      type: 'element',
      tagName: 'span',
      properties: { className: [STREAMING_CARET_CLASS], ariaHidden: 'true' },
      children: [],
    });
  };
}
