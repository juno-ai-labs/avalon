import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SITE_MANIFEST_MIME_TYPE } from '@rally/contracts';
import type { CitationTarget } from '@rally/contracts/citations';
import { describe, expect, it, vi } from 'vitest';
import { CitationFootnoteSection, CitationsProvider } from './markdown-citations';
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
  it('opens an inline resource chip in the preview without opening the inspector', () => {
    const openPreview = vi.fn();
    const citations = context({ openPreview });
    render(<MarkdownBody citations={citations}>{'See [the deck](resource://board-deck).'}</MarkdownBody>);
    const chip = screen.getByRole('button', { name: 'Open Q3 board deck' });
    fireEvent.click(chip);
    expect(openPreview).toHaveBeenCalledWith(DECK.id, chip);
    expect(citations.open).not.toHaveBeenCalled();
  });
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
    // A lone embed is not a run: it keeps its paragraph, not a row of one.
    expect(document.querySelector('.citation-card-row')).toBeNull();
  });

  it('merges consecutive embed cards into one wrapping row', () => {
    render(
      <MarkdownBody citations={context()}>
        {'Two artifacts came out of this.\n\n![The deck](resource://board-deck)\n\n![The deck again](resource://board-deck)\n\nBoth are attached.'}
      </MarkdownBody>,
    );

    const row = document.querySelector('.citation-card-row');
    expect(row).not.toBeNull();
    expect(row!.querySelectorAll('.citation-card')).toHaveLength(2);
    // The row replaces the run's paragraphs outright: no card is left behind
    // in a paragraph of its own, and the prose around the run is untouched.
    expect(document.querySelectorAll('.citation-card')).toHaveLength(2);
    expect(row!.closest('p')).toBeNull();
    expect(screen.getByText('Two artifacts came out of this.')).toBeInTheDocument();
    expect(screen.getByText('Both are attached.')).toBeInTheDocument();
  });

  it('keeps a growing mixed embed run grouped before and after streaming settles', () => {
    const openPreview = vi.fn();
    const citations = context({ openPreview, resolve: (id) => ({ id, title: `${id}.png`, resourceType: id === 'notes' ? 'text' : 'image' }) });
    const first = '![One](resource://one)\n\n';
    const source = `${first}![Notes](resource://notes)\n\n![Two](resource://two)\n\n![Three](resource://three)\n\n![Four](resource://four)\n`;
    const view = render(<MarkdownBody citations={citations} streaming>{first}</MarkdownBody>);
    view.rerender(<MarkdownBody citations={citations} streaming>{source}</MarkdownBody>);
    expect(document.querySelectorAll('.citation-card-row')).toHaveLength(1);
    expect(document.querySelectorAll('.message-attachment-image-cell .citation-card')).toHaveLength(4);
    const overflow = screen.getByRole('button', { name: 'Open three.png' });
    fireEvent.click(overflow);
    expect(openPreview).toHaveBeenCalledWith('three', overflow, ['one', 'two', 'three', 'four'], 2);
    const before = document.querySelector('.citation-card-row')!.textContent;
    view.rerender(<MarkdownBody citations={citations}>{source}</MarkdownBody>);
    expect(document.querySelector('.citation-card-row')!.textContent).toBe(before);
    expect(document.querySelectorAll('.message-attachment-image-cell .citation-card')).toHaveLength(4);
    expect(document.querySelector('.citation-card-row')!.children[1]).toHaveTextContent('Notes');
  });

  it('keeps every image title in an exported still instead of hiding it behind a gallery count', () => {
    const citations = context({ resolve: (id) => ({ id, title: `${id}.png`, resourceType: 'image' }) });
    render(<MarkdownBody citations={citations} still>{['one', 'two', 'three', 'four'].map((id) => `![${id}](resource://${id})`).join('\n\n')}</MarkdownBody>);
    for (const id of ['one', 'two', 'three', 'four']) expect(screen.getByRole('button', { name: `Open ${id}.png` })).toHaveTextContent(id);
    expect(document.querySelector('.message-attachment-more')).toBeNull();
  });

  it('leaves a run of embeds alone when they render as text rather than as cards', () => {
    const run = 'Two of them.\n\n![The deck](resource://board-deck)\n\n![The other deck](resource://board-deck)\n\nBoth above.';

    // No citation context at all — surfaces that render MarkdownBody this way
    // (note detail, meeting notes, and the automation draft) show a
    // `resource://` image as its label text. Grouping those would
    // lay a run of sentences out side by side in a horizontal scroller.
    const { unmount } = render(<MarkdownBody>{run}</MarkdownBody>);
    expect(document.querySelector('.citation-card-row')).toBeNull();
    expect(document.body).toHaveTextContent('The deck');
    unmount();

    // Same again with a context that cannot resolve them: the matrix renders
    // label text for these too, so there is still no row to make.
    render(
      <MarkdownBody citations={context({ resolve: () => undefined })}>{run}</MarkdownBody>,
    );
    expect(document.querySelector('.citation-card-row')).toBeNull();
    expect(document.querySelector('.citation-card')).toBeNull();
  });

  it('stops a run at a neighbour the matrix draws as something else', () => {
    render(
      <MarkdownBody citations={context()}>
        {'![The deck](resource://board-deck)\n\n![A chart](https://example.com/c.png)\n\n![The deck again](resource://board-deck)'}
      </MarkdownBody>,
    );

    // A real image between two embeds is not part of the run: grouping across
    // it would put an `img` inside a row of cards and reorder the message.
    expect(document.querySelector('.citation-card-row')).toBeNull();
    expect(document.querySelectorAll('.citation-card')).toHaveLength(2);
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.com/c.png');
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

  it('labels a generated file by what it is, not that it was generated', () => {
    const generated = {
      id: 'packaging',
      title: 'Packaging & Pricing.pptx',
      resourceType: 'generated_file',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    const { unmount } = render(
      <MarkdownBody citations={context({ resolve: () => generated })}>
        {'![Packaging & Pricing](resource://packaging)'}
      </MarkdownBody>,
    );
    expect(screen.getByText('Deck')).toBeInTheDocument();
    expect(screen.queryByText('Generated file')).toBeNull();
    unmount();

    render(
      <MarkdownBody citations={context({
        resolve: () => ({
          id: 'memo',
          title: 'Strategy.docx',
          resourceType: 'generated_file',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      })}>
        {'![Strategy](resource://memo)'}
      </MarkdownBody>,
    );
    expect(screen.getByText('Document')).toBeInTheDocument();
  });

  it('marks a site with the rosette under both names it arrives with, and leaves a web link alone', () => {
    const { unmount } = render(
      <MarkdownBody citations={context({ resolve: () => ({ ...DECK, title: 'Offsite RSVP', resourceType: 'generated_site' }) })}>
        {'See [the RSVP page](resource://board-deck).'}
      </MarkdownBody>,
    );
    expect(document.querySelector('.citation-chip-icon .tabler-icon-rosette-asterisk')).not.toBeNull();
    unmount();

    // The same page reached as a generated file: the type says nothing, and
    // only the manifest MIME classifies it to the `site` attachment kind.
    const { unmount: unmountFile } = render(
      <MarkdownBody citations={context({ resolve: () => ({ ...DECK, title: 'Offsite RSVP', resourceType: 'generated_file', mimeType: SITE_MANIFEST_MIME_TYPE }) })}>
        {'See [the RSVP page](resource://board-deck).'}
      </MarkdownBody>,
    );
    expect(document.querySelector('.citation-chip-icon .tabler-icon-rosette-asterisk')).not.toBeNull();
    unmountFile();

    render(
      <MarkdownBody citations={context({ resolve: () => ({ ...DECK, title: 'Status page', resourceType: 'website' }) })}>
        {'See [the status page](resource://board-deck).'}
      </MarkdownBody>,
    );
    expect(document.querySelector('.citation-chip-icon .tabler-icon-rosette-asterisk')).toBeNull();
    expect(document.querySelector('.citation-chip-icon .lucide-link-2')).not.toBeNull();
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

  it('shows image resource bytes as the card preview', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image-preview');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const image = { ...DECK, title: 'Fjord Kaffe Oslo.png', resourceType: 'generated_file', mimeType: 'image/png' };
    const preview = vi.fn(async () => ({ kind: 'image' as const, blob: new Blob(['image'], { type: 'image/png' }) }));

    const { unmount } = render(
      <MarkdownBody citations={context({ preview, resolve: () => image })}>
        {'![Fjord Kaffe Oslo](resource://board-deck)'}
      </MarkdownBody>,
    );

    await waitFor(() => { expect(document.querySelector('.citation-card-image-preview')).not.toBeNull(); });
    const thumbnail = document.querySelector('.citation-card-image-preview');
    expect(thumbnail).not.toBeNull();
    expect(thumbnail).toHaveClass('citation-card-image-preview');
    expect(thumbnail).toHaveAttribute('src', 'blob:image-preview');
    expect(thumbnail).toHaveAttribute('loading', 'lazy');
    // The image is the whole card, matching an ordinary message attachment;
    // no file-kind badge or label is painted over the source pixels.
    expect(document.querySelector('.citation-card-badge')).toBeNull();
    expect(document.querySelector('.citation-card-preview')).toBeNull();

    unmount();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:image-preview');
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it('falls back to the ordinary card when Chromium cannot decode an image preview', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bad-image-preview');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const image = { ...DECK, title: 'Damaged scan.png', resourceType: 'uploaded_file', mimeType: 'image/png' };
    const preview = vi.fn(async () => ({ kind: 'image' as const, blob: new Blob(['not-png'], { type: 'image/png' }) }));

    const { unmount } = render(
      <MarkdownBody citations={context({ preview, resolve: () => image })}>
        {'![Damaged scan](resource://board-deck)'}
      </MarkdownBody>,
    );

    await waitFor(() => { expect(document.querySelector('.citation-card-image-preview')).not.toBeNull(); });
    fireEvent.error(document.querySelector('.citation-card-image-preview')!);

    expect(document.querySelector('.citation-card-image-preview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Damaged scan.png' })).toBeInTheDocument();
    unmount();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:bad-image-preview');
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it('keeps the card\'s empty room when a preview is unavailable or not offered', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('not convertible')));
    const { unmount } = render(
      <MarkdownBody citations={context({ preview: failing, resolve: () => ({ ...DECK, resourceType: 'image', mimeType: 'image/png' }) })}>
        {'![Q3 board deck](resource://board-deck)'}
      </MarkdownBody>,
    );
    await act(async () => { await Promise.resolve(); });

    // A rejection reads the same as no preview at all: no skeleton left
    // spinning, no error text inside a card that is a button.
    expect(document.querySelector('.citation-card-preview-skeleton')).toBeNull();
    expect(document.querySelector('.citation-card-preview')).toBeNull();
    expect(document.querySelector('.citation-card')).not.toBeNull();
    unmount();

    // A host offering no preview at all never leaves a skeleton behind.
    render(
      <MarkdownBody citations={context()}>{'![Q3 board deck](resource://board-deck)'}</MarkdownBody>,
    );
    expect(document.querySelector('.citation-card-preview-skeleton')).toBeNull();
  });

  it('asks for no preview in a still, which would keep a skeleton forever', () => {
    const preview = vi.fn(() => new Promise<{ kind: 'text'; text: string }>(() => undefined));
    render(
      <MarkdownBody citations={context({ preview, resolve: () => ({ ...DECK, resourceType: 'image', mimeType: 'image/png' }) })} still>
        {'![Q3 board deck](resource://board-deck)'}
      </MarkdownBody>,
    );

    expect(preview).not.toHaveBeenCalled();
    expect(document.querySelector('.citation-card-preview-skeleton')).toBeNull();
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

  it('resolves a footnote whose definition lives under a later heading', () => {
    // Heading collapse mounts each section as its own react-markdown tree.
    // A [^rev] in Claims used to stay literal because the definition sat in
    // Sources, a different parse — the same seam streaming used to heal by
    // re-parsing the whole document after settle.
    const markdown = [
      '## Claims',
      '',
      'Revenue grew 40%.[^rev]',
      '',
      '## Sources',
      '',
      '[^rev]: [Q3 board deck](resource://board-deck), slide 4',
      '',
    ].join('\n');
    render(<MarkdownBody citations={context()} collapseHeadings>{markdown}</MarkdownBody>);
    expect([...document.querySelectorAll('.citation-pill')].map((pill) => pill.textContent)).toEqual(['1']);
    expect(document.querySelector('.footnotes')).toBeNull();
  });

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

  it('keeps a pill and its source when GFM percent-encodes the identifier', () => {
    // GFM writes the DOM id as `normalizeUri(id.toLowerCase())`, so a non-ASCII
    // identifier reaches the renderer escaped. Keying by the plain text lost
    // the pill *and* — because the section guard read the unencoded keys, which
    // still matched — the whole footnote section, so the source left the
    // message. Both `[^café]` and `[^100%]` are ordinary model output.
    render(
      <MarkdownBody citations={context()}>
        {'Revenue grew 40%.[^café] Margin held.[^100%]\n\n[^café]: [Q3 board deck](resource://board-deck)\n[^100%]: [Margin memo](https://example.com/memo)\n'}
      </MarkdownBody>,
    );

    expect([...document.querySelectorAll('.citation-pill')].map((pill) => pill.textContent)).toEqual(['1', '2']);
    expect(screen.getByRole('button', { name: /Q3 board deck/u })).toBeInTheDocument();
  });

  it('leaves a footnote section it recognised nothing in alone', () => {
    // Driven through the provider rather than through markdown, because the
    // state this guards is one no input produces *today*: an empty `numbers`
    // beneath a section GFM did build, which is what any future divergence
    // between this grammar and remark-gfm would look like. The guard is an
    // equality, and an empty map satisfies it vacuously — so without the size
    // check that divergence deletes the section instead of leaving a redundant
    // one. Every other degradation here errs toward showing too much; this one
    // has to as well.
    render(
      <CitationsProvider value={{ footnotes: new Map(), numbers: new Map(), prefix: 'c1-' }}>
        <CitationFootnoteSection section={{ className: 'footnotes' }}>
          <p>A source this module never recognised.</p>
        </CitationFootnoteSection>
      </CitationsProvider>,
    );

    expect(document.querySelector('.footnotes')).toHaveTextContent('A source this module never recognised.');
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
    expect(popover).toHaveTextContent('Opens in preview');
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

describe('citations while a turn streams', () => {
  const claim = 'The connector source recognises the gap.[^avalon] It says so plainly.';
  const definition = '\n\n[^avalon]: [packages/connectors/src/index.ts](resource://board-deck)\n';

  it('stands a pill-shaped skeleton where a definition has not arrived yet', () => {
    // The reference and its definition are seconds apart on the wire: the model
    // writes the marker mid-sentence and the `[^avalon]: …` line at the bottom
    // of the answer. remark-gfm reads a reference it cannot resolve as text, so
    // for that whole stretch the reader watched raw `[^avalon]` sit in a
    // paragraph — Rally showing somebody its own markup.
    render(<MarkdownBody citations={context()} streaming>{claim}</MarkdownBody>);

    expect(document.querySelectorAll('.citation-pill-pending')).toHaveLength(1);
    expect(document.body).not.toHaveTextContent('[^avalon]');
    // The words around it are untouched — this replaces the marker, not the line.
    expect(document.body).toHaveTextContent('The connector source recognises the gap. It says so plainly.');
  });

  it('covers a reference that is still being typed, before its bracket closes', () => {
    // The tail is the one place a half-written reference exists. Without this
    // the reader gets the same raw markup one character at a time — `[^`,
    // `[^a`, `[^av` — which is the artefact by a slower route.
    render(<MarkdownBody citations={context()} streaming>{'The gap is real.[^ava'}</MarkdownBody>);

    expect(document.querySelectorAll('.citation-pill-pending')).toHaveLength(1);
    expect(document.body).not.toHaveTextContent('[^ava');
    expect(document.body).toHaveTextContent('The gap is real.');
  });

  it('shows nothing at all for the bare bracket that has not said what it opens', () => {
    // One character in, `[` could still become a citation, a link, a task
    // list's box, or a bracket in prose. Drawing a pill would flash one in
    // front of every link; leaving it puts a citation's opening bracket on
    // screen. Waiting a frame is the only answer right whichever it becomes.
    render(<MarkdownBody citations={context()} streaming>{'The gap is real.['}</MarkdownBody>);

    expect(document.querySelector('.citation-pill-pending')).toBeNull();
    expect(document.body).not.toHaveTextContent('real.[');
    expect(document.body).toHaveTextContent('The gap is real.');
  });

  it('leaves an escaped marker escaped, rather than skeletoning what someone hid on purpose', () => {
    // `\\[^avalon]` reaches the rewrite as a text node reading `[^avalon]` —
    // micromark consumes the backslash before any plugin runs — so a rewrite
    // that trusted the decoded value would cover syntax the author escaped to
    // show, and then hand it back at settle when the escape is honoured.
    const view = render(
      <MarkdownBody citations={context()} streaming>{'Write it as \\[^avalon] in the body.'}</MarkdownBody>,
    );

    expect(document.querySelector('.citation-pill-pending')).toBeNull();
    expect(document.body).toHaveTextContent('Write it as [^avalon] in the body.');

    // The settled render already showed the literal; the point is that the
    // streaming one does not disagree with it.
    view.rerender(<MarkdownBody citations={context()}>{'Write it as \\[^avalon] in the body.'}</MarkdownBody>);
    expect(document.body).toHaveTextContent('Write it as [^avalon] in the body.');
  });

  it('leaves an escaped marker escaped in the open tail too', () => {
    render(<MarkdownBody citations={context()} streaming>{'Write it as \\[^ava'}</MarkdownBody>);

    expect(document.querySelector('.citation-pill-pending')).toBeNull();
    expect(document.body).toHaveTextContent('Write it as [^ava');
  });

  it('keeps a real marker covered when an escaped one follows it in the same paragraph', () => {
    // Caught in a live window rather than here: with a verdict on the whole
    // text run, the real marker's skeleton appeared while the sentence was
    // short and then *vanished* as the escaped one streamed in behind it,
    // reverting to raw `[^avalon]` mid-turn — the same defect the escape guard
    // was added to remove, arriving by the other door. Whether a match
    // qualifies now depends only on the text before it, which has already
    // arrived, so a skeleton drawn once is never taken back.
    const source = 'A real marker.[^avalon] An escaped one \\[^avalon] stays text.';
    const view = render(<MarkdownBody citations={context()} streaming>{'A real marker.[^avalon] An escaped one'}</MarkdownBody>);
    expect(document.querySelectorAll('.citation-pill-pending')).toHaveLength(1);

    view.rerender(<MarkdownBody citations={context()} streaming>{source}</MarkdownBody>);

    expect(document.querySelectorAll('.citation-pill-pending')).toHaveLength(1);
    expect(document.body).toHaveTextContent('A real marker. An escaped one [^avalon] stays text.');
  });

  it('leaves a character reference alone, which decodes to the same characters', () => {
    // `&#91;` is the other way to write a bracket that is not syntax, and it
    // reaches a text node indistinguishable from one that is.
    render(<MarkdownBody citations={context()} streaming>{'Write it as &#91;^avalon] in the body.'}</MarkdownBody>);

    expect(document.querySelector('.citation-pill-pending')).toBeNull();
    expect(document.body).toHaveTextContent('Write it as [^avalon] in the body.');
  });

  it('hands the skeleton over to the numbered pill when the turn settles', () => {
    const view = render(<MarkdownBody citations={context()} streaming>{claim}</MarkdownBody>);
    expect(document.querySelectorAll('.citation-pill-pending')).toHaveLength(1);

    view.rerender(<MarkdownBody citations={context()}>{`${claim}${definition}`}</MarkdownBody>);

    expect(document.querySelector('.citation-pill-pending')).toBeNull();
    expect([...document.querySelectorAll('.citation-pill')].map((pill) => pill.textContent)).toEqual(['1']);
  });

  it('resolves the skeleton mid-stream once a later section defines it', () => {
    // Heading collapse copies a definition onto the fragments that do not carry
    // it, so in the feed the skeleton does not have to wait for the turn to
    // end. This is the path the main transcript actually takes.
    const heading = ['## Claims', '', claim, '', '## Sources', '', ''].join('\n');
    const view = render(<MarkdownBody citations={context()} collapseHeadings streaming>{heading}</MarkdownBody>);
    expect(document.querySelectorAll('.citation-pill-pending')).toHaveLength(1);

    view.rerender(
      <MarkdownBody citations={context()} collapseHeadings streaming>
        {`${heading}[^avalon]: [packages/connectors/src/index.ts](resource://board-deck)\n`}
      </MarkdownBody>,
    );

    expect(document.querySelector('.citation-pill-pending')).toBeNull();
    expect([...document.querySelectorAll('.citation-pill')].map((pill) => pill.textContent)).toEqual(['1']);
  });

  it('leaves a settled reference nothing ever defined as ordinary text', () => {
    // A skeleton is a promise that a source is coming. Once the turn is over,
    // nothing is coming, and the literal marker is the honest rendering.
    render(<MarkdownBody citations={context()}>{claim}</MarkdownBody>);

    expect(document.querySelector('.citation-pill-pending')).toBeNull();
    expect(document.body).toHaveTextContent('[^avalon]');
  });

  it('leaves footnote syntax inside code as code', () => {
    // A message explaining the syntax is ordinary Rally output, and both forms
    // of code keep their source as their own value rather than as text.
    const source = 'Write `[^1]` in the body.\n\n```md\nA claim.[^1]\n```\n\nThen define it.[^1\n';
    render(<MarkdownBody citations={context()} streaming>{source}</MarkdownBody>);

    expect(document.querySelector('code')).toHaveTextContent('[^1]');
    expect(document.querySelector('.markdown-code-block')).toHaveTextContent('A claim.[^1]');
    // The one outside code — the half-written tail — is the only skeleton.
    expect(document.querySelectorAll('.citation-pill-pending')).toHaveLength(1);
  });

  it('is not drawn on a saved still, because a still is never streamed', () => {
    // Named for the surface, but `still` is not the mechanism and must not be
    // read as one: the suppression is `streaming` being off, which a still
    // always is. Kept beside the settled test rather than folded into it
    // because the export card is its own caller, and a future `still` that
    // somehow streamed would be the bug this pins the expectation for.
    render(<MarkdownBody citations={context()} still streaming={false}>{claim}</MarkdownBody>);

    expect(document.querySelector('.citation-pill-pending')).toBeNull();
  });

  it('leaves a half-written marker alone once text has arrived after it', () => {
    // `[^ava more` is not a reference being typed — it is prose containing a
    // bracket, and the end-anchor is what tells them apart. Pinned so that
    // widening the open pattern has to fail a test.
    render(<MarkdownBody citations={context()} streaming>{'The gap is real.[^ava more'}</MarkdownBody>);

    expect(document.querySelector('.citation-pill-pending')).toBeNull();
    expect(document.body).toHaveTextContent('The gap is real.[^ava more');
  });
});
