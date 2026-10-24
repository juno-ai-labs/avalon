import { useContext, useRef, useState } from 'react';
import { MemberPresentationContext } from '../lib/member-presentation';
import { PersonalAvatar, personalColor } from './personal-avatar';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import * as Dialog from '@radix-ui/react-dialog';
import * as Select from '@radix-ui/react-select';
import * as Tooltip from '@radix-ui/react-tooltip';
import clsx from 'clsx';
import { Check, ChevronDown, LoaderCircle, X } from 'lucide-react';
import { ThinkingOrb, type OrbSize, type OrbState } from 'thinking-orbs';
import {
  Fragment,
  cloneElement,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type PropsWithChildren,
  type RefObject,
  type ReactNode,
} from 'react';
import { statusDescription, statusLabel, type WorkstreamMarkerStatus } from '../lib/format';
import { PLUGIN_BRAND_MARKS, type PluginBrandMark } from '../lib/plugin-marks';
import { isComposingKeyEvent } from '../lib/ime';
import { useAppearance } from '../lib/theme';
import { focusFollowsKeyboard, hasUserInputSinceWindowActivation, useWindowDeactivated } from '../lib/window-activation';
import type { WorkspaceMember } from '../lib/types';
import type { SocketState } from '../lib/types';

export function RallyMark({ className }: { className?: string }): React.JSX.Element {
  return <span aria-hidden="true" className={clsx('rally-mark', className)} />;
}

/**
 * A company's mark, drawn in the surrounding text's own colour.
 *
 * Every surface that draws a connector draws it through here, so the mark, its
 * colour, and the way it is put on the page are decided once.
 *
 * `variant="mono"` is the package's own single-colour art, which paints in
 * `currentColor`. Two brands ship no `mono` and fall back to their colour art,
 * so `.connector-mark` recolours any painted shape inside — see the rule beside
 * it. Nothing here reads a theme: one neutral covers all four.
 */
export function ConnectorMark({ className, mark }: {
  className?: string;
  mark: PluginBrandMark;
}): React.JSX.Element {
  const brand = PLUGIN_BRAND_MARKS[mark];
  return (
    <span aria-hidden="true" className={clsx('connector-mark', className)}>
      {brand.mono ? <brand.Mark variant="mono" /> : <brand.Mark />}
    </span>
  );
}

/**
 * The tooltip subtree, once: root, trigger, portal, content, arrow.
 *
 * Five elements to say one thing, and every hand-rolled copy is a chance to
 * leave off the portal — which is what keeps a tooltip from being clipped by a
 * scrolling rail's `overflow` — or the arrow, or the class the theme paints
 * through. It exists so a surface reaches for this rather than for the native
 * `title` attribute, which draws the platform's own tooltip after its own
 * delay, in the platform's own type, and never appears on keyboard focus.
 *
 * The trigger is `asChild`, so the child element *is* the trigger and keeps its
 * own classes, ref and handlers. Radix's Slot string-merges `className`, so an
 * element whose class is a *callback* — a `NavLink` — reaches the DOM wearing
 * that callback's source text and no styling at all. Resolve the class to a
 * string at the call site and the link slots directly; a plain wrapper is the
 * fallback for where that cannot be done, and costs the child its own place in
 * the DOM — it becomes the flex or grid item its parent lays out, and any rule
 * written `.parent > .child` stops matching.
 */
