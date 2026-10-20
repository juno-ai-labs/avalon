import { describe, expect, it } from 'vitest';
import {
  markdownDefinitionBlocks,
  splitCollapsibleMarkdown,
  withMarkdownDefinitions,
  type MarkdownCollapsePart,
} from './markdown-collapse';

function join(parts: readonly MarkdownCollapsePart[]): string {
  return parts.map((part) => (part.type === 'preamble' ? part.source : `${part.heading}${part.body}`)).join('');
}

describe('splitCollapsibleMarkdown', () => {
  it('reconstructs the source from parts', () => {
    const source = 'Lead.\n\n## One\n\nPara.\n\n### Nested\n\nMore.\n\n## Two\n\nEnd.\n';
    expect(join(splitCollapsibleMarkdown(source))).toBe(source);
  });

  it('returns no parts for an empty string', () => {
    expect(splitCollapsibleMarkdown('')).toEqual([]);
  });

  it('keeps a heading-less document as a single preamble', () => {
    expect(splitCollapsibleMarkdown('Just a paragraph.\n\nAnd another.')).toEqual([
      { type: 'preamble', source: 'Just a paragraph.\n\nAnd another.' },
    ]);
  });

  it('makes every h2 a section and leaves nested h3s in the body', () => {
    const source = '## Alpha\n\nbody\n\n### Nested\n\ninside\n\n## Beta\n\nnext\n';
    const parts = splitCollapsibleMarkdown(source);
    expect(parts).toEqual([
      {
        type: 'section',
        id: 'section-0',
        level: 2,
        heading: '## Alpha\n',
        body: '\nbody\n\n### Nested\n\ninside\n\n',
      },
      {
        type: 'section',
        id: 'section-1',
        level: 2,
        heading: '## Beta\n',
        body: '\nnext\n',
      },
    ]);
    expect(parts[0] && parts[0].type === 'section' && parts[0].body).toContain('### Nested');
  });

  it('collapses sibling h3s when they are not under an h2', () => {
    const source = '### First\n\none\n\n### Second\n\ntwo\n';
    expect(splitCollapsibleMarkdown(source)).toEqual([
      { type: 'section', id: 'section-0', level: 3, heading: '### First\n', body: '\none\n\n' },
      { type: 'section', id: 'section-1', level: 3, heading: '### Second\n', body: '\ntwo\n' },
    ]);
  });

  it('does not start a section at h1, and an h1 closes the open section', () => {
    const source = '## Work\n\nnotes\n\n# Title\n\nintro\n\n## Next\n\nlater\n';
    const parts = splitCollapsibleMarkdown(source);
    expect(parts.map((part) => part.type)).toEqual(['section', 'preamble', 'section']);
    expect(parts[0]).toMatchObject({ type: 'section', id: 'section-0', heading: '## Work\n', body: '\nnotes\n\n' });
    expect(parts[1]).toEqual({ type: 'preamble', source: '# Title\n\nintro\n\n' });
    expect(parts[2]).toMatchObject({ type: 'section', id: 'section-1', heading: '## Next\n' });
  });

  it('closes an h3 when a later h2 arrives', () => {
    const source = '### Early\n\npre\n\n## Later\n\npost\n';
    const parts = splitCollapsibleMarkdown(source);
    expect(parts).toEqual([
      { type: 'section', id: 'section-0', level: 3, heading: '### Early\n', body: '\npre\n\n' },
      { type: 'section', id: 'section-1', level: 2, heading: '## Later\n', body: '\npost\n' },
    ]);
  });

  it('ignores a heading that sits inside a fenced code block', () => {
    const source = 'Intro.\n\n```md\n## Not a section\n```\n\n## Real\n\nbody\n';
    const parts = splitCollapsibleMarkdown(source);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      type: 'preamble',
      source: 'Intro.\n\n```md\n## Not a section\n```\n\n',
    });
    expect(parts[1]).toMatchObject({ type: 'section', id: 'section-0', heading: '## Real\n' });
  });

  it('treats a setext underline as an h2 section', () => {
    const source = 'Setext\n---\n\nbody\n';
    expect(splitCollapsibleMarkdown(source)).toEqual([
      { type: 'section', id: 'section-0', level: 2, heading: 'Setext\n---\n', body: '\nbody\n' },
    ]);
  });

  it('does not treat a hash without a following space as a heading', () => {
    const source = '##not-a-heading\n\n## Real\n\nbody\n';
    const parts = splitCollapsibleMarkdown(source);
    expect(parts[0]).toMatchObject({ type: 'preamble', source: '##not-a-heading\n\n' });
    expect(parts[1]).toMatchObject({ type: 'section', heading: '## Real\n' });
  });

  it('assigns stable ids as a later section is appended', () => {
    const first = splitCollapsibleMarkdown('## One\n\na\n');
    const grown = splitCollapsibleMarkdown('## One\n\na\n\n## Two\n\nb\n');
    expect(first[0] && partsId(first[0])).toBe(grown[0] && partsId(grown[0]));
  });

  it('keeps lead text before the first h1 when a later h2 exists', () => {
    const source = 'Lead.\n\n# Title\n\nintro\n\n## Next\n\nlater\n';
    const parts = splitCollapsibleMarkdown(source);
    expect(join(parts)).toBe(source);
    expect(parts.map((part) => part.type)).toEqual(['preamble', 'preamble', 'section']);
    expect(parts[0]).toEqual({ type: 'preamble', source: 'Lead.\n\n' });
    expect(parts[1]).toEqual({ type: 'preamble', source: '# Title\n\nintro\n\n' });
    expect(parts[2]).toMatchObject({ type: 'section', id: 'section-0', heading: '## Next\n' });
  });

  it('does not treat a setext underline after a blockquote as a heading', () => {
    const source = '> quoted\n---\n\n## Real\n\nbody\n';
    const parts = splitCollapsibleMarkdown(source);
    expect(join(parts)).toBe(source);
    expect(parts[0]).toEqual({ type: 'preamble', source: '> quoted\n---\n\n' });
    expect(parts[1]).toMatchObject({ type: 'section', heading: '## Real\n' });
  });

  it('leaves an ATX heading indented inside a list item in the list', () => {
    const source = '- item\n  ## heading\n\n## Real\n\nbody\n';
    const parts = splitCollapsibleMarkdown(source);
    expect(join(parts)).toBe(source);
    expect(parts[0]).toEqual({ type: 'preamble', source: '- item\n  ## heading\n\n' });
    expect(parts[1]).toMatchObject({ type: 'section', heading: '## Real\n' });
  });

  it('ignores a heading that sits inside an indented code block', () => {
    const source = 'Intro.\n\n    ## Not a section\n\n## Real\n\nbody\n';
    const parts = splitCollapsibleMarkdown(source);
    expect(join(parts)).toBe(source);
    expect(parts[0]).toEqual({ type: 'preamble', source: 'Intro.\n\n    ## Not a section\n\n' });
    expect(parts[1]).toMatchObject({ type: 'section', heading: '## Real\n' });
  });

  it('does not start a section at a setext h1', () => {
    const source = 'Title\n===\n\nintro\n\n## Next\n\nlater\n';
    const parts = splitCollapsibleMarkdown(source);
    expect(join(parts)).toBe(source);
    expect(parts[0]).toEqual({ type: 'preamble', source: 'Title\n===\n\nintro\n\n' });
    expect(parts[1]).toMatchObject({ type: 'section', heading: '## Next\n' });
  });

  it('keeps a heading with an empty body as a section', () => {
    const source = '## Heading\n## Next\n\nbody\n';
    const parts = splitCollapsibleMarkdown(source);
    expect(join(parts)).toBe(source);
    expect(parts).toEqual([
      { type: 'section', id: 'section-0', level: 2, heading: '## Heading\n', body: '' },
      { type: 'section', id: 'section-1', level: 2, heading: '## Next\n', body: '\nbody\n' },
    ]);
  });

  it('preserves blank lines before the first heading as preamble', () => {
    const source = '\n\n\n## Heading\n\nbody\n';
    const parts = splitCollapsibleMarkdown(source);
    expect(join(parts)).toBe(source);
    expect(parts[0]).toEqual({ type: 'preamble', source: '\n\n\n' });
    expect(parts[1]).toMatchObject({ type: 'section', heading: '## Heading\n' });
  });
});

