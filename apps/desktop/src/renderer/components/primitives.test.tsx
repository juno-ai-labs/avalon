import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_PREFERENCES_STORAGE_KEY } from '../lib/device-preferences';
import { MemberPresentationContext } from '../lib/member-presentation';
import { installWindowActivationTracking } from '../lib/window-activation';
import { AvatarStack, Button, ConnectorMark, DragHint, RallyMark, DropdownSelect, Meter, Modal, OpeningState, SegmentedControl, SocketStatusIndicator, StatusDot, Tip, TipGroup } from './primitives';

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ size, state, theme }: { size: number; state: string; theme?: string }) => (
    <span data-size={size} data-state={state} data-testid="thinking-orb" data-theme={theme} />
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/** Radix positions a tooltip with a ResizeObserver, which jsdom does not implement. */
function stubResizeObserver(): void {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
}

describe('Button', () => {
  it('keeps an explained disabled action focusable, explains it, and blocks clicks', async () => {
    const onClick = vi.fn();
    render(<Tooltip.Provider><Button disabled disabledReason="Choose an organization first." onClick={onClick}>Continue</Button></Tooltip.Provider>);
    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => button.focus());
    expect(button).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Choose an organization first.');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('preserves native disabling and enables the callback once available', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button disabled onClick={onClick}>Continue</Button>);
    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    rerender(<Button onClick={onClick}>Continue</Button>);
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('RallyMark', () => {
  it('renders the shared mask-backed brand mark without the retired starburst SVG', () => {
    const { container } = render(<RallyMark className="test-mark" />);
    expect(container.querySelector('.rally-mark.test-mark')).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('Meter', () => {
  it('is a named meter carrying its value', () => {
    render(<Meter label="Weekly quota left" value={72} />);

    const meter = screen.getByRole('meter', { name: 'Weekly quota left' });
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(meter).toHaveAttribute('aria-valuenow', '72');
    expect(meter.querySelector('.meter-fill')).toHaveStyle({ width: '72%' });
  });

  it('fills against its own maximum and can announce task progress', () => {
    render(<Meter label="2 of 4 onboarding steps complete" max={4} role="progressbar" value={2} />);

    const meter = screen.getByRole('progressbar', { name: '2 of 4 onboarding steps complete' });
    expect(meter).toHaveAttribute('aria-valuemax', '4');
    expect(meter.querySelector('.meter-fill')).toHaveStyle({ width: '50%' });
  });

  it('never draws or reports past either end', () => {
    render(<><Meter label="Over" value={140} /><Meter label="Under" value={-5} /></>);

    expect(screen.getByRole('meter', { name: 'Over' })).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByRole('meter', { name: 'Over' }).querySelector('.meter-fill')).toHaveStyle({ width: '100%' });
    expect(screen.getByRole('meter', { name: 'Under' })).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByRole('meter', { name: 'Under' }).querySelector('.meter-fill')).toHaveStyle({ width: '0%' });
  });

  it('takes the warning colour only when asked', () => {
    render(<><Meter label="Low" tone="warning" value={12} /><Meter label="Fine" value={12} /></>);

    expect(screen.getByRole('meter', { name: 'Low' })).toHaveClass('meter-warning');
    expect(screen.getByRole('meter', { name: 'Fine' })).not.toHaveClass('meter-warning');
  });

  it('draws an empty track with no meter role while its value has not arrived', () => {
    const { container } = render(<Meter label="Weekly quota left" value={null} />);

    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(container.querySelector('.meter')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.meter-fill')).toBeNull();
  });
});

describe('ConnectorMark', () => {
  it('draws Ashby and Fireflies as their own marks, not Lucide stand-ins', () => {
    // `@thesvg/react` has neither slug. A Lucide briefcase or audio-lines
    // glyph would carry `.lucide` and would not title itself with the company.
    // Reverting those two rows to Lucide is the production break this pins.
    const ashby = render(<ConnectorMark mark="ashby" />);
    const fireflies = render(<ConnectorMark mark="fireflies" />);
    expect(ashby.container.querySelector('.lucide')).toBeNull();
    expect(fireflies.container.querySelector('.lucide')).toBeNull();
    expect(ashby.container.querySelector('svg title')?.textContent).toBe('Ashby');
    expect(fireflies.container.querySelector('svg title')?.textContent).toBe('Fireflies');
    // The product icon is a serif A punched from a rounded square
    // (ashbyhq.com/favicon.png), not the stacked marketing lockup.
    expect(ashby.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 192 192');
    expect(ashby.container.querySelector('path')?.getAttribute('fill-rule')).toBe('evenodd');
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

function Segmented({ onChange = () => {} }: { onChange?: (value: string) => void }): React.JSX.Element {
  return (
    <SegmentedControl
      ariaLabel="Outbound access"
      onChange={onChange}
      options={[
        { value: 'trusted', label: 'Trusted only' },
        { value: 'full', label: 'Full internet' },
        { value: 'none', label: 'Blocked' },
      ]}
      value="full"
    />
  );
}

describe('SegmentedControl', () => {
  it('offers one tab stop and moves the choice with the arrows', () => {
    const onChange = vi.fn();
    render(<Segmented onChange={onChange} />);

    const options = screen.getAllByRole('radio');
    expect(options.map((option) => option.tabIndex)).toEqual([-1, 0, -1]);
    expect(screen.getByRole('radio', { name: 'Full internet' })).toBeChecked();

    fireEvent.keyDown(options[1]!, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('none');
    expect(document.activeElement).toBe(options[2]);
  });

  it('wraps past the last segment and jumps to an end', () => {
    const onChange = vi.fn();
    render(<Segmented onChange={onChange} />);
    const options = screen.getAllByRole('radio');

    fireEvent.keyDown(options[1]!, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('trusted');
    fireEvent.keyDown(options[1]!, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('trusted');
    fireEvent.keyDown(options[1]!, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('none');
    // From the first segment ArrowLeft wraps to the last rather than falling
    // off the strip. Cleared first: a strip that stops at the edge silently
    // leaves the previous call standing as the last one.
    onChange.mockClear();
    fireEvent.keyDown(options[0]!, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('none');
    expect(document.activeElement).toBe(options[2]);
  });

  it('leaves a modified arrow to the platform', () => {
    const onChange = vi.fn();
    render(<Segmented onChange={onChange} />);
    const options = screen.getAllByRole('radio');
    options[1]!.focus();

    // VoiceOver navigates with Ctrl-Option-Arrow, and the window manager and
    // the OS claim the other three. Acting on those would change the setting
    // under someone who was trying to move past it — and `preventDefault` would
    // stop the move they asked for from happening at all.
    for (const modifier of [{ ctrlKey: true, altKey: true }, { metaKey: true }, { shiftKey: true }]) {
      for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
        // `fireEvent` returns false when the handler cancelled the event.
        expect(fireEvent.keyDown(options[1]!, { key, ...modifier }), `${key} ${JSON.stringify(modifier)}`).toBe(true);
      }
    }

    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(options[1]);
  });

  it('leaves keys it does not own to the surrounding form', () => {
    const onChange = vi.fn();
    render(<Segmented onChange={onChange} />);

    fireEvent.keyDown(screen.getAllByRole('radio')[1]!, { key: 'Enter' });
    fireEvent.keyDown(screen.getAllByRole('radio')[1]!, { key: 'a' });

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('TipGroup', () => {
  /**
   * Two controls in one group, the way an action row holds them.
   *
   * The second assertion is deliberately synchronous: the point of the group is
   * that a pointer travelling the row pays the open delay once, so the second
   * tip has to be open on this tick rather than 450ms from now. Nothing here
   * waits on wall-clock — the skip window Radix keeps after a tip closes is
   * 300ms, and these two events are microseconds apart.
   */
  it('opens the rest of a row without paying the delay again', async () => {
    stubResizeObserver();
    render(
      <TipGroup>
        <Tip label="Copy response"><button type="button">Copy</button></Tip>
        <Tip label="Speak response"><button type="button">Speak</button></Tip>
      </TipGroup>,
    );
    const copy = screen.getByRole('button', { name: 'Copy' });
    const speak = screen.getByRole('button', { name: 'Speak' });

    fireEvent.pointerMove(copy, { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Copy response');

    fireEvent.pointerLeave(copy, { pointerType: 'mouse' });
    fireEvent.pointerMove(speak, { pointerType: 'mouse' });

    expect(screen.getByRole('tooltip')).toHaveTextContent('Speak response');
  });

  it('keeps a tip from outliving the control it points at', async () => {
    stubResizeObserver();
    render(
      <TipGroup>
        <Tip label="Copy response"><button type="button">Copy</button></Tip>
      </TipGroup>,
    );
    const copy = screen.getByRole('button', { name: 'Copy' });

    fireEvent.pointerMove(copy, { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toBeVisible();

    // Radix would keep this open while the pointer is over the box itself. The
    // rows these sit on are painted on hover, so the box would outlive the row.
    fireEvent.pointerLeave(copy, { pointerType: 'mouse' });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

/**
 * A tip answers a question the person asked by pointing or tabbing at a
 * control. An application switch asks nothing and produces both gestures
 * anyway — the control that had focus is focused again, and the window arrives
 * under a cursor that never moved — so the answer has to be withheld from the
 * switch without being withheld from anyone else. The guard it asks is
 * `lib/window-activation.ts`.
 */
describe('Tip across an application switch', () => {
  let stopTracking: (() => void) | null = null;

  beforeEach(() => {
    stopTracking = installWindowActivationTracking();
  });

  afterEach(() => {
    stopTracking?.();
    stopTracking = null;
  });

  /** Away and back, with nothing else touched: a Command-Tab in both directions. */
  function switchAwayAndBack(): void {
    fireEvent.blur(window);
    fireEvent.focus(window);
  }

  function renderTip(): HTMLElement {
    render(
      <Tooltip.Provider delayDuration={0}>
        <Tip delayDuration={0} label="Copy response"><button type="button">Copy</button></Tip>
      </Tooltip.Provider>,
    );
    return screen.getByRole('button', { name: 'Copy' });
  }

  /**
   * A hover opens on a timer that a zero delay shortens rather than removes, so
   * a tip that is absent on this tick is only a tip that has not arrived yet.
   * Letting the timer turn is what makes the absence mean something. Focus does
   * not go through it — Radix opens on the event — so only the pointer needs it.
   */
  async function expectNoTipOnceTheDelayHasPassed(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  }

  it('stays shut when the window hands a control its focus back', () => {
    const copy = renderTip();

    switchAwayAndBack();
    fireEvent.focus(copy);

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('stays shut under a cursor the window arrived beneath, and opens when it moves', async () => {
    const copy = renderTip();

    switchAwayAndBack();
    fireEvent.pointerOver(copy, { pointerType: 'mouse', clientX: 200, clientY: 120 });
    fireEvent.pointerMove(copy, { pointerType: 'mouse', clientX: 200, clientY: 120 });

    await expectNoTipOnceTheDelayHasPassed();

    fireEvent.pointerMove(copy, { pointerType: 'mouse', clientX: 204, clientY: 122 });

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Copy response');
  });

  it('opens on a focus that follows a keystroke rather than a switch', async () => {
    const copy = renderTip();

    switchAwayAndBack();
    fireEvent.keyDown(window, { key: 'Tab' });
    fireEvent.focus(copy);

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Copy response');
  });

  it('stays shut on a focus code moves after a pointer press, and opens after a key', async () => {
    const copy = renderTip();

    // A tap elsewhere, then focus moved here by code: a menu level focusing its
    // first control. Nobody tabbed to it, so it answers nothing.
    fireEvent.pointerDown(window, { pointerType: 'touch' });
    fireEvent.focus(copy);

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.blur(copy);
    fireEvent.keyDown(window, { key: 'Tab' });
    fireEvent.focus(copy);

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Copy response');
  });

  it('takes a caller-controlled hint down with the window as well', async () => {
    // `DragHint` renders `open` itself, so dropping the tip's own state cannot
    // close it — and a resize handle's hint is the one most likely to still be
    // up at a switch, because the pointer that opened it is resting on a 12px
    // divider it has no reason to leave.
    render(
      <Tooltip.Provider delayDuration={0}>
        <DragHint action="Drag to resize" shortcut="Double-click to reset">
          <button type="button">Divider</button>
        </DragHint>
      </Tooltip.Provider>,
    );
    const divider = screen.getByRole('button', { name: 'Divider' });

    fireEvent.pointerMove(divider, { pointerType: 'mouse', clientX: 300, clientY: 200 });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Drag to resize');

    fireEvent.blur(window);

    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('goes down with the window instead of waiting over the screen behind it', async () => {
    const copy = renderTip();

    fireEvent.pointerMove(copy, { pointerType: 'mouse', clientX: 200, clientY: 120 });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Copy response');

    // Nothing else would: the pointer is still over the trigger, and Radix
    // closes on the pointer leaving it.
    fireEvent.blur(window);

    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
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

  it('pings in each present member\'s chosen colour', () => {
    const members = [
      { id: 'user-violet', name: 'Vi Olet', email: 'vi@rally.test', timezone: 'UTC' },
      { id: 'user-plain', name: 'Pat Plain', email: 'pat@rally.test', timezone: 'UTC' },
    ];
    const profile = { displayName: 'Vi Olet', initials: 'VO', color: 'violet' as const, avatar: 'circle' as const, revision: 1 };
    const { container } = render(
      <MemberPresentationContext.Provider value={new Map([['user-violet', profile]])}>
        <Tooltip.Provider>
          <AvatarStack members={members} presentUserIds={['user-violet', 'user-plain']} />
        </Tooltip.Provider>
      </MemberPresentationContext.Provider>,
    );
    const [violet, plain] = [...container.querySelectorAll<HTMLElement>('.avatar-presence-ping')];
    expect(violet?.style.getPropertyValue('--person-accent')).toBe('var(--av-sys-color-project-violet)');
    expect(plain?.style.getPropertyValue('--person-accent')).toBe('var(--av-sys-color-success-base)');
  });

  it('explains when another participant is viewing the channel', async () => {
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

    const items = [...container.querySelectorAll('.avatar-stack-item')];
    const currentItem = items[0];
    const collaboratorItem = items[1];
    if (!currentItem || !collaboratorItem || !items[2]) {
      throw new Error('avatar stack item missing');
    }

    fireEvent.pointerMove(collaboratorItem, { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Ari Collaborator is viewing this thread.',
    );
    expect(container.querySelector('.avatar-stack')).toHaveAccessibleName(
      'Current User; Ari Collaborator is viewing this thread.; Casey Observer',
    );
    const ping = collaboratorItem.querySelector('.avatar-presence-ping');
    const collaboratorAvatar = collaboratorItem.querySelector('.avatar');
    if (!ping || !collaboratorAvatar) {
      throw new Error('three-avatar presence stack missing');
    }
    expect(currentItem.compareDocumentPosition(ping) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(ping.compareDocumentPosition(collaboratorAvatar) & Node.DOCUMENT_POSITION_FOLLOWING)
      .not.toBe(0);
    expect(ping.compareDocumentPosition(items[2]) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(currentItem).not.toHaveClass('is-present');
    expect(currentItem).not.toHaveAttribute('tabindex');
    expect(collaboratorItem).not.toHaveAttribute('tabindex');
    expect(screen.queryByTitle('Current User')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Ari Collaborator')).not.toBeInTheDocument();
  });

  it('names a person who is not viewing the channel', async () => {
    stubResizeObserver();
    const { container } = render(
      <Tooltip.Provider delayDuration={0}>
        <AvatarStack
          members={[{
            id: 'user-observer',
            name: 'Casey Observer',
            email: 'casey@rally.test',
            timezone: 'America/Los_Angeles',
          }]}
        />
      </Tooltip.Provider>,
    );

    const item = container.querySelector('.avatar-stack-item');
    if (!item) throw new Error('avatar stack item missing');
    fireEvent.pointerMove(item, { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Casey Observer');
    expect(screen.queryByTitle('Casey Observer')).not.toBeInTheDocument();
  });

  it('skips the per-face name tooltip when the caller already explains the stack', async () => {
    stubResizeObserver();
    const { container } = render(
      <Tooltip.Provider delayDuration={0}>
        <AvatarStack
          members={[{
            id: 'user-observer',
            name: 'Casey Observer',
            email: 'casey@rally.test',
            timezone: 'America/Los_Angeles',
          }]}
          nameTooltip={false}
        />
      </Tooltip.Provider>,
    );

    const item = container.querySelector('.avatar-stack-item');
    if (!item) throw new Error('avatar stack item missing');
    expect(item).not.toHaveAttribute('data-state');
    fireEvent.pointerMove(item, { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(container.querySelector('.avatar-stack')).toHaveAccessibleName('Casey Observer');
  });

  it('still explains presence when name tooltips are off', async () => {
    stubResizeObserver();
    const { container } = render(
      <Tooltip.Provider delayDuration={0}>
        <AvatarStack
          currentUserId="user-current"
          members={[{
            id: 'user-collaborator',
            name: 'Ari Collaborator',
            email: 'ari@rally.test',
            timezone: 'America/Los_Angeles',
          }]}
          nameTooltip={false}
          presentUserIds={['user-collaborator']}
        />
      </Tooltip.Provider>,
    );

    const item = container.querySelector('.avatar-stack-item');
    if (!item) throw new Error('avatar stack item missing');
    fireEvent.pointerMove(item, { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Ari Collaborator is viewing this thread.',
    );
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

  it('uses a caller-supplied overflow when the stack was already truncated', () => {
    const members = [
      ['user-ari', 'Ari Collaborator'],
      ['user-casey', 'Casey Observer'],
      ['user-drew', 'Drew Participant'],
    ].map(([id, name]) => ({
      id: id!,
      name: name!,
      email: `${id}@rally.test`,
      timezone: 'America/Los_Angeles',
    }));
    const { container } = render(
      <Tooltip.Provider>
        <AvatarStack extraCount={2} limit={3} members={members} />
      </Tooltip.Provider>,
    );

    expect(container.querySelectorAll('.avatar-small')).toHaveLength(3);
    expect(container.querySelector('.avatar-overflow')).toHaveTextContent('+2');
    expect(container.querySelector('.avatar-stack')).toHaveAccessibleName(
      'Ari Collaborator; Casey Observer; Drew Participant; and 2 more',
    );
  });

  it('does not invent an overflow when extraCount is zero', () => {
    const members = [
      ['user-ari', 'Ari Collaborator'],
      ['user-casey', 'Casey Observer'],
      ['user-drew', 'Drew Participant'],
    ].map(([id, name]) => ({
      id: id!,
      name: name!,
      email: `${id}@rally.test`,
      timezone: 'America/Los_Angeles',
    }));
    const { container } = render(
      <Tooltip.Provider>
        <AvatarStack extraCount={0} limit={3} members={members} />
      </Tooltip.Provider>,
    );

    expect(container.querySelector('.avatar-overflow')).toBeNull();
  });
});

describe('OpeningState', () => {
  it('centralizes the large connecting orb used while screens open', () => {
    render(<OpeningState label="Opening automation…" />);

    expect(screen.getByRole('status')).toHaveTextContent('Opening automation…');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-state', 'connecting');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-size', '64');
  });

  /**
   * The orb paints a canvas, so nothing in `app.css` can reach its ink and the
   * appearance has to arrive as a prop. A light window with a dark-pinned orb
   * drew near-white dots on near-white ground.
   */
  it.each([['light'], ['dark']] as const)('draws the orb for a %s window', (mode) => {
    window.localStorage.setItem(
      DEVICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, theme: mode }),
    );

    render(<OpeningState label="Opening automation…" />);

    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-theme', mode);
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

  it('does not dismiss when a portaled menu item from inside it is chosen', async () => {
    const onOpenChange = vi.fn();
    render(
      <Tooltip.Provider>
        <Modal onOpenChange={onOpenChange} open title="Add a participant">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button">Katherine participant actions</button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu-content">
                <DropdownMenu.Item className="menu-item">Remove from thread</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </Modal>
      </Tooltip.Provider>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Katherine participant actions' }), {
      button: 0,
      ctrlKey: false,
    });
    const remove = await screen.findByRole('menuitem', { name: 'Remove from thread' });
    fireEvent.pointerDown(remove, { button: 0 });
    fireEvent.click(remove);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('leaves a dialog that must not be dismissed only through its footer, with no button focused to press by accident', async () => {
    const onOpenChange = vi.fn();
    render(
      <Tooltip.Provider>
        <Modal dismissible={false} footer={<button type="button">Cancel</button>} onOpenChange={onOpenChange} open title="Importing conversation">
          <p>Reading the page</p>
        </Modal>
      </Tooltip.Provider>,
    );

    expect(screen.queryByRole('button', { name: 'Close dialog' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
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
