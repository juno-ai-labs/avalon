import { fireEvent, render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_COLOR_RING, type WorkstreamAppearance } from '@rally/contracts';
import { glyphInk } from '../lib/project-palette';
import { Plus } from 'lucide-react';
import { AutomationGlyph, HexagonGlyph, resolveWorkstreamAppearance, SIDEKICK_RUNNING_MARKER, WorkstreamGlyph, WorkstreamMark, workstreamAppearance, type ResolvableAppearance } from './workstream-glyph';

describe('workstreamAppearance', () => {
  it('derives a stable color and icon from the work-stream id', () => {
    expect(workstreamAppearance('00000000-0000-7000-8000-000000000001'))
      .toEqual({ color: 'red', iconIndex: 0 });
    expect(workstreamAppearance('launch-room'))
      .toEqual({ color: 'lime', iconIndex: 7 });
  });

  it('never derives the neutral, so an unassigned work stream still reads as coloured', () => {
    // `black` is in the palette but not the ring. If it leaked into the
    // derivation, roughly one work stream in fifteen would look deliberately
    // unaccented when nobody had chosen anything.
    const derived = new Set<string>();
    for (let index = 0; index < 400; index += 1) {
      const { color } = workstreamAppearance(`work-stream-${index}`);
      expect(color).not.toBe('black');
      if (color) derived.add(color);
    }
    // And the whole ring is reachable, so the hash is not collapsing onto a few.
    expect(derived.size).toBe(PROJECT_COLOR_RING.length);
  });

  it('resolves one stored appearance to the same icon and colour in both treatments', () => {
    const saved = { icon: 'megaphone', color: 'blue' } satisfies WorkstreamAppearance;
    const glyph = render(<WorkstreamGlyph appearance={saved} id="launch-room" />).container;
    const mark = render(<WorkstreamMark appearance={saved} id="launch-room" />).container;

    expect(glyph.querySelector('.workstream-glyph-icon')).toHaveClass('lucide-megaphone');
    expect(mark.querySelector('.workstream-mark')).toHaveClass('lucide-megaphone');
    expect(mark.querySelector('.workstream-mark')).toHaveStyle({ color: 'var(--av-sys-color-project-blue)' });
    expect(glyph.querySelector('.workstream-glyph-shape')?.getAttribute('style'))
      .toContain('var(--av-sys-color-project-blue)');
  });

  it('inks a glyph from the colour it is actually painted, not the one the id generates', () => {
    // `launch-room` generates `lime`, one of the three fills that still take
    // black ink, and the saved colour is `black`, which takes white. That pair
    // is what tells the two apart: the glyph resolves one appearance now, and
    // inking off the wrong half of it would put black on a near-black fill.
    const saved = { icon: null, color: 'black' } satisfies WorkstreamAppearance;
    const generated = render(<WorkstreamGlyph id="launch-room" />).container;
    const stored = render(<WorkstreamGlyph appearance={saved} id="launch-room" />).container;

    expect(resolveWorkstreamAppearance('launch-room').colorKey).not.toBe('black');
    expect(generated.querySelector<HTMLElement>('.workstream-glyph')?.style.getPropertyValue('--glyph-ink'))
      .toBe('var(--av-sys-color-palette-ink-dark)');
    expect(stored.querySelector<HTMLElement>('.workstream-glyph')?.style.getPropertyValue('--glyph-ink'))
      .toBe('var(--av-sys-color-palette-ink-light)');
  });

  it('falls back to a drawable icon rather than blanking the window on a key it does not know', () => {
    // A client shipped before a key was added, opening a work stream that
    // already carries it. Rendering `undefined` as a component throws.
    const stored = { icon: 'not-in-this-build', color: 'blue' } satisfies ResolvableAppearance;
    const { Icon, color } = resolveWorkstreamAppearance('launch-room', stored);

    // Which icon it lands on is the id's own, and that moves whenever the
    // palette's length does — so assert it is that one rather than naming it.
    expect(Icon).toBe(resolveWorkstreamAppearance('launch-room').Icon);
    const { container } = render(<Icon className="probe" />);
    expect(container.querySelector('.probe')).toHaveClass('lucide');
    expect(color).toBe('var(--av-sys-color-project-blue)');
  });

  it('renders the derived theme token without exposing decoration to assistive technology', () => {
    const { container } = render(<WorkstreamGlyph id="launch-room" size={30} />);
    const glyph = container.querySelector<HTMLElement>('.workstream-glyph');

    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph).toHaveStyle({ height: '30px', width: '30px' });
    // The raw fill and nothing else. `PALETTE_INK` and its APCA floor are
    // computed against this token, so a second colour behind the symbol — the
    // 145deg gradient this used to carry, mixing 22% of `surface-default` into
    // the far stop — is a background the table was never measured against. That
    // one cost up to 19 Lc and put five fills under the floor. Asserted exactly,
    // so re-introducing any gradient or mix fails here.
    expect(container.querySelector('.workstream-glyph-shape')).toHaveStyle({
      background: 'var(--av-sys-color-project-lime)',
    });
  });
});

