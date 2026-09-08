import { useContext } from 'react';
import { ConversationVisibilityContext } from '../lib/conversation-visibility';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SidekickDetailLayout } from './sidekick-detail-layout';

function VisibilityProbe(): React.JSX.Element {
  return <output data-testid="conversation-visible">{String(useContext(ConversationVisibilityContext))}</output>;
}

describe('SidekickDetailLayout', () => {
  it('keeps the conversation and its unsent input mounted when switching views', () => {
    render(<MemoryRouter><SidekickDetailLayout overview={<h1>Weekly briefing</h1>}><VisibilityProbe /><textarea aria-label="Message" /></SidekickDetailLayout></MemoryRouter>);
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'Keep the briefing short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-pressed', 'true');
    expect(input.closest('main')).toHaveAttribute('data-view', 'details');
    expect(screen.getByRole('heading', { name: 'Weekly briefing' })).toBeInTheDocument();
    expect(screen.getByTestId('conversation-visible')).toHaveTextContent('false');
    fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
    expect(screen.getByTestId('conversation-visible')).toHaveTextContent('true');
    expect(input).toHaveValue('Keep the briefing short');
    expect(input.closest('main')).toHaveAttribute('data-view', 'conversation');
    expect(screen.getByRole('link', { name: 'Sidekicks' })).toHaveAttribute('href', '/sidekicks');
  });
});
