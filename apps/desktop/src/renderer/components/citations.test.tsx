import { fireEvent, render, screen, within } from '@testing-library/react';
import type { CitationTarget } from '@rally/contracts/citations';
import { describe, expect, it, vi } from 'vitest';
import type { CitationContext, CitationResource } from './markdown-citations';
import { MarkdownBody } from './workstream-blocks';

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText: vi.fn(), exportMessage: vi.fn(), reportTelemetryProductIntent: vi.fn() }),
  desktopServicesAvailable: () => false,
}));

const DECK: CitationResource = { id: 'board-deck', title: 'Q3 board deck', resourceType: 'document' };

/** A work stream whose resource set holds exactly the deck, and which records opens. */
function context(overrides: Partial<CitationContext> = {}): CitationContext & { open: ReturnType<typeof vi.fn> } {
  const open = vi.fn<(target: CitationTarget) => void>();
  return {
    open,
    resolve: (resourceId) => (resourceId === DECK.id ? DECK : undefined),
    ...overrides,
  } as CitationContext & { open: ReturnType<typeof vi.fn> };
}

describe('resource citations', () => {
  it('renders the link form as an inline chip carrying the resource title', () => {
    render(
      <MarkdownBody citations={context()}>
        {'Ship it — see [the deck](resource://board-deck) for the numbers.'}
      </MarkdownBody>,
    );

    const chip = screen.getByRole('button', { name: /Q3 board deck/u });
    expect(chip).toHaveClass('citation-chip');
    // The model's own words are the label; the record supplies the icon and kind.
    expect(chip).toHaveTextContent('the deck');
    expect(chip).toHaveAttribute('data-resource-type', 'document');
    // The chip sits inside the sentence, not in a block of its own.
    expect(chip.closest('p')).toHaveTextContent('Ship it — see the deck for the numbers.');
  });

  it('renders the image form as an embedded block card', () => {
    render(
      <MarkdownBody citations={context()}>
        {'Published the review.\n\n![Q3 board deck](resource://board-deck)\n'}
      </MarkdownBody>,
    );

    const card = screen.getByRole('button', { name: /Q3 board deck/u });
    expect(card).toHaveClass('citation-card');
    // The card lands between sentences rather than cutting one into three, and
    // it does so because image syntax is block-level to the model that wrote it
    // — not because the renderer guessed. What that buys is asserted here: the
    // card's own paragraph carries the card and nothing else.
    expect(card.closest('p')?.textContent).toBe(card.textContent);
    expect(screen.getByText('Published the review.').contains(card)).toBe(false);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('reads a resource kind as words rather than as its system identifier', () => {
    render(
      <MarkdownBody citations={context({ resolve: () => ({ ...DECK, resourceType: 'github_pull_request' }) })}>
        {'![The fix](resource://board-deck)'}
      </MarkdownBody>,
    );

    // `capitalize` on the raw value prints `Github_pull_request` at a person.
    expect(screen.getByText('Github pull request')).toBeInTheDocument();
  });

  it('opens the cited resource in the rail when either form is clicked', () => {
    const citations = context();
    render(
      <MarkdownBody citations={citations}>
        {'See [the deck](resource://board-deck).\n\n![The deck](resource://board-deck)\n'}
      </MarkdownBody>,
    );

    for (const control of screen.getAllByRole('button')) fireEvent.click(control);
    expect(citations.open).toHaveBeenCalledTimes(2);
    expect(citations.open).toHaveBeenCalledWith({ scheme: 'resource', resourceId: 'board-deck' });
  });

  it('renders an unresolvable target as the label text the message already carried', () => {
    render(
      <MarkdownBody citations={context()}>
        {'See [the missing deck](resource://not-here) and ![Gone](resource://also-gone)\n'}
      </MarkdownBody>,
    );

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    // A chip adds an affordance, never disclosure: the label is all that shows.
    expect(document.body).toHaveTextContent('See the missing deck and Gone');
  });

  it('renders a malformed target as text without reaching the resolver', () => {
    const resolve = vi.fn(() => DECK);
    render(
      <MarkdownBody citations={context({ resolve })}>
        {'A [walk](resource://../../etc/passwd) and an [empty](resource://).'}
      </MarkdownBody>,
    );

    expect(screen.queryByRole('button')).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    // The label, and nothing the message did not already say. In particular no
    // anchor: an id the allowlist rejected must not reach the DOM as a target.
    expect(document.body).toHaveTextContent('A walk and an empty.');
    expect(document.body.innerHTML).not.toContain('resource:');
  });

  it('renders citations as plain text on a surface that cannot open one', () => {
    render(<MarkdownBody>{'See [the deck](resource://board-deck).'}</MarkdownBody>);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body).toHaveTextContent('See the deck.');
  });

  it('leaves an external image a real image and an external link a real link', () => {
    render(
      <MarkdownBody citations={context()}>
        {'![A chart](https://example.com/c.png) and [the docs](https://example.com/docs)'}
      </MarkdownBody>,
    );

    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.com/c.png');
    expect(screen.getByRole('link', { name: 'the docs' })).toHaveAttribute('href', 'https://example.com/docs');
  });

  it('keeps identities non-navigable in both syntax forms', () => {
    const citations = context();
    const personId = '0192f3ac-1b2c-7000-8000-abcdefabcdef';
    render(
      <MarkdownBody citations={citations} mentions={[{ type: 'person', personId, displayName: 'Ada', startOffset: 0, endOffset: 0 }]}>
        {`Ask [@Ada](person:${personId}) — ![@Ada](person:${personId})`}
      </MarkdownBody>,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    // The embed form of an identity is a card, and it opens nothing.
    expect(document.querySelector('.citation-identity-card')).not.toBeNull();
    for (const control of screen.queryAllByRole('button')) fireEvent.click(control);
    expect(citations.open).not.toHaveBeenCalled();
  });

  it('renders an image whose scheme means nothing here as its alt text', () => {
    // The default transform empties a scheme it rejects, which leaves an `img`
    // with no source — a broken-image placeholder in the middle of a turn. The
    // alt text is what the model wrote, and it is strictly more than that.
    render(<MarkdownBody citations={context()}>{'![A quarterly chart](mailto:someone@example.com)'}</MarkdownBody>);

    expect(screen.queryByRole('img')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.body).toHaveTextContent('A quarterly chart');
  });

  it('never lets an unknown scheme reach the DOM as a destination', () => {
    render(
      <MarkdownBody citations={context()}>
        {'[click](javascript:alert(1)) [file](file:///etc/passwd) ![x](data:text/html,<b>)'}
      </MarkdownBody>,
    );

    expect(document.body.innerHTML).not.toContain('javascript:');
    expect(document.body.innerHTML).not.toContain('file://');
    expect(document.body.innerHTML).not.toContain('data:text/html');
  });
});

describe('footnote citations', () => {
  const grounded = [
    'Revenue grew 40%.[^rev] Margin held.[^mar]',
    '',
    '[^rev]: [Q3 board deck](resource://board-deck), slide 4',
    '[^mar]: [Margin memo](https://example.com/memo)',
  ].join('\n');

  it('renders each reference as a numbered inline pill and no trailing list', () => {
    render(<MarkdownBody citations={context()}>{grounded}</MarkdownBody>);

    const pills = document.querySelectorAll('.citation-pill');
    expect([...pills].map((pill) => pill.textContent)).toEqual(['1', '2']);
    // The vertical cost of a source footer is the frustration this replaces.
    expect(document.querySelector('.footnotes')).toBeNull();
    expect(document.body).not.toHaveTextContent('Footnotes');
  });

  it('keeps the source list in a still, where no popover can be opened', () => {
    // The saved card is a picture: the export stylesheet hides the popover
    // because a hover affordance printed into a PNG is a grey box with no way
    // to dismiss it. Lifting the definitions as well left the card showing bare
    // numbers over nothing, and the sources gone from the file somebody keeps.
    render(<MarkdownBody citations={context()} still>{grounded}</MarkdownBody>);

    expect([...document.querySelectorAll('.citation-pill')].map((pill) => pill.textContent)).toEqual(['1', '2']);
    const list = document.querySelector('.footnotes');
    expect(list).not.toBeNull();
    expect(list).toHaveTextContent('Q3 board deck');
    expect(list).toHaveTextContent('Margin memo');
  });

  it('names the source in a popover, and says where opening it goes', async () => {
    render(<MarkdownBody citations={context()}>{grounded}</MarkdownBody>);

    // The popover is portalled out of the transcript deliberately: an
    // absolutely-positioned box inside a scroll container is clipped by it, and
    // a pill on the top line lost its popover entirely.
    fireEvent.focus(screen.getByRole('button', { name: /Q3 board deck/u }));
    const popover = await screen.findByRole('tooltip');
    expect(popover).toHaveTextContent('Q3 board deck');
    expect(popover).toHaveTextContent('slide 4');
    expect(popover).toHaveTextContent('Opens in Details');
    expect(popover.closest('.transcript-scroll')).toBeNull();
  });

  it('says an external source opens in the browser rather than in the app', async () => {
    render(<MarkdownBody citations={context()}>{grounded}</MarkdownBody>);

    fireEvent.focus(screen.getByRole('button', { name: /Margin memo/u }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Opens in your browser');
  });

  it('sends an internal source to the rail and an external one to the browser', () => {
    const citations = context();
    render(<MarkdownBody citations={citations}>{grounded}</MarkdownBody>);

    fireEvent.click(screen.getByRole('button', { name: /Q3 board deck/u }));
    fireEvent.click(screen.getByRole('button', { name: /Margin memo/u }));
    expect(citations.open.mock.calls.map(([target]) => target)).toEqual([
      { scheme: 'resource', resourceId: 'board-deck' },
      { scheme: 'external', url: 'https://example.com/memo' },
    ]);
  });

  it('keeps a definition that is not a citation as a classic footnote', () => {
    render(
      <MarkdownBody citations={context()}>
        {'A claim.[^rev] Another.[^note]\n\n[^rev]: [Q3 board deck](resource://board-deck)\n[^note]: Measured by hand, twice.\n'}
      </MarkdownBody>,
    );

    expect(document.querySelectorAll('.citation-pill')).toHaveLength(1);
    const list = document.querySelector('.footnotes ol');
    expect(list).not.toBeNull();
    // Only the free-form one is listed, and it keeps the number its reference shows.
    expect(list!.querySelectorAll('li')).toHaveLength(1);
    expect(within(list as HTMLElement).getByText(/Measured by hand/u)).toBeTruthy();
    expect(list!.querySelector('li')).toHaveAttribute('value', '2');
  });

  it('namespaces footnote ids per message so two mounts cannot cross-wire', () => {
    const source = 'A claim.[^n]\n\n[^n]: Free-form note.\n';
    render(<><MarkdownBody>{source}</MarkdownBody><MarkdownBody>{source}</MarkdownBody></>);

    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id).filter((id) => id.includes('fn'));
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('leaves a reference whose definition never arrived as ordinary text', () => {
    render(<MarkdownBody citations={context()}>{'A claim.[^gone]'}</MarkdownBody>);

    expect(document.querySelector('.citation-pill')).toBeNull();
    expect(document.body).toHaveTextContent('A claim.[^gone]');
  });

  it('keeps the marker and the source name when the cited resource cannot be resolved', async () => {
    const citations = context();
    render(
      <MarkdownBody citations={citations}>
        {'A claim.[^x]\n\n[^x]: [Some deck](resource://not-here)\n'}
      </MarkdownBody>,
    );

    // The reader loses the click, not the source's name — showing the marker at
    // all is what tells them the claim was sourced.
    const pill = screen.getByRole('button', { name: /Some deck/u });
    fireEvent.focus(pill);
    const popover = await screen.findByRole('tooltip');
    expect(popover).toHaveTextContent('Some deck');
    expect(popover).not.toHaveTextContent('Opens in');
    fireEvent.click(pill);
    expect(citations.open).not.toHaveBeenCalled();
  });
});
