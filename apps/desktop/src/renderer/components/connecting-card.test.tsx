import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectingCard, ConnectingCardSlot } from './connecting-card';

describe('ConnectingCard', () => {
  it('names what it is connecting to, inside a slot that is the polite status', () => {
    const { rerender } = render(<ConnectingCardSlot />);

    // The region exists before it has anything to say, so the card's arrival
    // is a change inside a live region rather than a region arriving full.
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toBeEmptyDOMElement();

    rerender(<ConnectingCardSlot><ConnectingCard name="Release notes" state="connecting" subject="Canvas" /></ConnectingCardSlot>);
    expect(status).toHaveTextContent('Connecting to Release notes…');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('falls back to the kind of thing when it has no name yet', () => {
    render(<ConnectingCard name={null} state="offline" subject="Sidekick" />);

    expect(document.querySelector('.connecting-card')).toHaveTextContent('Waiting for a connection to this Sidekick…');
  });

  it('says what waits for the connection under the sentence, and keeps saying it when the connection fails', () => {
    const { rerender } = render(
      <ConnectingCard detail="Sending is available once Rally connects" name="Release notes" state="connecting" subject="Canvas" />,
    );

    expect(document.querySelector('.connecting-card')).toHaveTextContent('Connecting to Release notes…');
    expect(screen.getByText('Sending is available once Rally connects')).toBeInTheDocument();

    rerender(
      <ConnectingCard
        detail="Sending is available once Rally connects"
        error="The live connection timed out after 3 attempts."
        name="Release notes"
        state="failed"
        subject="Canvas"
      />,
    );
    // The moment the connection gives up is the moment someone tries to send;
    // the reason Send is disabled stays on screen beside why it failed.
    expect(screen.getByText('The live connection timed out after 3 attempts.')).toBeInTheDocument();
    expect(screen.getByText('Sending is available once Rally connects')).toBeInTheDocument();
  });

  it('shows the failure and offers the one action there is', () => {
    const onRetry = vi.fn();
    render(<ConnectingCard error="The live connection timed out after 3 attempts." name="Hiring" onRetry={onRetry} state="failed" subject="Canvas" />);

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Rally could not connect to Hiring.');
    expect(screen.getByText('The live connection timed out after 3 attempts.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