describe('HexagonGlyph', () => {
  it('draws a Sidekick and an empty slot as the one silhouette', () => {
    // The identity glyph and the new-Sidekick slot sit in the same strip at the
    // same size, so the shapes have to be the same path rather than two that are
    // kept in step by hand. Asserted against each other rather than against a
    // copy of the path, which would only prove this file agrees with itself.
    const identity = render(<AutomationGlyph id="launch-room" />).container;
    const slot = render(<HexagonGlyph fill="none" ink="var(--av-sys-color-text-muted)" symbol={Plus} />).container;

    const shape = identity.querySelector('.automation-glyph-shape');
    expect(shape?.getAttribute('d')).toBe(slot.querySelector('.automation-glyph-shape')?.getAttribute('d'));
    expect(shape).toHaveAttribute('fill', 'var(--av-sys-color-project-lime)');
    expect(slot.querySelector('.automation-glyph-shape')).toHaveAttribute('fill', 'none');
  });

  it('keeps the identity glyph inked and symbolled from its own id across the extraction', () => {
    // The fill, the ink and the symbol used to be set inline in
    // `AutomationGlyph`; all three are props threaded through `HexagonGlyph`
    // now. Dropping or transposing one would leave every existing Sidekick tile
    // with the wrong icon, or a symbol inked for a fill it is not on, and the
    // suite would stay green — the tests above only cover the action tile's.
    const { container } = render(<AutomationGlyph id="launch-room" />);
    const glyph = container.querySelector<HTMLElement>('.automation-glyph');
    const { color, colorKey, Icon } = resolveWorkstreamAppearance('launch-room');

    expect(container.querySelector('.automation-glyph-shape')).toHaveAttribute('fill', color);
    expect(glyph?.style.getPropertyValue('--glyph-ink')).toBe(glyphInk(colorKey));
    // `lime` takes black ink, so this is the pairing a transposition breaks.
    expect(glyph?.style.getPropertyValue('--glyph-ink')).toBe('var(--av-sys-color-palette-ink-dark)');
    expect(container.querySelector('svg svg')).toHaveClass(render(<Icon />).container.querySelector('svg')?.getAttribute('class') ?? '');
  });

  it('carries the symbol and the ink it was given, and stays out of the accessibility tree', () => {
    const { container } = render(
      <HexagonGlyph className="sidekick-new-glyph" fill="none" ink="var(--av-sys-color-text-muted)" symbol={Plus} />,
    );
    const glyph = container.querySelector<HTMLElement>('.automation-glyph');

    expect(glyph).toHaveClass('sidekick-new-glyph');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    // `.automation-glyph` draws its symbol in `--glyph-ink`, falling back to the
    // on-inverse ink a fill needs. An outlined hexagon has no fill to be legible
    // against, so leaving the variable unset would paint the plus near-white on
    // the sidebar's own surface.
    expect(glyph?.style.getPropertyValue('--glyph-ink')).toBe('var(--av-sys-color-text-muted)');
    expect(container.querySelector('.lucide-plus')).not.toBeNull();
  });
});

/**
 * A marker explains itself in a tooltip, and Radix refuses one outside a
 * provider. The app mounts one at its root; a test rendering a hexagon on its
 * own supplies the same thing rather than the marker carrying a provider of its
 * own, which would be a second one inside every window.
 */
function renderGlyph(ui: React.ReactNode): ReturnType<typeof render> {
  return render(<Tooltip.Provider>{ui}</Tooltip.Provider>);
}

/** Radix positions a tooltip with a `ResizeObserver`, which jsdom does not have. */
function stubResizeObserver(): void {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
}

