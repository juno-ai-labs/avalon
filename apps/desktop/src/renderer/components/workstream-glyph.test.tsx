import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkstreamGlyph, workstreamAppearance } from './workstream-glyph';

describe('workstreamAppearance', () => {
  it('derives a stable color and icon from the work-stream id', () => {
    expect(workstreamAppearance('00000000-0000-7000-8000-000000000001'))
      .toEqual({ color: 'brown', iconIndex: 4 });
    expect(workstreamAppearance('launch-room'))
      .toEqual({ color: 'teal', iconIndex: 10 });
  });

  it('renders the derived theme token without exposing decoration to assistive technology', () => {
    const { container } = render(<WorkstreamGlyph id="launch-room" size={30} />);
    const glyph = container.querySelector<HTMLElement>('.workstream-glyph');

    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph).toHaveStyle({ height: '30px', width: '30px' });
    expect(container.querySelector('.workstream-glyph-shape')).toHaveStyle({
      background: 'linear-gradient(145deg, color-mix(in srgb, var(--av-sys-color-project-teal) 78%, var(--av-sys-color-surface-default)), var(--av-sys-color-project-teal))',
    });
  });
});
