import { fireEvent, render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RallyMark, DropdownSelect, OpeningState, SocketStatusIndicator, StatusDot } from './primitives';

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ size, state }: { size: number; state: string }) => (
    <span data-size={size} data-state={state} data-testid="thinking-orb" />
  ),
}));

afterEach(() => vi.unstubAllGlobals());

/** Radix positions a tooltip with a ResizeObserver, which jsdom does not implement. */
function stubResizeObserver(): void {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
}

describe('RallyMark', () => {
  it('renders the shared mask-backed brand mark without the retired starburst SVG', () => {
    const { container } = render(<RallyMark className="test-mark" />);
    expect(container.querySelector('.rally-mark.test-mark')).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });
});

/** The indicator wrapping a compact dot's screen-reader label — the tooltip trigger. */
function statusIndicator(label: string): Element {
  const indicator = screen.getByText(label).closest('.status-indicator');
  if (!indicator) throw new Error(`no status indicator around "${label}"`);
  return indicator;
}

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

  it('explains what the color means on hover when asked for a tooltip', async () => {
    stubResizeObserver();
    render(
      <Tooltip.Provider>
        <StatusDot compact status="failed" tooltip />
      </Tooltip.Provider>,
    );

    fireEvent.pointerMove(statusIndicator('Needs intervention'), { pointerType: 'mouse' });

    expect(await screen.findByText('Needs intervention — the last run failed and stopped.')).toBeVisible();
  });

  it('leaves the dot untouched when no tooltip is asked for', () => {
    render(
      <Tooltip.Provider>
        <StatusDot compact status="failed" />
      </Tooltip.Provider>,
    );

    fireEvent.pointerMove(statusIndicator('Needs intervention'), { pointerType: 'mouse' });

    expect(screen.queryByText(/the last run failed and stopped/u)).not.toBeInTheDocument();
  });
});

describe('SocketStatusIndicator', () => {
  it('explains the current live-update state from the compact header indicator', async () => {
    stubResizeObserver();
    const { rerender } = render(
      <Tooltip.Provider delayDuration={0}>
        <SocketStatusIndicator state="reconnecting" />
      </Tooltip.Provider>,
    );

    const indicator = screen.getByRole('status', { name: 'Reconnecting live updates' });
    expect(indicator).toHaveClass('header-socket-state', 'socket-reconnecting');
    expect(indicator).toHaveTextContent('Reconnecting live updates');
    fireEvent.focus(indicator);
    expect(await screen.findByText('The connection was interrupted. Rally is reconnecting live updates.')).toBeVisible();

    rerender(
      <Tooltip.Provider delayDuration={0}>
        <SocketStatusIndicator state="unavailable" />
      </Tooltip.Provider>,
    );
    expect(screen.getByRole('status', { name: 'Live updates unavailable' }))
      .toHaveTextContent('Live updates unavailable');
  });
});

describe('OpeningState', () => {
  it('centralizes the large connecting orb used while screens open', () => {
    render(<OpeningState label="Opening automation…" />);

    expect(screen.getByRole('status')).toHaveTextContent('Opening automation…');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-state', 'connecting');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-size', '64');
  });
});

describe('DropdownSelect', () => {
  it('renders the secondary settings treatment with an accessible trigger', () => {
    render(
      <DropdownSelect
        ariaLabel="Personal default timezone"
        onValueChange={vi.fn()}
        options={[{ label: 'Pacific time', value: 'America/Los_Angeles' }]}
        value="America/Los_Angeles"
        variant="secondary"
      />,
    );

    const trigger = screen.getByRole('combobox', { name: 'Personal default timezone' });
    expect(trigger).toHaveClass('dropdown-select-trigger-secondary');
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'Pacific time' })).toBeVisible();
  });
});