export function Tip({
  align,
  children,
  className,
  collisionPadding = 12,
  delayDuration = 450,
  describesTrigger = true,
  disableHoverableContent,
  label,
  onOpenChange,
  open,
  side = 'bottom',
  sideOffset = 6,
}: {
  align?: 'start' | 'center' | 'end';
  children: React.ReactNode;
  /** A modifier beside `.tooltip`, for a shape the base rule does not cover. */
  className?: string;
  /**
   * How close to the viewport edge the popper may sit. Radix allows zero, which
   * reads as clipped for a tip explaining something at the edge of a pane — so
   * the default here is a gutter rather than Radix's none, and a caller states
   * its own only to want something else.
   */
  collisionPadding?: number;
  delayDuration?: number;
  /**
   * Whether the open tooltip is also the trigger's accessible *description*,
   * which is what Radix does by default.
   *
   * Set false when the trigger's accessible name is already this same string:
   * a name and a description that read alike are announced one after the other,
   * so a screen reader says the sentence twice for a control that only ever had
   * one. The words are not lost — they are still the name — and the box is then
   * purely what a pointer needs.
   */
  describesTrigger?: boolean;
  /**
   * Whether the pointer may travel into the tooltip and keep it open. Off for a
   * tooltip hanging off something small that the pointer is aiming at rather
   * than reading.
   */
  disableHoverableContent?: boolean;
  label: React.ReactNode;
  /**
   * Pass both to take the answer over: Radix still decides *when* to open, and
   * reports it here, but the caller renders `open`. Leave both out and the tip
   * decides for itself, which is what almost every caller wants.
   *
   * Either way, `onOpenChange` hears every close — including the one the window
   * deactivation below performs, which is what lets a caller holding `open` put
   * its own tip down rather than render it back over the returning window.
   */
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
}): React.JSX.Element {
  // Radix puts `aria-describedby` on whatever the trigger renders; a prop the
  // child states itself wins that merge, so an explicit `undefined` is how the
  // description comes back off. The child has to forward the props it is given
  // for that to reach the DOM, which is the same thing `asChild` already needs.
  const trigger = describesTrigger || !isValidElement(children)
    ? children
    : cloneElement(children, { 'aria-describedby': undefined } as Record<string, unknown>);
  // Radix would keep this state itself, and the one thing gained by holding it
  // here is the ability to put it down: a tip that was up when the window went
  // to the back has nothing to close it — the pointer never left the trigger —
  // so it is still up when the person switches back, over the screen they came
  // back to.
  const [hovered, setHovered] = useState(false);
  const isOpen = open ?? hovered;
  // Reported as a close rather than only dropped, because a caller holding
  // `open` renders the answer and telling it is the only way to put its tip
  // down. `DragHint` is one, and a resize handle's hint is the likeliest of all
  // of these to still be up when the window goes away: the pointer that opened
  // it is resting on a 12px divider it has no reason to leave.
  useWindowDeactivated(() => {
    if (!isOpen) return;
    setHovered(false);
    onOpenChange?.(false);
  });
  return (
    <Tooltip.Root
      delayDuration={delayDuration}
      disableHoverableContent={disableHoverableContent}
      onOpenChange={(next) => {
        setHovered(next);
        onOpenChange?.(next);
      }}
      open={isOpen}
    >
      <Tooltip.Trigger
        asChild
        // Radix opens on the trigger's focus and on the pointer moving over it,
        // and an app switch produces both: the control that had focus is focused
        // again, and the window arrives under a cursor that never moved. Neither
        // is a person asking what a control is, so neither should answer.
        //
        // `preventDefault` is how Radix is told to stand down — it composes a
        // caller's handler ahead of its own and skips its own on a prevented
        // event — and it is the whole intervention: the trigger keeps every
        // other behaviour, and the next real focus or movement opens the tip as
        // it always did. Focus also opens only after a key; see
        // `focusFollowsKeyboard` in `lib/window-activation.ts`.
        onFocus={(event) => {
          if (!hasUserInputSinceWindowActivation() || !focusFollowsKeyboard()) event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (!hasUserInputSinceWindowActivation()) event.preventDefault();
        }}
      >
        {trigger}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          align={align}
          className={clsx('tooltip', className)}
          collisionPadding={collisionPadding}
          side={side}
          sideOffset={sideOffset}
        >
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * A set of controls that explain themselves as one: the first tip pays the
 * delay, and moving along the rest of the row opens them immediately.
 *
 * It renders no element of its own, so it can wrap a row without joining its
 * layout. Mount one around any cluster of tips a pointer travels along — and
 * around any tip whose surface may be rendered outside `App`, which is the
 * other thing Radix needs a provider for.
 *
 * A tip in a group closes the moment the pointer leaves its control, the same
 * thing `disableHoverableContent` says one at a time: there is nothing inside
 * one of these to hover, and on a row that appears on hover, Radix's default of
 * keeping a box open while the pointer is over *it* outlives the row itself.
 */
export function TipGroup({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <Tooltip.Provider delayDuration={450} disableHoverableContent>
      {children}
    </Tooltip.Provider>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Keep unavailable controls focusable so their explanation can be read. */
  disabledReason?: string | undefined;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ className, type = 'button', disabledReason, disabled, onClick, ...props }, ref) {
    const button = <button
      ref={ref}
      className={clsx('button', className)}
      type={type}
      {...props}
      aria-disabled={disabledReason ? true : props['aria-disabled']}
      disabled={disabled && !disabledReason}
      onClick={disabledReason ? (event) => event.preventDefault() : onClick}
    />;
    return disabledReason ? <Tip label={disabledReason}>{button}</Tip> : button;
  },
);

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  /** Keep unavailable controls focusable so their explanation can be read. */
  disabledReason?: string;
  /**
   * Set false when the icon's meaning is already obvious from its position (e.g. a
   * dialog's close X) — skips mounting the `Tip` subtree entirely.
   */
  showTooltip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, label, disabledReason, disabled, onClick, tooltipSide = 'bottom', showTooltip = true, ...props },
  ref,
) {
  const button = (
    <button
      ref={ref}
      aria-label={label}
      className={clsx('icon-button', className)}
      type="button"
      {...props}
      aria-disabled={disabledReason ? true : props['aria-disabled']}
      disabled={disabled && !disabledReason}
      onClick={disabledReason ? (event) => event.preventDefault() : onClick}
    />
  );

  if (!showTooltip) return button;

  return <Tip describesTrigger={Boolean(disabledReason)} label={disabledReason ?? label} side={tooltipSide}>{button}</Tip>;
});

