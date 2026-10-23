import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KONAMI_CODE } from '../../lib/easter-eggs';
import { KonamiEgg } from './konami';

describe('KonamiEgg', () => {
  it('flags the page so every avatar runs its lap once the code is typed', () => {
    const { unmount } = render(<KonamiEgg />);
    expect(document.documentElement).not.toHaveAttribute('data-konami');
    for (const key of KONAMI_CODE) fireEvent.keyDown(document.body, { key });
    expect(document.documentElement).toHaveAttribute('data-konami');
    unmount();
    expect(document.documentElement).not.toHaveAttribute('data-konami');
  });
});
