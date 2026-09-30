import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingIntroduction } from './onboarding-introduction';

beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
describe('learning by doing', () => {
  it('explains privacy and multiplayer before completing the introduction', () => {

    const complete = vi.fn();
    render(<OnboardingIntroduction busy={false} error={null} onComplete={complete} />);
    expect(screen.getByText('Saved. Everyone has the latest version.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Meet channels' }));
    expect(screen.getByRole('heading', { name: 'A stream gives your work a home.' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Explore breakouts' }));
    expect(screen.getByRole('heading', { name: 'Explore an idea in a breakout.' })).toBeInTheDocument();
    expect(complete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    expect(complete).toHaveBeenCalledOnce();
  });
});
