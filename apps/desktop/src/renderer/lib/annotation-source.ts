interface SourceNode { type: string; tagName?: string; properties?: Record<string, unknown>; children?: SourceNode[]; position?: { start: { offset?: number }; end: { offset?: number } }; value?: string }
interface SourceParent extends SourceNode { children: SourceNode[] }

/** Preserve parser offsets on rendered blocks and text. Files remain byte-verbatim. */
export function rehypeAnnotationSource() {
  return (tree: SourceParent): void => {
    const visit = (parent: SourceParent): void => {
      parent.children = parent.children.map((node): SourceNode => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (node.type === 'text' && start !== undefined && end !== undefined) {
          return { type: 'element', tagName: 'span', properties: { 'data-annotation-start': start, 'data-annotation-end': end, 'data-annotation-text': true }, children: [node], position: node.position };
        }
        if (node.type === 'element') {
          if (start !== undefined && end !== undefined) {
            (node.properties ??= {})['data-annotation-start'] = start;
            (node.properties ??= {})['data-annotation-end'] = end;
          }
          if (node.children && node.tagName !== 'code') { const parent = { ...node, children: node.children }; visit(parent); node.children = parent.children; }
        }
        return node;
      });
    };
    visit(tree);
  };
}
export function sourceSelectionPoint(node: Node, offset: number, source: string): number | null {
  const element = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-annotation-text]');
  if (!element) return null;
  const start = Number(element.dataset.annotationStart);
  const end = Number(element.dataset.annotationEnd);
  const range = document.createRange();
  range.setStart(element, 0);
  range.setEnd(node, offset);
  const length = range.toString().length;
  const raw = source.slice(start, end);
  if (raw === element.textContent) return start + length;
  // Entity and escaped punctuation occupy more source bytes than rendered text.
  let rendered = 0;
  let index = 0;
  while (index < raw.length && rendered < length) {
    const entity = /^&(?:#\d+|#x[\da-f]+|[a-z]+);/iu.exec(raw.slice(index));
    if (entity) {
      const decoder = document.createElement('textarea');
      decoder.innerHTML = entity[0];
      rendered += decoder.value.length;
      index += entity[0].length;
    } else if (raw[index] === '\\' && /[!-/:-@[-`{-~]/u.test(raw[index + 1] ?? '')) {
      rendered += 1; index += 2;
    } else { rendered += 1; index += 1; }
  }
  return start + index;
}

/** Resolve only a verified source range; repeated text never falls back to a search. */
export function annotationDomRange(container: HTMLElement, source: string, start: number, end: number): Range | null {
  const spans = [...container.querySelectorAll<HTMLElement>('[data-annotation-text]')];
  const point = (offset: number, isEnd: boolean): { node: Node; offset: number } | null => {
    const element = spans.find((e) => Number(e.dataset.annotationStart) <= offset && (isEnd ? Number(e.dataset.annotationEnd) >= offset : Number(e.dataset.annotationEnd) > offset))
      ?? (isEnd ? spans.filter((e) => Number(e.dataset.annotationEnd) <= offset).at(-1) : spans.find((e) => Number(e.dataset.annotationStart) >= offset));
    if (element) offset = Math.max(Number(element.dataset.annotationStart),Math.min(Number(element.dataset.annotationEnd),offset));
    if (!element) return null;
    const walker = document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const boundary = sourceSelectionPoint(node,node.textContent?.length ?? 0,source);
      if (boundary !== null && boundary >= offset) break;
      node = walker.nextNode();
    }
    if (!node) return null;
    let low = 0; let high = node.textContent?.length ?? 0;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const value = sourceSelectionPoint(node,middle,source);
      if (value !== null && value < offset) low = middle + 1; else high = middle;
    }
    return {node,offset:low};
  };
  const first = point(start,false); const last = point(end,true);
  if (!first || !last) return null;
  const range = document.createRange(); range.setStart(first.node,first.offset); range.setEnd(last.node,last.offset);
  return range;
}