interface DragHintProps {
  /** The handle itself: whatever the pointer can already grab. */
  children: React.ReactElement;
  /** What dragging it does, e.g. `Drag to resize`. */
  action: string;
  /**
   * The faster route to the same place: the double-click that collapses a
   * sidebar, and the key that does the same thing without a pointer. Name both
   * where both exist. This line is read on focus as well as on hover, so a
   * pointer gesture on its own tells a keyboard reader about something they
   * cannot do. Left out when the handle has no quick action, and when the
   * window is too narrow for the one it would otherwise name, because a hint
   * that promises an action which does nothing is worse than no hint.
   */
  shortcut?: string | undefined;
  /** Which way the hint leans off the handle: away from what it resizes. */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /**
   * True while the handle is being dragged. The gesture has to say so itself:
   * a grab focuses the handle, and a focus is how a tooltip decides to open
   * without waiting out its delay, so on a quick grab the press *opens* the
   * hint instead of dismissing it. Radix's own dismissal cannot catch that one,
   * because it reads an open state from the render before the focus.
   */
  suppressed?: boolean;
}

/**
 * The hint a drag handle shows on hover: a `Tip` with two lines and a veto.
 * A grip is the one control here that
 * carries no words of its own, so nothing on screen said that the dividers
 * could be dragged at all, or that double-clicking one collapses the sidebar
 * beside it. That shortcut has been in the code the whole time and was
 * reachable only by guessing.
 *
 * The trigger is the handle's whole pointer target rather than the grip drawn
 * inside it: the target is what can be grabbed, and it is also what reveals
 * the grip, so the hint and the pill appear for the same gesture. Both
 * dividers centre their grip in that target, which is why the content is
 * centre-aligned: it lands beside the pill without either side measuring the
 * other.
 */
