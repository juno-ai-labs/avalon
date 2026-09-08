import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SidekickDetailLayout } from './sidekick-detail-layout';

describe('SidekickDetailLayout', () => {
  it('keeps the conversation and its unsent input mounted when switching views', () => {
    render(<MemoryRouter><SidekickDetailLayout overview={<h1>Weekly briefing</h1>}><textarea aria-label="Message" /></SidekickDetailLayout></MemoryRouter>);
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'Keep the briefing short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-pressed', 'true');
    expect(input.closest('main')).toHaveAttribute('data-view', 'details');
    fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
    expect(input).toHaveValue('Keep the briefing short');
    expect(input.closest('main')).toHaveAttribute('data-view', 'conversation');
    expect(screen.getByRole('link', { name: 'Sidekicks' })).toHaveAttribute('href', '/sidekicks');
  });
});
