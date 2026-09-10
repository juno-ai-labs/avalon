import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PROJECT_COLOR_RING, type WorkstreamAppearance } from '@rally/contracts';
import { Plus } from 'lucide-react';
import { AutomationGlyph, HexagonGlyph, resolveWorkstreamAppearance, WorkstreamGlyph, WorkstreamMark, workstreamAppearance, type ResolvableAppearance } from './workstream-glyph';

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
