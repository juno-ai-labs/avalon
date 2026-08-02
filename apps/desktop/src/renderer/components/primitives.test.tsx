import { render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it } from 'vitest';
import { AvalonMark, StatusDot } from './primitives';

describe('AvalonMark', () => {
  it('renders the shared mask-backed brand mark without the retired starburst SVG', () => {
    const { container } = render(<AvalonMark className="test-mark" />);
    expect(container.querySelector('.avalon-mark.test-mark')).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('StatusDot', () => {
  it('exposes status text even in compact color-dot mode', () => {
    render(
      <Tooltip.Provider>
        <StatusDot compact status="needs_input" />
      </Tooltip.Provider>,
    );

    expect(screen.getByText('Needs input')).toBeInTheDocument();
    expect(screen.getByText('Needs input').parentElement).toHaveClass('status-needs_input');
  });

  it('labels the running state while retaining the pulse class', () => {
    render(
      <Tooltip.Provider>
        <StatusDot status="running" />
      </Tooltip.Provider>,
    );

    expect(screen.getByText('Running')).toBeVisible();
    expect(screen.getByText('Running').parentElement).toHaveClass('status-running');
  });
});