describe('withMarkdownDefinitions', () => {
  it('appends footnote and link-reference definitions a fragment does not already carry', () => {
    const source = [
      '## Claims',
      '',
      'See [^1] and [the note][ref].',
      '',
      '## Sources',
      '',
      '[^1]: A footnote.',
      '[ref]: https://example.com',
      '',
    ].join('\n');
    const blocks = markdownDefinitionBlocks(source);
    expect(blocks.join('')).toContain('[^1]: A footnote.');
    expect(blocks.join('')).toContain('[ref]: https://example.com');
    const claims = 'See [^1] and [the note][ref].\n';
    const withDefs = withMarkdownDefinitions(claims, blocks);
    expect(withDefs).toContain('[^1]: A footnote.');
    expect(withDefs).toContain('[ref]: https://example.com');
    expect(withMarkdownDefinitions('## Sources\n\n[^1]: A footnote.\n[ref]: https://example.com\n', blocks))
      .toBe('## Sources\n\n[^1]: A footnote.\n[ref]: https://example.com\n');
  });

  it('does not treat a definition inside a fence as a document definition', () => {
    const source = 'Intro.\n\n```md\n[^1]: not a def\n```\n\n[^1]: real\n';
    expect(markdownDefinitionBlocks(source).join('')).toBe('[^1]: real\n');
    expect(markdownDefinitionBlocks(source).join('')).not.toContain('not a def');
  });
});

function partsId(part: MarkdownCollapsePart): string | undefined {
  return part.type === 'section' ? part.id : undefined;
}
