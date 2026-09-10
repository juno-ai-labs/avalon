import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectingCard } from './connecting-card';

describe('ConnectingCard', () => {
  it('names what it is connecting to, as a polite status', () => {
    render(<ConnectingCard name="Release notes" state="connecting" subject="work stream" />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Connecting to Release notes…');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('falls back to the kind of thing when it has no name yet', () => {
    render(<ConnectingCard name={null} state="offline" subject="substream" />);

    expect(screen.getByRole('status')).toHaveTextContent('Waiting for a connection to this substream…');
  });

  it('shows the failure and offers the one action there is', () => {
    const onRetry = vi.fn();
    render(<ConnectingCard error="The live connection timed out after 3 attempts." name="Hiring" onRetry={onRetry} state="failed" subject="project" />);

    expect(screen.getByRole('status')).toHaveTextContent('Rally could not connect to Hiring.');
    expect(screen.getByText('The live connection timed out after 3 attempts.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