export function DragHint({ action, children, shortcut, side = 'right', suppressed = false }: DragHintProps): React.JSX.Element {
  // Radix still decides when to open: the delay, the hover, and the focus are
  // all its own, and this only takes a veto over the answer. Corrected during
  // the render rather than in an effect because the open and the drag land in
  // the same batch, and a hint that commits to the screen for one frame over
  // the edge it is about is the whole defect.
  const [open, setOpen] = useState(false);
  if (open && suppressed) setOpen(false);

  return (
    // `disableHoverableContent`, where the rest of the app leaves it on: those
    // tooltips hang off controls with room around them, while this one hangs
    // off a 12px divider with the transcript immediately beside it. Letting the
    // pointer travel into the hint would hold it open over the thing the handle
    // is there to reveal, and a two-line hint has nothing in it to travel for.
    // `sideOffset` is 8 rather than `Tip`'s 6 because the grip pill overhangs
    // its pointer target by 2px on each side, so 8 leaves the same air.
    <Tip
      className="tooltip-hint"
      disableHoverableContent
      label={<>
        <span>{action}</span>
        {shortcut !== undefined && <small>{shortcut}</small>}
      </>}
      onOpenChange={setOpen}
      open={open}
      side={side}
      sideOffset={8}
    >{children}</Tip>
  );
}

export function StatusDot({
  status,
  compact = false,
  tooltip = false,
}: {
  status: WorkstreamMarkerStatus;
  compact?: boolean;
  /** Explain the color on hover. For a compact dot that carries no visible label. */
  tooltip?: boolean;
}): React.JSX.Element {
  const indicator = (
    <span className={clsx('status-indicator', `status-${status}`, compact && 'status-compact')}>
      <span aria-hidden="true" className="status-dot" />
      {!compact && <span>{statusLabel[status]}</span>}
      {compact && <span className="sr-only">{statusLabel[status]}</span>}
    </span>
  );
  if (!tooltip) return indicator;
  return (
    <Tip align="start" delayDuration={300} label={statusDescription[status]} side="top" sideOffset={8}>
      {indicator}
    </Tip>
  );
}

const socketStateCopy: Record<SocketState, { label: string; description: string }> = {
  idle: {
    label: 'Live updates are loading',
    description: 'Live updates are waiting for this thread to load.',
  },
  connecting: {
    label: 'Connecting to live updates',
    description: 'Rally is connecting to live thread updates.',
  },
  connected: {
    label: 'Live updates connected',
    description: 'Live thread updates are connected.',
  },
  reconnecting: {
    label: 'Reconnecting live updates',
    description: 'The connection was interrupted. Rally is reconnecting live updates.',
  },
  unavailable: {
    label: 'Live updates unavailable',
    description: 'Live updates are unavailable. Rally will keep trying to reconnect.',
  },
};

export function SocketStatusIndicator({ state }: { state: SocketState }): React.JSX.Element {
  const copy = socketStateCopy[state];
  return (
    <Tip delayDuration={300} label={copy.description} side="bottom">
      <span
        aria-label={copy.label}
        className={clsx('socket-state', 'header-socket-state', `socket-${state}`)}
        role="status"
        tabIndex={0}
      >
        <span aria-hidden="true" />
        <span className="sr-only">{copy.label}</span>
      </span>
    </Tip>
  );
}