describe('HexagonGlyph markers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('cuts the marker out of the fill it sits on rather than painting over it', () => {
    // `launch-room` draws `lime`, and the running marker is `success-base`. Two
    // greens: painted straight onto the fill the play would be a shape only its
    // own edge distinguishes, and on a Sidekick that drew `green` there would be
    // no edge at all. The knockout is what makes the separation independent of
    // which of the fifteen fills this Sidekick happens to have, so the hexagon
    // being masked *by the marker* is the behaviour, not decoration.
    const { container } = renderGlyph(<AutomationGlyph id="launch-room" marker={SIDEKICK_RUNNING_MARKER} />);
    const shape = container.querySelector('.automation-glyph-shape');
    const mask = container.querySelector('mask');

    expect(mask?.id).toBeTruthy();
    expect(shape).toHaveAttribute('mask', `url(#${mask?.id})`);
    // The cut follows the marker's own outline, dilated by a stroke so a gap is
    // left around it. A rect or a circle in here would be a hole the shape of
    // something else, which is the treatment this replaced.
    const knockout = mask?.querySelector('.automation-glyph-knockout');
    expect(knockout).toHaveClass('lucide-play');
    expect(knockout).toHaveAttribute('stroke', 'black');
    expect(Number(knockout?.getAttribute('stroke-width'))).toBeGreaterThan(0);
    // A Lucide icon is a nested `<svg>`, and the UA stylesheet clips one to its
    // own viewport. `Play` reaches within about 3 units of that box, so without
    // this the dilating stroke is cut off square at three edges and the gap
    // stops following the symbol — which is the whole behaviour. jsdom does no
    // layout and cannot see the clip, so the attribute is the only part of this
    // a test can hold; the rendered proof is in the changelog.
    expect(knockout).toHaveAttribute('overflow', 'visible');
  });

  it('paints the marker in its own colour, over the hole and not stroked', () => {
    const { container } = renderGlyph(<AutomationGlyph id="launch-room" marker={SIDEKICK_RUNNING_MARKER} />);
    const marker = container.querySelector('.automation-glyph-marker');

    expect(marker).toHaveClass('lucide-play');
    expect(marker).toHaveAttribute('fill', 'var(--av-sys-color-success-base)');
    // Filled rather than outlined: at the rail's 36px the marker is about 7px
    // across and a 2-unit stroke is most of the symbol.
    expect(marker).toHaveAttribute('stroke', 'none');
    // Painted after the shape, so the hole it fills is already cut.
    expect(container.querySelector('.automation-glyph-shape')?.compareDocumentPosition(marker!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('gives every hexagon on the page its own mask, because SVG ids are document-global', () => {
    // One id shared by the strip's tiles would point all of them at the first
    // Sidekick's mask. It would look right until a second marker differed.
    const { container } = renderGlyph(<div>
      <AutomationGlyph id="launch-room" marker={SIDEKICK_RUNNING_MARKER} />
      <AutomationGlyph id="another-room" marker={SIDEKICK_RUNNING_MARKER} />
    </div>);
    const ids = [...container.querySelectorAll('mask')].map((mask) => mask.id);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // And each hexagon references its own rather than whichever came first.
    expect([...container.querySelectorAll('.automation-glyph-shape')].map((shape) => shape.getAttribute('mask')))
      .toEqual(ids.map((id) => `url(#${id})`));
  });

  it('says what the symbol stands for when a pointer rests on it', async () => {
    stubResizeObserver();
    const { container } = renderGlyph(<AutomationGlyph id="launch-room" marker={SIDEKICK_RUNNING_MARKER} />);
    const marker = container.querySelector('.automation-glyph-marker');

    fireEvent.pointerMove(marker!.parentElement!, { pointerType: 'mouse' });

    // A play is the one mark in this window that says something other than what
    // it looks like: it is drawn on every active Sidekick, including the ones
    // sitting idle between triggers, so "running" is exactly the reading the
    // sentence has to correct.
    expect(await screen.findByRole('tooltip'))
      .toHaveTextContent('Active — in service and waiting on its triggers.');
  });

  it('takes the pointer on the whole marker box rather than on the play inside it', () => {
    const { container } = renderGlyph(<AutomationGlyph id="launch-room" marker={SIDEKICK_RUNNING_MARKER} />);
    const marker = container.querySelector('.automation-glyph-marker');
    const target = marker!.parentElement!.querySelector('rect');

    // SVG hit-tests what is painted, and the play is about 7px across at the
    // rail's 36px — a target a pointer crosses rather than rests on. The rect
    // is measured against the marker itself rather than against numbers copied
    // from the component, so moving the marker moves its hover target with it.
    expect(target).toHaveAttribute('x', marker!.getAttribute('x'));
    expect(target).toHaveAttribute('y', marker!.getAttribute('y'));
    expect(target).toHaveAttribute('width', marker!.getAttribute('width'));
    expect(target).toHaveAttribute('height', marker!.getAttribute('height'));
    // Transparent rather than `none`: `visiblePainted` ignores a shape with no
    // fill, so `fill="none"` would leave the box invisible to the pointer too.
    expect(target).toHaveAttribute('fill', 'transparent');
  });

  it('leaves the fill whole where there is no state to mark', () => {
    // The new-Sidekick slot and the library's rows draw the same hexagon with no
    // lifecycle behind it; a mask with nothing cut out of it is a hole waiting
    // to be one.
    const { container } = renderGlyph(<HexagonGlyph fill="none" ink="var(--av-sys-color-text-muted)" symbol={Plus} />);

    expect(container.querySelector('mask')).toBeNull();
    expect(container.querySelector('.automation-glyph-shape')).not.toHaveAttribute('mask');
    expect(container.querySelector('.automation-glyph-marker')).toBeNull();
    // And no hover target either: there is no state here to explain.
    expect(container.querySelector('rect')).toBeNull();
  });
});
