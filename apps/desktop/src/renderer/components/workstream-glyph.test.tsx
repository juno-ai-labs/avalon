import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PROJECT_COLOR_RING } from '@rally/contracts';
import { WorkstreamGlyph, workstreamAppearance } from './workstream-glyph';

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

  it('renders the derived theme token without exposing decoration to assistive technology', () => {
    const { container } = render(<WorkstreamGlyph id="launch-room" size={30} />);
    const glyph = container.querySelector<HTMLElement>('.workstream-glyph');

    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph).toHaveStyle({ height: '30px', width: '30px' });
    expect(container.querySelector('.workstream-glyph-shape')).toHaveStyle({
      background: 'linear-gradient(145deg, color-mix(in srgb, var(--av-sys-color-project-lime) 78%, var(--av-sys-color-surface-default)), var(--av-sys-color-project-lime))',
    });
  });
});