export function Avatar({
  member,
  size = 'medium',
  title = member.name,
}: {
  /** Only a name and a face are drawn, so a roster entry without an address will do. */
  member: Pick<WorkspaceMember, 'id' | 'name'> & Partial<WorkspaceMember>;
  size?: 'small' | 'medium' | 'large';
  title?: string | null;
}): React.JSX.Element {
  const presentation = useContext(MemberPresentationContext).get(member.id) ?? member.presentation;
  if (presentation) return <span className={clsx('avatar', `avatar-${size}`)} title={title ?? undefined}><PersonalAvatar color={presentation.color} avatar={presentation.avatar} initials={presentation.initials} /></span>;
  const initials = member.name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <AvatarPrimitive.Root className={clsx('avatar', `avatar-${size}`)} title={title ?? undefined}>
      {member.avatarUrl && <AvatarPrimitive.Image alt="" className="avatar-image" src={member.avatarUrl} />}
      <AvatarPrimitive.Fallback className="avatar-fallback" delayMs={200}>
        {initials || '?'}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

/** Rally's own avatar: the brand "R", wherever Rally sits beside people. */
export function RallyAvatar({ size = 'medium' }: { size?: 'small' | 'medium' | 'large' }): React.JSX.Element {
  return <span className={clsx('avatar', `avatar-${size}`, 'avatar-rally')}><span className="avatar-fallback">R</span></span>;
}

export function AvatarStack({
  members,
  limit = 4,
  extraCount,
  presentUserIds = [],
  currentUserId = null,
  nameTooltip = true,
  showTooltip = true,
}: {
  members: WorkspaceMember[];
  limit?: number;
  /**
   * Overflow past `limit` when the caller already truncated `members`.
   * Omit to derive it from `members.length`.
   */
  extraCount?: number;
  /**
   * Ids of members currently viewing this work stream. Members in this set who
   * are not `currentUserId` get a presence ring and an "is viewing" tooltip.
   */
  presentUserIds?: readonly string[];
  /**
   * The signed-in viewer. When set, their avatar never shows a presence ping
   * or "is viewing" tooltip — that sentence is about other people. Callers
   * that do not pass presence can omit this; the default is `null`.
   */
  currentUserId?: string | null;
  /**
   * When false, skip the per-face name tooltip. Presence still opens one.
   * Use this when an ancestor already explains the stack — a second tooltip
   * on the same hover is the native-`title` problem this component exists to
   * avoid.
   */
  nameTooltip?: boolean;
  /** Disable all per-face tooltips when the containing control owns the tooltip. */
  showTooltip?: boolean;
}): React.JSX.Element {
  const visible = members.slice(0, limit);
  const overflow = extraCount ?? Math.max(0, members.length - visible.length);
  const presentations = useContext(MemberPresentationContext);
  const present = new Set(presentUserIds);
  const named = members.map((member) => (
    present.has(member.id) && member.id !== currentUserId
      ? `${member.name} is viewing this thread.`
      : member.name
  ));
  if (overflow > 0) named.push(`and ${overflow} more`);
  return (
    <span
      aria-label={named.join('; ')}
      className="avatar-stack"
      data-visible-count={visible.length}
    >
      {visible.map((member) => {
        const showingPresence = present.has(member.id) && member.id !== currentUserId;
        const tooltip = showingPresence
          ? `${member.name} is viewing this thread.`
          : member.name;
        const presenceColor = (presentations.get(member.id) ?? member.presentation)?.color;
        const item = (
          <span
            className={clsx(
              'avatar-stack-item',
              showingPresence && 'is-present',
            )}
          >
            {showingPresence && (
              <span
                aria-hidden="true"
                className="avatar-presence-ping"
                style={{ '--person-accent': presenceColor ? personalColor(presenceColor) : 'var(--av-sys-color-success-base)' } as React.CSSProperties}
              />
            )}
            <Avatar member={member} size="small" title={null} />
          </span>
        );
        if (!showTooltip || (!nameTooltip && !showingPresence)) {
          return <Fragment key={member.id}>{item}</Fragment>;
        }
        return <Tip delayDuration={300} key={member.id} label={tooltip} side="bottom">{item}</Tip>;
      })}
      {overflow > 0 && <span className="avatar-overflow">+{overflow}</span>}
    </span>
  );
}

export interface SegmentedOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /** Native tooltip for a segment whose one-word label needs a sentence. */
  readonly title?: string;
}

/**
 * One exclusive choice, drawn as a row of pills inside a single track.
 *
 * Every settings surface that offers three or four mutually exclusive options
 * in a strip — the appearance preference, the connections filter — draws it
 * through here, so the track, the selected pill and the interaction states are
 * decided once. A second strip with its own rules is how the two drifted apart
 * in the first place.
 *
 * It is a radio group, not a row of toggle buttons: the options are exclusive
 * and exactly one is always chosen, which is what `radiogroup` describes and
 * what a pressed-button group does not. That brings the pattern's keyboard
 * contract with it — the arrows move the choice, and only the chosen segment is
 * a tab stop, so the strip costs one Tab rather than one per option.
 */
