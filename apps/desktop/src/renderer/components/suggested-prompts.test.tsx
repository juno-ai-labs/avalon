import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SuggestedPromptList, type SuggestedPromptIcon } from './suggested-prompts';

describe('SuggestedPromptList', () => {
  it('renders the provider-specific icon for every supported prompt icon', () => {
    const expected: Array<[SuggestedPromptIcon, string]> = [
      ['clock', 'tabler-icon-clock'],
      ['brand-github', 'tabler-icon-brand-github'],
      ['brand-google', 'tabler-icon-brand-google'],
      ['brand-google-drive', 'tabler-icon-brand-google-drive'],
      ['brand-notion', 'tabler-icon-brand-notion'],
      ['brand-slack', 'tabler-icon-brand-slack'],
      ['linear', 'tabler-icon-stack-2'],
      ['plug', 'tabler-icon-plug'],
      ['webhook', 'tabler-icon-webhook'],
      ['world-search', 'tabler-icon-world-search'],
    ];
    render(
      <SuggestedPromptList
        items={expected.map(([icon]) => ({ id: icon, text: `Prompt ${icon}`, icon }))}
        onSelect={vi.fn()}
      />,
    );

    for (const [icon, className] of expected) {
      const button = screen.getByRole('button', { name: `Prompt ${icon}` });
      expect(button.querySelector(`.${className}`)).not.toBeNull();
    }
  });
});
