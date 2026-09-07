import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingIntroduction } from './onboarding-introduction';

describe('learning by doing', () => {
  it('explains privacy and multiplayer before completing the introduction', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const complete = vi.fn();
    render(<OnboardingIntroduction busy={false} error={null} onComplete={complete} />);
    expect(screen.getByText('Rally, help us plan a welcome session for our new customers.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Meet streams' }));
    expect(screen.getByRole('heading', { name: 'A stream gives your work a home.' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Explore substreams' }));
    expect(screen.getByRole('heading', { name: 'Explore an idea in a substream.' })).toBeInTheDocument();
    expect(complete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    expect(complete).toHaveBeenCalledOnce();
  });
});
