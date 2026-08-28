import { act, fireEvent, render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEAM_RESTING_PATH, SEAM_SPIN_DURATION_MS, SEAM_SPIN_RATE, SEAM_START_RADIANS, seamPath } from '../lib/rally-seam';
import { AvatarStack, RallyMark, RallySeam, DropdownSelect, Modal, OpeningState, SocketStatusIndicator, StatusDot } from './primitives';

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

/**
 * A `matchMedia` that answers one question, so a test can say what the reader's
 * motion preference is. Absent entirely, the component has to carry on turning.
 */
function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

/**
 * A `matchMedia` whose reduced-motion answer can change after the component
 * has mounted, with the `change` listener `onReducedMotionChange` registers
 * captured so a test can fire it directly — standing in for the OS actually
 * toggling the preference, which jsdom cannot do for us.
 *
 * `prefersReducedMotion` calls `window.matchMedia` fresh each time rather than
 * holding onto one `MediaQueryList`, so `matches` has to be a getter reading a
 * shared `reduced` variable rather than a value captured once per call.
 */
function stubMutableReducedMotion(initial: boolean): { setReduced: (value: boolean) => void; fireChange: () => void } {
  let reduced = initial;
  const listeners: Array<() => void> = [];
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return reduced && query.includes('prefers-reduced-motion');
    },
    addEventListener: (event: string, listener: () => void) => {
      if (event === 'change' && query.includes('prefers-reduced-motion')) listeners.push(listener);
    },
    removeEventListener: () => {},
  }));
  return {
    setReduced: (value: boolean) => { reduced = value; },
    fireChange: () => listeners.forEach((listener) => listener()),
  };
}

/**
 * The frames the component asked for, so a test can play them itself — and the
 * handles it cancelled, which is the only evidence the cleanup ran.
 *
 * `requestAnimationFrame` returns `push`'s new length, so handles are 1, 2, 3…
 * A stub returning nothing would make every handle `undefined` and the
 * cancellation assertion below true whether or not the cleanup ran.
 */
function captureFrames(): { frames: FrameRequestCallback[]; cancelled: number[] } {
  const frames: FrameRequestCallback[] = [];
  const cancelled: number[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => cancelled.push(handle));
  return { frames, cancelled };
}

function seamAttribute(container: HTMLElement): string {
  const path = container.querySelector('.rally-seam path');
  if (!path) throw new Error('the seam drew no path');
  return path.getAttribute('d') ?? '';
}

