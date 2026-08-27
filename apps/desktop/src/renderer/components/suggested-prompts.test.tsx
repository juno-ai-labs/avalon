import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SuggestedPromptList, type SuggestedPromptIcon } from './suggested-prompts';

const icons: SuggestedPromptIcon[] = [
  'clock',
  'brand-github',
  'brand-google',
  'brand-google-drive',
  'brand-notion',
  'brand-slack',
  'linear',
  'plug',
  'webhook',
  'world-search',
];

/**
 * What matters is that a suggestion is attributed to *its* source, so the
 * assertion is that the ten marks are ten different drawings.
 *
 * It used to name the icon package's own class on each one —
 * `tabler-icon-brand-github` and so on — which passed for the wrong reason:
 * it proved which library had been imported, not that the icons differed, and
 * it failed the moment `clock` moved to the semantic registry even though the
 * clock still rendered. A test that breaks when the backing changes but the
 * output does not is testing the backing.
 */
describe('SuggestedPromptList', () => {
  it('renders a distinct mark for every supported prompt icon', () => {
    render(
      <SuggestedPromptList
        items={icons.map((icon) => ({ id: icon, text: `Prompt ${icon}`, icon }))}
        onSelect={vi.fn()}
      />,
    );

    const drawings = icons.map((icon) => {
      const button = screen.getByRole('button', { name: `Prompt ${icon}` });
      const mark = button.querySelector('svg');
      expect(mark, `${icon} rendered no mark`).not.toBeNull();
      return mark?.innerHTML ?? '';
    });

    expect(new Set(drawings).size).toBe(icons.length);
  });
});
