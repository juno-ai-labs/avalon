import { fireEvent, render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvatarStack, RallyMark, DropdownSelect, Modal, OpeningState, SocketStatusIndicator, StatusDot } from './primitives';

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

describe('AvatarStack', () => {
  it('explains when another participant is viewing the work stream', async () => {
    stubResizeObserver();
    const { container } = render(
      <Tooltip.Provider delayDuration={0}>
        <AvatarStack
          currentUserId="user-current"
          members={[
            {
              id: 'user-current',
              name: 'Current User',
              email: 'current@rally.test',
              timezone: 'America/Los_Angeles',
            },
            {
              id: 'user-collaborator',
              name: 'Ari Collaborator',
              email: 'ari@rally.test',
              timezone: 'America/Los_Angeles',
            },
            {
              id: 'user-observer',
              name: 'Casey Observer',
              email: 'casey@rally.test',
              timezone: 'America/Los_Angeles',
            },
          ]}
          presentUserIds={['user-current', 'user-collaborator']}
        />
      </Tooltip.Provider>,
    );

    const currentItem = screen.getByTitle('Current User').closest('.avatar-stack-item');
    const collaboratorItem = container.querySelector('.avatar-stack-item.is-present');
    if (!currentItem || !collaboratorItem) throw new Error('avatar stack item missing');

    fireEvent.pointerMove(currentItem, { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.pointerMove(collaboratorItem, { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Ari Collaborator is viewing this workstream.',
    );
    expect(container.querySelector('.avatar-stack')).toHaveAccessibleName(
      'Current User; Ari Collaborator is viewing this workstream.; Casey Observer',
    );
    const items = [...container.querySelectorAll('.avatar-stack-item')];
    const ping = collaboratorItem.querySelector('.avatar-presence-ping');
    const collaboratorAvatar = collaboratorItem.querySelector('.avatar');
    if (!ping || !collaboratorAvatar || !items[0] || !items[2]) {
      throw new Error('three-avatar presence stack missing');
    }
    expect(items[0].compareDocumentPosition(ping) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(ping.compareDocumentPosition(collaboratorAvatar) & Node.DOCUMENT_POSITION_FOLLOWING)
      .not.toBe(0);
    expect(ping.compareDocumentPosition(items[2]) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(currentItem).not.toHaveAttribute('tabindex');
    expect(collaboratorItem).not.toHaveAttribute('tabindex');
    expect(screen.queryByTitle('Ari Collaborator')).not.toBeInTheDocument();
  });

  it('keeps a final visible participant ping below the overflow badge', () => {
    const members = [
      ['user-current', 'Current User'],
      ['user-ari', 'Ari Collaborator'],
      ['user-casey', 'Casey Observer'],
      ['user-drew', 'Drew Participant'],
      ['user-ellis', 'Ellis Hidden'],
    ].map(([id, name]) => ({
      id: id!,
      name: name!,
      email: `${id}@rally.test`,
      timezone: 'America/Los_Angeles',
    }));
    const { container } = render(
      <Tooltip.Provider delayDuration={0}>
        <AvatarStack
          currentUserId="user-current"
          limit={4}
          members={members}
          presentUserIds={['user-drew']}
        />
      </Tooltip.Provider>,
    );

    const items = [...container.querySelectorAll('.avatar-stack-item')];
    const ping = items[3]?.querySelector('.avatar-presence-ping');
    const overflow = container.querySelector('.avatar-overflow');
    if (!ping || !overflow) throw new Error('final presence ping or overflow badge missing');
    expect(ping.compareDocumentPosition(overflow) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(overflow).toHaveTextContent('+1');
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

describe('Modal', () => {
  it('leaves the dialog standing when Escape is cancelling an IME candidate', () => {
    const onOpenChange = vi.fn();
    render(
      <Tooltip.Provider>
        <Modal onOpenChange={onOpenChange} open title="Add participants?">
          <input aria-label="Note" defaultValue="half composed" />
        </Modal>
      </Tooltip.Provider>,
    );

    const field = screen.getByLabelText('Note');
    // Escape belongs to the IME here: dismissing the dialog would take the
    // typed draft with it, and there is nothing to undo that with.
    fireEvent.keyDown(field, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(field, { key: 'Escape', keyCode: 229 });
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows no tooltip on the close button, whose meaning its position already carries', async () => {
    render(
      <Tooltip.Provider>
        <Modal onOpenChange={vi.fn()} open title="Mark all as read?">
          <p>body</p>
        </Modal>
      </Tooltip.Provider>,
    );

    const close = screen.getByRole('button', { name: 'Close dialog' });
    // Radix opens a tooltip on hover and on keyboard focus alike; a hover-only
    // assertion would keep passing if a later refactor restored just the focus path.
    fireEvent.pointerMove(close, { pointerType: 'mouse' });
    fireEvent.focus(close);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
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
