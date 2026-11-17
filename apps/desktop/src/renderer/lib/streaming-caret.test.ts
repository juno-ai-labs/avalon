import { describe, expect, it } from 'vitest';
import { rehypeStreamingCaret } from './streaming-caret';

type Node = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: Node[]; value?: string };

const el = (tagName: string, children: Node[] = [], properties: Record<string, unknown> = {}): Node =>
  ({ type: 'element', tagName, properties, children });
const text = (value: string): Node => ({ type: 'text', value });
const isCaret = (node: Node | undefined): boolean =>
  node?.type === 'element' && (node.properties?.className as string[] | undefined)?.includes('streaming-caret') === true;

function run(children: Node[]): Node {
  const tree = { type: 'root', children };
  rehypeStreamingCaret()(tree as never);
  return tree;
}

describe('rehypeStreamingCaret', () => {
  it('appends the caret to an empty root', () => {
    const tree = run([]);
    expect(isCaret(tree.children![0])).toBe(true);
  });

  it('puts the caret in the last cell of a table', () => {
    const cell = el('td', [text('last')]);
    run([el('table', [el('tbody', [el('tr', [el('td', [text('first')]), cell])])])]);
    expect(isCaret(cell.children![1])).toBe(true);
  });

  it('skips the footnote list GFM appends and lands in the prose', () => {
    const paragraph = el('p', [text('Claim')]);
    const footnotes = el('section', [el('ol', [el('li', [text('note')])])], { dataFootnotes: true });
    run([paragraph, text('\n'), footnotes]);
    expect(isCaret(paragraph.children![1])).toBe(true);
  });

  it('never enters a div, so citation embed rows keep only their cells', () => {
    const row = el('div', [el('div', [text('card')])], { className: ['citation-card-row'] });
    const tree = run([row]);
    expect(row.children).toHaveLength(1);
    expect(isCaret(tree.children![1])).toBe(true);
  });

  it('follows a code block rather than entering it', () => {
    const code = el('code', [text('const a = 1;\n')]);
    const tree = run([el('pre', [code])]);
    expect(code.children).toHaveLength(1);
    expect(isCaret(tree.children![1])).toBe(true);
  });
});
