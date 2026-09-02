import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const RECORDING: CitationResource = {
  id: 'board-deck',
  title: 'Inbox Brief.mp3',
  resourceType: 'generated_file',
  mimeType: 'audio/mpeg',
};

/**
 * Playback, which jsdom does not implement: `play()` throws "not implemented",
 * and `paused` is a getter frozen at true.
 *
 * The double dispatches the element's own events rather than resolving
 * silently, because that is what the card reads — it never sets its label from
 * the click. A stub that only recorded the call would leave every assertion
 * about the button's name asserting on the double's configuration.
 */
function stubPlayback(): { played: HTMLMediaElement[]; restore: () => void } {
  const media = HTMLMediaElement.prototype;
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  const played: HTMLMediaElement[] = [];
  const original = {
    paused: Object.getOwnPropertyDescriptor(media, 'paused'),
    play: media.play,
    pause: media.pause,
  };
  Object.defineProperty(media, 'paused', {
    configurable: true,
    get(this: HTMLMediaElement) { return paused.get(this) ?? true; },
  });
  media.play = function play(this: HTMLMediaElement) {
    paused.set(this, false);
    played.push(this);
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  };
  media.pause = function pause(this: HTMLMediaElement) {
    paused.set(this, true);
    this.dispatchEvent(new Event('pause'));
  };
  return {
    played,
    restore: () => {
      if (original.paused) Object.defineProperty(media, 'paused', original.paused);
      media.play = original.play;
      media.pause = original.pause;
    },
  };
}

/** What the element would say about itself at one moment, and the event saying so. */
function reportMedia(
  element: HTMLMediaElement,
  state: { currentTime: number; duration: number },
  event: 'durationchange' | 'timeupdate',
): void {
  Object.defineProperty(element, 'currentTime', { configurable: true, value: state.currentTime });
  Object.defineProperty(element, 'duration', { configurable: true, value: state.duration });
  act(() => { element.dispatchEvent(new Event(event)); });
}

/** A work stream whose resource set holds exactly the deck, and which records opens. */
function context(overrides: Partial<CitationContext> = {}): CitationContext & { open: ReturnType<typeof vi.fn> } {
  const open = vi.fn<(target: CitationTarget) => void>();
  return {
    open,
    resolve: (resourceId) => (resourceId === DECK.id ? DECK : undefined),
    ...overrides,
  } as CitationContext & { open: ReturnType<typeof vi.fn> };
}

