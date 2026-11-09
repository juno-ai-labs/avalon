import { useContext } from 'react';
import { ConversationVisibilityContext } from '../lib/conversation-visibility';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SidekickDetailLayout } from './sidekick-detail-layout';

function VisibilityProbe(): React.JSX.Element {
  return <output data-testid="conversation-visible">{String(useContext(ConversationVisibilityContext))}</output>;
}

describe('SidekickDetailLayout', () => {
  // jsdom measures the host at zero wide, so the layout is compact: the
  // details share the main column, switched from the header.
  it('switches to the details under the same header, keeping the conversation and its unsent input mounted', () => {
    render(<SidekickDetailLayout
      details={<h1>Weekly briefing</h1>}
      header={({ compact, detailsOpen, toggleDetails }) => <header>
        <span>Weekly briefing pill</span>
        {compact && <button aria-pressed={detailsOpen} onClick={toggleDetails} type="button">Sidekick details</button>}
      </header>}
    ><VisibilityProbe /><textarea aria-label="Message" /></SidekickDetailLayout>);
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'Keep the briefing short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sidekick details' }));
    expect(screen.getByRole('button', { name: 'Sidekick details' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Weekly briefing pill')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Weekly briefing' })).toBeInTheDocument();
    expect(screen.getByTestId('conversation-visible')).toHaveTextContent('false');
    fireEvent.click(screen.getByRole('button', { name: 'Sidekick details' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
    expect(screen.getByTestId('conversation-visible')).toHaveTextContent('true');
    expect(input).toHaveValue('Keep the briefing short');
  });
});
