import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CitationResolutionContext, type CitationResolver } from './citations';
import { MarkdownBody } from './workstream-blocks';
import { useUiStore } from '../lib/ui-store';

const openExternal = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText: vi.fn(), openExternal }),
  desktopServicesAvailable: () => true,
}));

/** Everything the work stream has loaded resolves; nothing else does. */
const resolver: CitationResolver = (resourceId) => (
  resourceId === 'prd-1'
    ? { status: 'resolved', resource: { id: 'prd-1', title: 'Mute windows PRD', resourceType: 'document' } }
    : resourceId === 'gone'
      ? { status: 'unavailable' }
      : { status: 'pending' }
);

function renderBody(markdown: string, resolve: CitationResolver = resolver): HTMLElement {
  const { container } = render(
    <CitationResolutionContext.Provider value={resolve}>
      <MarkdownBody>{markdown}</MarkdownBody>
    </CitationResolutionContext.Provider>,
  );
  return container;
}

beforeEach(() => {
  openExternal.mockClear();
  useUiStore.setState({ railOpen: false, railVariant: 'context', inspector: null });
});

describe('resource citations', () => {
  it('renders link syntax as an inline chip carrying the resource title', () => {
    renderBody('See the [Mute windows PRD](resource://prd-1) for detail.');

    const chip = screen.getByRole('button', { name: /Mute windows PRD/u });
    expect(chip.className).toContain('citation-chip');
    expect(chip.textContent).toBe('Mute windows PRD');
    expect(chip.closest('p')?.textContent).toBe('See the Mute windows PRD for detail.');
  });

  it('renders image syntax as an embed card, which is the announcement form', () => {
    const container = renderBody('Published it.\n\n![Mute windows PRD](resource://prd-1)\n');

    const card = container.querySelector('.citation-card');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Mute windows PRD');
    expect(container.querySelector('img')).toBeNull();
  });

  it('still reads the legacy bare spelling, so nothing already emitted breaks', () => {
    renderBody('The [plan](resource:prd-1) is ready.');

    expect(screen.getByRole('button', { name: /plan/u }).className).toContain('citation-chip');
  });

  it('opens the rail on the cited resource, opening the panel before selecting it', () => {
    renderBody('See the [Mute windows PRD](resource://prd-1).');

    screen.getByRole('button', { name: /Mute windows PRD/u }).click();

    // `openRail` clears the inspector, so the order is part of the contract:
    // a selection made first would be wiped by the panel opening after it.
    expect(useUiStore.getState()).toMatchObject({
      railOpen: true,
      railVariant: 'context',
      inspector: { type: 'resource', id: 'prd-1' },
    });
  });

  it('renders a chip while a lookup is still pending, from the label the message already carried', () => {
    renderBody('See [Another stream’s doc](resource://elsewhere).');

    expect(screen.getByRole('button', { name: /Another stream/u }).className).toContain('citation-chip');
  });

  it('degrades a resource the viewer cannot see to plain label text with no affordance', () => {
    const container = renderBody('See [A removed doc](resource://gone).');

    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('See A removed doc.');
  });

  it('degrades a malformed target to plain label text rather than a broken chip', () => {
    const container = renderBody('See [A doc](resource://../../etc/passwd).');

    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('See A doc.');
  });

  it('leaves an external link a link and an external image an image', () => {
    const container = renderBody('See [the report](https://example.com/r) and ![a chart](https://example.com/c.png).');

    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/r');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/c.png');
    expect(container.querySelector('.citation-chip')).toBeNull();
  });

  it('renders an identity in the embed position as a card that never navigates', () => {
    const container = renderBody('![@Ada](person:018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0)');

    const card = container.querySelector('.citation-card');
    expect(card?.tagName).toBe('SPAN');
    expect(card?.textContent).toContain('@Ada');
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('grounding footnotes', () => {
  const grounded = [
    'Revenue grew 40%.[^1] Costs held flat.[^2]',
    '',
    '[^1]: [Q3 board deck](resource://prd-1)',
    '[^2]: [The filing](https://sec.gov/x)',
  ].join('\n');

  it('renders each reference as an inline pill and no source list at the end', () => {
    const container = renderBody(grounded);

    const pills = container.querySelectorAll('.citation-pill');
    expect([...pills].map((pill) => pill.textContent)).toEqual(['1', '2']);
    expect(container.querySelector('.footnotes')).toBeNull();
    expect(container.textContent?.trim()).toBe('Revenue grew 40%.1 Costs held flat.2');
  });

  it('names the source on each pill, which is what its popover carries', () => {
    renderBody(grounded);

    expect(screen.getByRole('button', { name: 'Open Q3 board deck' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open The filing' })).toBeTruthy();
  });

  it('opens an internal source in the rail and an external source in the browser', () => {
    renderBody(grounded);

    screen.getByRole('button', { name: 'Open Q3 board deck' }).click();
    expect(useUiStore.getState().inspector).toEqual({ type: 'resource', id: 'prd-1' });

    screen.getByRole('button', { name: 'Open The filing' }).click();
    expect(openExternal).toHaveBeenCalledWith('https://sec.gov/x');
  });

  it('keeps a definition that is not a citation as a classic footnote', () => {
    const container = renderBody('A claim.[^1]\n\n[^1]: Just a note, with no link in it.');

    expect(container.querySelector('.citation-pill')).toBeNull();
    const footnotes = container.querySelector('.footnotes');
    expect(footnotes?.textContent).toContain('Just a note, with no link in it.');
  });

  it('renders only the definitions it did not lift, when a message mixes both', () => {
    const container = renderBody([
      'Cited.[^1] Noted.[^2]',
      '',
      '[^1]: [Q3 board deck](resource://prd-1)',
      '[^2]: A free-form remark.',
    ].join('\n'));

    expect(container.querySelectorAll('.citation-pill')).toHaveLength(1);
    const items = within(container.querySelector('.footnotes') as HTMLElement).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('A free-form remark.');
  });

  it('namespaces footnote ids per message, so two mounts cannot cross-wire', () => {
    const { container } = render(
      <CitationResolutionContext.Provider value={resolver}>
        <MarkdownBody>{'One.[^1]\n\n[^1]: A note.'}</MarkdownBody>
        <MarkdownBody>{'Two.[^1]\n\n[^1]: Another note.'}</MarkdownBody>
      </CitationResolutionContext.Provider>,
    );

    const ids = [...container.querySelectorAll('li[id]')].map((item) => item.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => !id.startsWith('user-content-'))).toBe(true);
  });

  it('leaves a reference whose definition never arrives as the literal text it is', () => {
    const container = renderBody('A claim.[^missing]');

    expect(container.querySelector('.citation-pill')).toBeNull();
    expect(container.textContent).toBe('A claim.[^missing]');
  });
});

describe('citations while a message is still streaming', () => {
  function renderStreaming(markdown: string): HTMLElement {
    const { container } = render(
      <CitationResolutionContext.Provider value={resolver}>
        <MarkdownBody streaming>{markdown}</MarkdownBody>
      </CitationResolutionContext.Provider>,
    );
    return container;
  }

  it('shows an unclosed citation as the text it currently is, then settles into a chip', () => {
    expect(renderStreaming('See the [Mute windows PRD](resource://pr').textContent)
      .toContain('[Mute windows PRD](resource://pr');

    const settled = renderStreaming('See the [Mute windows PRD](resource://prd-1) now.');
    expect(settled.querySelector('.citation-chip')?.textContent).toBe('Mute windows PRD');
  });

  it('leaves a reference literal until its definition has arrived, and heals at the end', () => {
    // Settled segments are parsed separately, so a reference in one and its
    // definition in another are not a footnote yet — the renderer's documented
    // behaviour for a split footnote, and no worse for a citation than for a
    // classic one. The commit that ends the stream parses the source whole.
    const source = [
      'Revenue grew 40%.[^1]',
      '',
      'A second settled paragraph.',
      '',
      '[^1]: [Q3 board deck](resource://prd-1)',
    ].join('\n');

    const streaming = renderStreaming(source);
    expect(streaming.querySelector('.citation-pill')).toBeNull();
    expect(streaming.textContent).toContain('Revenue grew 40%.[^1]');

    expect(renderBody(source).querySelector('.citation-pill')?.textContent).toBe('1');
  });
});