export function SegmentedControl<Value extends string>({
  ariaLabel,
  className,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  className?: string;
  onChange: (value: Value) => void;
  options: readonly SegmentedOption<Value>[];
  value: Value;
}): React.JSX.Element {
  const selected = options.findIndex((option) => option.value === value);
  // Nothing matched: the first segment carries the tab stop so the strip stays
  // reachable rather than dropping out of the tab order entirely.
  const tabStop = selected === -1 ? 0 : selected;
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    // Unmodified keys only, which is all the radiogroup pattern claims. A
    // modified arrow belongs to the platform — VoiceOver moves with
    // Ctrl-Option-Arrow — and taking it here would change the setting under
    // someone who was trying to move past it, then `preventDefault` the move
    // they actually asked for.
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
      : event.key === 'Home' ? -index
      : event.key === 'End' ? options.length - 1 - index
      : 0;
    if (step === 0 && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    const strip = event.currentTarget.parentElement;
    const target = strip?.querySelectorAll<HTMLButtonElement>('button')[
      (index + step + options.length) % options.length
    ];
    target?.focus();
  };
  return (
    <div aria-label={ariaLabel} className={clsx('segmented', className)} role="radiogroup">
      {options.map((option, index) => (
        <button
          aria-checked={option.value === value}
          key={option.value}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => move(event, index)}
          role="radio"
          tabIndex={index === tabStop ? 0 : -1}
          title={option.title}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ children, className, ...props }: PropsWithChildren<HTMLAttributes<HTMLSpanElement>>): React.JSX.Element {
  return (
    <span className={clsx('badge', className)} {...props}>
      {children}
    </span>
  );
}

export type MeterTone = 'normal' | 'warning';

/**
 * A measured share drawn as a fill on a track: the week's quota left, the
 * onboarding steps done. Every bar of that kind draws through here, so the
 * track, the fill, the warning colour and the value attributes are decided once
 * and the next meter costs no new CSS.
 *
 * `label` is required because a meter with no name is announced as a bare
 * number. A null `value` is the measurement not having arrived: the empty track
 * is drawn so the layout does not jump when it does, and it is hidden from the
 * accessibility tree, since a meter with no value has nothing to say and the
 * surface beside it says what it is waiting for.
 *
 * `role` is what assistive technology hears, and the drawing is the same for
 * both: `meter` for a measurement such as quota left, `progressbar` for a task
 * moving towards done such as onboarding steps.
 */
export function Meter({
  className,
  label,
  max = 100,
  role = 'meter',
  size = 'regular',
  tone = 'normal',
  value,
}: {
  className?: string;
  label: string;
  max?: number;
  role?: 'meter' | 'progressbar';
  size?: 'regular' | 'thin';
  tone?: MeterTone;
  value: number | null;
}): React.JSX.Element {
  const classes = clsx('meter', size === 'thin' && 'meter-thin', tone === 'warning' && 'meter-warning', className);
  if (value === null) return <div aria-hidden="true" className={classes} />;
  const clamped = Math.min(max, Math.max(0, value));
  return (
    <div
      aria-label={label}
      aria-valuemax={max}
      aria-valuemin={0}
      aria-valuenow={clamped}
      className={classes}
      role={role}
    >
      <span className="meter-fill" style={{ width: `${max > 0 ? (clamped / max) * 100 : 0}%` }} />
    </div>
  );
}

/**
 * Stands in for a work stream's title while Rally is choosing one.
 *
 * The title a work stream is created with is the first line of the request,
 * which is a placeholder rather than a name — showing it and swapping it a
 * second later reads as a glitch, while a skeleton reads as what it is.
 *
 * The label is text rather than an `aria-label`, because what needs a name
 * here is the heading or the row this sits inside, and an `aria-label` on a
 * bare span does not reliably reach either. It carries no live region of its
 * own: the sidebar renders one of these per unnamed row, and a list that
 * announces itself once per row is worse than one that says nothing. Where an
 * arriving name is worth announcing — the header of the work stream someone is
 * reading — the title line around it is the live region.
 */
export function TitleSkeleton({ className }: { className?: string }): React.JSX.Element {
  return (
    <span className={clsx('title-skeleton', className)}>
      <span className="sr-only">Rally is choosing a name</span>
    </span>
  );
}

export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
}

interface DropdownSelectProps {
  ariaLabel: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
  options: DropdownOption[];
  value: string;
  variant?: 'primary' | 'secondary' | 'pill';
  /** Where the list opens; it flips when there is no room. */
  side?: 'top' | 'bottom';
}

/** Shared settings selector: bordered for primary form controls, text-only for
 * compact preference rows, and a filled pill for a choice set inline in a row
 * (the new-Channel Space). Radix supplies native keyboard and screen-reader behavior. */
export function DropdownSelect({
  ariaLabel,
  disabled = false,
  onValueChange,
  options,
  value,
  variant = 'primary',
  side = 'bottom',
}: DropdownSelectProps): React.JSX.Element {
  return (
    <Select.Root disabled={disabled} onValueChange={onValueChange} value={value}>
      <Select.Trigger
        aria-label={ariaLabel}
        className={clsx('dropdown-select-trigger', `dropdown-select-trigger-${variant}`)}
      >
        <Select.Value />
        <Select.Icon aria-hidden="true" className="dropdown-select-chevron">
          <ChevronDown size={variant === 'pill' ? 13 : 15} strokeWidth={1.7} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className={clsx('dropdown-select-content', `dropdown-select-content-${variant}`)}
          collisionPadding={10}
          position="popper"
          side={side}
          sideOffset={6}
        >
          <Select.Viewport className="dropdown-select-viewport">
            {options.map((option) => (
              <Select.Item className="dropdown-select-item" key={option.value} value={option.value}>
                <span className="dropdown-select-item-copy">
                  <Select.ItemText>{option.label}</Select.ItemText>
                  {option.description && <small>{option.description}</small>}
                </span>
                <Select.ItemIndicator className="dropdown-select-indicator">
                  <Check size={17} strokeWidth={2} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

interface ModalProps {
  role?: 'dialog' | 'alertdialog';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Return focus to the interrupted control when acknowledging an error. */
  restoreFocus?: boolean;
  showCloseButton?: boolean;
  /**
   * Refuse Escape, a click outside and the header's close button, leaving the
   * footer as the only way out, and open with focus on the dialog itself
   * rather than its first button, so a stray Enter presses nothing.
   *
   * For a dialog whose accidental dismissal destroys something a reopen
   * cannot bring back: a value shown exactly once — a generated signing secret
   * that cannot be asked for again — or long-running work the dialog holds
   * the window for, such as a conversation import minutes in. Everywhere else
   * an accidental dismissal costs a reopen, and taking Escape away from a
   * person to save them a reopen is the wrong trade.
   */
  dismissible?: boolean;
  /** Controls at the header's right edge, before the close button: a dialog's own menu. */
  headerActions?: ReactNode;
  /**
   * What sits between the dialog and the window. `blur` is the lightbox's
   * frosted veil, for a dialog that holds the window while work happens behind
   * it and should still show that work.
   */
  backdrop?: 'scrim' | 'blur';
}

export function Modal({
  role = 'dialog',
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  initialFocusRef,
  restoreFocus = false,
  showCloseButton = true,
  dismissible = true,
  headerActions,
  backdrop = 'scrim',
}: ModalProps): React.JSX.Element {
  const previousFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={backdrop === 'blur' ? 'dialog-overlay is-blurred' : 'dialog-overlay'} data-error-notice-overlay={role === 'alertdialog' || undefined} />
        <Dialog.Content
          role={role}
          className="dialog-content"
          /* Escape belongs to the IME while it is composing: it abandons the
             candidate, and Radix must not read the same keystroke as a request
             to close the dialog and take the typed draft with it. Radix calls
             this before dismissing and skips the dismissal when the event is
             defaultPrevented. A native KeyboardEvent, so no `nativeEvent`. */
          onEscapeKeyDown={(event) => {
            if (!dismissible || isComposingKeyEvent(event)) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (!dismissible) {
              event.preventDefault();
              return;
            }
            // Menus portal to the document, so a click on one is "outside" the
            // dialog content even when the trigger lives inside it. Treating
            // that as a dismissal closes the participant dialog on Remove.
            const target = event.target;
            if (target instanceof Element && target.closest('.menu-content')) {
              event.preventDefault();
            }
          }}
          onOpenAutoFocus={(event) => {
            if (restoreFocus && document.activeElement instanceof HTMLElement) {
              previousFocus.current = document.activeElement;
            }
            const initialFocus = initialFocusRef?.current;
            if (initialFocus) {
              event.preventDefault();
              initialFocus.focus();
            } else if (!dismissible && event.currentTarget instanceof HTMLElement) {
              event.preventDefault();
              event.currentTarget.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            if (restoreFocus && previousFocus.current?.isConnected) {
              event.preventDefault();
              previousFocus.current.focus();
            }
          }}
        >
          <header className="dialog-header">
            <div>
              <Dialog.Title className="dialog-title">{title}</Dialog.Title>
              {description && <Dialog.Description className="dialog-description">{description}</Dialog.Description>}
            </div>
            {(headerActions || (dismissible && showCloseButton)) && <div className="dialog-header-actions">
              {headerActions}
              {dismissible && showCloseButton && <Dialog.Close asChild>
                <IconButton label="Close dialog" showTooltip={false}>
                  <X size={16} />
                </IconButton>
              </Dialog.Close>}
            </div>}
          </header>
          {children != null && <div className="dialog-body">{children}</div>}
          {footer && <footer className="dialog-footer">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function LoadingState({
  label = 'Loading…',
  orbSize = 20,
  orbState,
}: {
  label?: string;
  orbSize?: OrbSize;
  orbState?: OrbState;
}): React.JSX.Element {
  const appearance = useAppearance();

  return (
    <div aria-live="polite" className="center-state" role="status">
      {orbState
        ? <ThinkingOrb aria-hidden="true" className="loading-orb" size={orbSize} state={orbState} theme={appearance} />
        : <LoaderCircle aria-hidden="true" className="spin" size={18} />}
      <span>{label}</span>
    </div>
  );
}

export function OpeningState({ label }: { label: string }): React.JSX.Element {
  return <LoadingState label={label} orbSize={64} orbState="connecting" />;
}

/** What an activity count says to a screen reader, which hears it in place of the badge. */
export function activityCountLabel(count: number): string {
  return `${count} conversation${count === 1 ? '' : 's'} with new activity`;
}

/** An Organization's activity count, or nothing at zero; the row carries `activityCountLabel`. */
export function ActivityCountBadge({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) return null;
  return <span aria-hidden="true" className="activity-count-badge">{count > 99 ? '99+' : count}</span>;
}

export { ErrorNotice } from './error-notice';

/**
 * One hairline box around a group, rather than a card around each member.
 *
 * The shell already treats a group this way; this is that treatment as an
 * unscoped primitive, so a lightbox or any other portal gets it without a
 * shell ancestor. It draws the container and nothing else: what goes inside is
 * the caller's, which is what lets a table and a list of thrown errors share
 * one edge instead of inventing two.
 */
export function InsetSurface({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>): React.JSX.Element {
  return <div className={clsx('inset-surface', className)} {...props}>{children}</div>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }): React.JSX.Element {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{title}</p>
      <p>{description}</p>
      {action}
    </div>
  );
}