describe('RallySeam', () => {
  it('turns on both axes, so the crossings pass rather than the drawing rotating', () => {
    stubReducedMotion(false);
    const { frames } = captureFrames();
    const { container } = render(<RallySeam className="test-seam" />);

    act(() => frames.shift()?.(0));
    const first = seamAttribute(container);
    act(() => frames.shift()?.(1_200));
    const later = seamAttribute(container);

    expect(first).not.toEqual(later);
    // A single-axis turn at the same instant is a different drawing. Asserting
    // only that the frame changed would pass with the tilt removed, which is
    // the half of the motion that cannot be had from a CSS rotation either.
    expect(later).not.toEqual(seamPath(SEAM_START_RADIANS + 1_200 * SEAM_SPIN_RATE));
  });

  it('plays the turn once and then settles on the still master\'s own frame', () => {
    stubReducedMotion(false);
    const { frames } = captureFrames();
    const { container } = render(<RallySeam />);

    act(() => frames.shift()?.(0));
    act(() => frames.shift()?.(SEAM_SPIN_DURATION_MS));

    // Nothing left in the queue: the loop stops scheduling itself once it has
    // held, rather than continuing to turn for as long as the mark is mounted.
    expect(frames).toHaveLength(0);
    // The held frame is not just *a* stopping point — it is the exact angle
    // the still master is drawn at, the same one reduced motion below holds.
    expect(seamAttribute(container)).toEqual(SEAM_RESTING_PATH);
  });

  /**
   * The turn is one-shot *per mount*, not one-shot *per preference state*: a
   * `change` event firing after the turn already settled must not schedule it
   * again, or "spin once" would only hold as long as nobody touched the OS
   * setting.
   */
  it('does not replay the turn when the preference toggles off, on, and off again after it has settled', () => {
    const { setReduced, fireChange } = stubMutableReducedMotion(false);
    const { frames, cancelled } = captureFrames();
    const { container } = render(<RallySeam />);

    act(() => frames.shift()?.(0));
    const pending = frames.length;
    act(() => frames.shift()?.(SEAM_SPIN_DURATION_MS));

    // The turn has already settled: nothing left queued, and the last
    // in-progress frame was actually cancelled rather than merely abandoned —
    // the same evidence the unmount test below relies on.
    expect(frames).toHaveLength(0);
    expect(cancelled).toContain(pending);
    expect(seamAttribute(container)).toEqual(SEAM_RESTING_PATH);

    act(() => {
      setReduced(true);
      fireChange();
      setReduced(false);
      fireChange();
    });

    // If the turn had replayed, a fresh frame would now be queued to draw the
    // next angle of a new rotation instead of holding still.
    expect(frames).toHaveLength(0);
    expect(seamAttribute(container)).toEqual(SEAM_RESTING_PATH);
  });

  it('holds the resting frame for a reader who asked for less motion', () => {
    stubReducedMotion(true);
    const { frames } = captureFrames();
    const { container } = render(<RallySeam />);

    expect(frames).toHaveLength(0);
    expect(seamAttribute(container)).toEqual(SEAM_RESTING_PATH);
  });

  // jsdom defines no `matchMedia`, and neither does an Electron window in some
  // startup states. Unreadable is not the same as "asked for less motion".
  it('still turns where the preference cannot be read', () => {
    const { frames } = captureFrames();
    render(<RallySeam />);

    expect(frames.length).toBeGreaterThan(0);
  });

  /**
   * The home screen mounts and unmounts on every navigation, so a loop that
   * outlived its component would keep re-solving 169 points a frame against a
   * detached node for the rest of the session. Nothing else here can see that:
   * the other cases never unmount, and a cancel that does nothing looks
   * identical to a cancel that was never called.
   */
  it('stops its loop when the mark leaves the screen', () => {
    stubReducedMotion(false);
    const { frames, cancelled } = captureFrames();
    const { unmount } = render(<RallySeam />);

    act(() => frames.shift()?.(0));
    const pending = frames.length;
    expect(pending).toBeGreaterThan(0);

    unmount();

    // The pending handle specifically, not merely that something was cancelled:
    // the first `sync` cancels handle 0 before it schedules anything, so
    // asserting on a non-empty list would pass with no cleanup at all.
    expect(cancelled).toContain(pending);
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
  it('keeps an avatar mounted while its presence ring fades in and out', () => {
    const members = [{
      id: 'user-collaborator',
      name: 'Ari Collaborator',
      email: 'ari@rally.test',
      timezone: 'America/Los_Angeles',
    }];
    const view = (presentUserIds: readonly string[] = []) => (
      <Tooltip.Provider>
        <AvatarStack members={members} presentUserIds={presentUserIds} />
      </Tooltip.Provider>
    );
    const { container, rerender } = render(view());
    const avatar = container.querySelector('.avatar');
    if (!avatar) throw new Error('avatar missing before presence change');

    rerender(view(['user-collaborator']));
    expect(container.querySelector('.avatar')).toBe(avatar);
    expect(avatar.closest('.avatar-stack-item')).toHaveClass('is-present');
    expect(container.querySelector('.avatar-presence-ping')).not.toBeNull();

    rerender(view());
    expect(container.querySelector('.avatar')).toBe(avatar);
    expect(avatar.closest('.avatar-stack-item')).not.toHaveClass('is-present');
    expect(container.querySelector('.avatar-presence-ping')).toBeNull();
  });

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
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(currentItem).not.toHaveAttribute('aria-describedby');
    fireEvent.focus(currentItem);
    expect(currentItem).not.toHaveAttribute('aria-describedby');

    fireEvent.pointerMove(collaboratorItem, { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
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