/** Mount a card, deliver a derivative, and return the glance node. */
async function showPreview(derivative: string): Promise<HTMLElement> {
  let deliver: (text: string) => void = () => undefined;
  const preview = vi.fn(() => new Promise<{ kind: 'text'; text: string }>((resolve) => {
    deliver = (text) => { resolve({ kind: 'text', text }); };
  }));
  render(
    <MarkdownBody citations={context({ preview })}>
      {'![Q3 board deck](resource://board-deck)'}
    </MarkdownBody>,
  );
  await act(async () => { deliver(derivative); });
  const excerpt = document.querySelector('.citation-card-preview');
  expect(excerpt).not.toBeNull();
  return excerpt as HTMLElement;
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
    // A lone embed is not a run: it keeps its paragraph, not a row of one.
    expect(document.querySelector('.citation-card-row')).toBeNull();
  });

  it('merges consecutive embed cards into one scrollable row', () => {
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

  it('leaves a run of embeds alone when they render as text rather than as cards', () => {
    const run = 'Two of them.\n\n![The deck](resource://board-deck)\n\n![The other deck](resource://board-deck)\n\nBoth above.';

    // No citation context at all — the five surfaces that render MarkdownBody
    // this way (the block dashboard, note detail, meeting notes, the automation
    // draft) show a `resource://` image as its label text. Grouping those would
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

  it('shows the resource\'s converted markdown in the card, under a shimmering skeleton while it converts', async () => {
    let deliver: (text: string) => void = () => undefined;
    const preview = vi.fn(() => new Promise<{ kind: 'text'; text: string }>((resolve) => {
      deliver = (text) => { resolve({ kind: 'text', text }); };
    }));
    render(
      <MarkdownBody citations={context({ preview })}>
        {'![Q3 board deck](resource://board-deck)'}
      </MarkdownBody>,
    );

    // The card is asking, so the room holds a skeleton and not an empty box.
    expect(document.querySelector('.citation-card-preview-skeleton')).not.toBeNull();
    expect(document.querySelector('.citation-card-preview')).toBeNull();
    expect(preview).toHaveBeenCalledWith('board-deck');

    // The derivative is what shows — the markdown a Word file was converted
    // into, not its bytes. The card renders that markdown (a heading is a
    // heading, emphasis is strong) rather than printing the markers.
    await act(async () => { deliver('## Revenue\n\n**Author:** Product. Up 14% on the quarter.'); });

    const excerpt = document.querySelector('.citation-card-preview');
    expect(excerpt).not.toBeNull();
    expect(excerpt).toHaveTextContent('Up 14% on the quarter.');
    expect(excerpt!.querySelector('.markdown-body')).not.toBeNull();
    expect(excerpt!.querySelector('h2')).toHaveTextContent('Revenue');
    expect(excerpt!.textContent).not.toContain('#');
    expect(excerpt!.querySelector('strong')).toHaveTextContent('Author:');
    expect(excerpt!.textContent).not.toContain('**');
    expect(excerpt).toHaveAttribute('inert');
    expect(document.querySelector('.citation-card-preview-skeleton')).toBeNull();
    // A preview is presentation: the button still announces the title alone.
    expect(excerpt).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Open Q3 board deck' })).toBeInTheDocument();
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
    expect(screen.getByText('Image')).toBeInTheDocument();
    expect(document.querySelector('.citation-card-badge .lucide-image')).not.toBeNull();
    expect(document.querySelector('.citation-card-badge .lucide-file')).toBeNull();
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

  it('plays an announced recording from the card instead of printing its bytes', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const playback = stubPlayback();
    const preview = vi.fn(async () => ({ kind: 'audio' as const, blob: new Blob(['id3'], { type: 'audio/mpeg' }) }));

    const { unmount } = render(
      <MarkdownBody citations={context({ preview, resolve: () => RECORDING })}>
        {'![Inbox Brief](resource://board-deck)'}
      </MarkdownBody>,
    );

    await waitFor(() => { expect(document.querySelector('audio')).not.toBeNull(); });
    const element = document.querySelector('audio')!;
    expect(element).toHaveAttribute('src', 'blob:recording');
    // The defect: audio read as a derivative filled the room with the file's
    // own bytes decoded as text.
    expect(document.querySelector('.citation-card-preview')).toBeNull();
    expect(document.body.textContent).not.toContain('id3');

    const play = screen.getByRole('button', { name: 'Play Inbox Brief.mp3' });
    fireEvent.click(play);
    expect(playback.played).toContain(element);
    // The label follows the element, not the click, so it cannot claim to be
    // playing something that stopped.
    const pause = await screen.findByRole('button', { name: 'Pause Inbox Brief.mp3' });
    fireEvent.click(pause);
    expect(await screen.findByRole('button', { name: 'Play Inbox Brief.mp3' })).toBeInTheDocument();

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:recording');
    playback.restore();
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it('shows where the recording is, in a media clock', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const playback = stubPlayback();
    const preview = vi.fn(async () => ({ kind: 'audio' as const, blob: new Blob(['id3'], { type: 'audio/mpeg' }) }));

    const { unmount } = render(
      <MarkdownBody citations={context({ preview, resolve: () => RECORDING })}>
        {'![Inbox Brief](resource://board-deck)'}
      </MarkdownBody>,
    );

    await waitFor(() => { expect(document.querySelector('audio')).not.toBeNull(); });
    const element = document.querySelector('audio')!;

    reportMedia(element, { duration: 225, currentTime: 45 }, 'durationchange');
    reportMedia(element, { duration: 225, currentTime: 45 }, 'timeupdate');
    expect(document.querySelector('.citation-card-elapsed')).toHaveTextContent('0:45 / 3:45');
    // The bar is drawn from the property, so the position is one node's style
    // rather than a child React reconciles on every tick.
    expect(document.querySelector('.citation-card-progress')!.getAttribute('style'))
      .toContain('--citation-card-played: 20%');

    // A container that carries no duration reports Infinity; a clock reading
    // "Infinity" is worse than a clock that only says where you are.
    reportMedia(element, { duration: Number.POSITIVE_INFINITY, currentTime: 3661 }, 'durationchange');
    reportMedia(element, { duration: Number.POSITIVE_INFINITY, currentTime: 3661 }, 'timeupdate');
    expect(document.querySelector('.citation-card-elapsed')).toHaveTextContent('1:01:01');
    expect(document.querySelector('.citation-card-elapsed')!.textContent).not.toContain('/');

    // Unmounted before the prototype goes back: the card pauses its element on
    // the way out, and jsdom's own `pause()` throws.
    unmount();
    playback.restore();
    createObjectURL.mockRestore();
    vi.mocked(URL.revokeObjectURL).mockRestore?.();
  });

  it('keeps the open click on the title and the play click on the transport', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const playback = stubPlayback();
    const preview = vi.fn(async () => ({ kind: 'audio' as const, blob: new Blob(['id3'], { type: 'audio/mpeg' }) }));
    const citations = context({ preview, resolve: () => RECORDING });

    const { unmount } = render(
      <MarkdownBody citations={citations}>{'![Inbox Brief](resource://board-deck)'}</MarkdownBody>,
    );

    await waitFor(() => { expect(document.querySelector('audio')).not.toBeNull(); });
    // The card is a container, not one button: a control cannot nest inside a
    // button, and a play control that opened the rail would be the same defect
    // the other way round.
    expect(document.querySelector('.citation-card')!.tagName).toBe('DIV');
    expect(document.querySelector('.citation-card button')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Play Inbox Brief.mp3' }));
    expect(citations.open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open Inbox Brief.mp3' }));
    expect(citations.open).toHaveBeenCalledExactlyOnceWith({ scheme: 'resource', resourceId: 'board-deck' });

    // Unmounted before the prototype goes back: the card pauses its element on
    // the way out, and jsdom's own `pause()` throws.
    unmount();
    playback.restore();
    createObjectURL.mockRestore();
    vi.mocked(URL.revokeObjectURL).mockRestore?.();
  });

  it('stops the recording that was playing when another card starts', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const playback = stubPlayback();
    const second = { ...RECORDING, id: 'standup', title: 'Standup recap.mp3' };
    const preview = vi.fn(async () => ({ kind: 'audio' as const, blob: new Blob(['id3'], { type: 'audio/mpeg' }) }));

    const { unmount } = render(
      <MarkdownBody
        citations={context({
          preview,
          resolve: (id) => (id === 'standup' ? second : RECORDING),
        })}
      >
        {'![Inbox Brief](resource://board-deck)\n\n![Standup recap](resource://standup)'}
      </MarkdownBody>,
    );

    await waitFor(() => { expect(document.querySelectorAll('audio')).toHaveLength(2); });
    fireEvent.click(screen.getByRole('button', { name: 'Play Inbox Brief.mp3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play Standup recap.mp3' }));

    // Two recordings sounding at once is not a mix anybody chose.
    expect(await screen.findByRole('button', { name: 'Play Inbox Brief.mp3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause Standup recap.mp3' })).toBeInTheDocument();

    // Unmounted before the prototype goes back: the card pauses its element on
    // the way out, and jsdom's own `pause()` throws.
    unmount();
    playback.restore();
    createObjectURL.mockRestore();
    vi.mocked(URL.revokeObjectURL).mockRestore?.();
  });

  it('keeps two paragraphs as two paragraphs instead of collapsing the seam', async () => {
    const excerpt = await showPreview('First paragraph here.\n\nSecond paragraph here.');
    expect(excerpt.querySelectorAll('p')).toHaveLength(2);
  });

  it('does not promote a paragraph above a rule into a heading', async () => {
    const excerpt = await showPreview('Quarterly report\n\n---\n\nRevenue was up.');
    expect(excerpt.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(excerpt.querySelector('hr')).not.toBeNull();
    expect(excerpt).toHaveTextContent('Quarterly report');
    expect(excerpt).toHaveTextContent('Revenue was up.');
  });

  it('does not swallow the paragraph after a list into the last item', async () => {
    const excerpt = await showPreview('Findings:\n\n- one\n- two\n\nNext paragraph.');
    expect(excerpt.querySelector('li:last-child')).toHaveTextContent(/^two$/u);
    expect(excerpt.querySelector('p:last-of-type')).toHaveTextContent('Next paragraph.');
  });

  it('still opens an ordered list that does not start at one', async () => {
    const excerpt = await showPreview('Agenda:\n\n2. second\n3. third');
    const list = excerpt.querySelector('ol');
    expect(list).not.toBeNull();
    expect(list).toHaveAttribute('start', '2');
    expect(excerpt.textContent).not.toMatch(/2\.\s+second/u);
  });

  it('does not nest a copy control or a link inside the card button', async () => {
    const excerpt = await showPreview(
      'Notes\n\n```js\nconst a = 1;\n```\n\nSee [the source](https://example.com)',
    );
    // queryAllByRole would be 0 for any content: the glance is aria-hidden.
    expect(excerpt.querySelectorAll('button, a[href]')).toHaveLength(0);
    expect(excerpt).toHaveTextContent('const a = 1;');
    expect(excerpt).toHaveTextContent('the source');
  });

  it('does not fetch an external image from the glance', async () => {
    const excerpt = await showPreview('Chart follows.\n\n![chart](https://attacker.example/pixel.png)');
    expect(excerpt.querySelector('img')).toBeNull();
    expect(excerpt).toHaveTextContent('chart');
  });

  it('keeps the card\'s empty room when a preview is unavailable or not offered', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('not convertible')));
    const { unmount } = render(
      <MarkdownBody citations={context({ preview: failing })}>
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
      <MarkdownBody citations={context({ preview })} still>
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
