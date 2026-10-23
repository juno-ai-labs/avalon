import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KONAMI_CODE } from '../../lib/easter-eggs';
import { KonamiEgg } from './konami';

describe('KonamiEgg', () => {
  it('shows thirty lives once the code is typed', () => {
    render(<KonamiEgg />);
    expect(screen.queryByText('+30 lives')).not.toBeInTheDocument();
    for (const key of KONAMI_CODE) fireEvent.keyDown(document.body, { key });
    expect(screen.getByText('+30 lives')).toBeInTheDocument();
  });

  it('flags the page so every avatar runs its lap, and clears the flag after', () => {
    const { unmount } = render(<KonamiEgg />);
    expect(document.documentElement).not.toHaveAttribute('data-konami');
    for (const key of KONAMI_CODE) fireEvent.keyDown(document.body, { key });
    expect(document.documentElement).toHaveAttribute('data-konami');
    unmount();
    expect(document.documentElement).not.toHaveAttribute('data-konami');
  });
});
