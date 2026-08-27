import * as AvatarPrimitive from '@radix-ui/react-avatar';
import * as Dialog from '@radix-ui/react-dialog';
import * as Select from '@radix-ui/react-select';
import * as Tooltip from '@radix-ui/react-tooltip';
import clsx from 'clsx';
import { Check, ChevronDown, LoaderCircle, X } from 'lucide-react';
import { ThinkingOrb, type OrbSize, type OrbState } from 'thinking-orbs';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type PropsWithChildren,
  type RefObject,
  type ReactNode,
} from 'react';
import { statusDescription, statusLabel, type WorkstreamMarkerStatus } from '../lib/format';
import type { WorkspaceMember } from '../lib/types';
import type { SocketState } from '../lib/use-workstream-socket';

export function RallyMark({ className }: { className?: string }): React.JSX.Element {
  return <span aria-hidden="true" className={clsx('rally-mark', className)} />;
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function Button({ className, type = 'button', ...props }, ref) {
    return <button ref={ref} className={clsx('button', className)} type={type} {...props} />;
  },
);

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, label, tooltipSide = 'bottom', ...props },
  ref,
) {
  return (
    <Tooltip.Root delayDuration={450}>
      <Tooltip.Trigger asChild>
        <button ref={ref} aria-label={label} className={clsx('icon-button', className)} type="button" {...props} />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" side={tooltipSide} sideOffset={6}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
});

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
    <Tooltip.Root delayDuration={300}>
      <Tooltip.Trigger asChild>{indicator}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content align="start" className="tooltip" side="top" sideOffset={8}>
          {statusDescription[status]}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const socketStateCopy: Record<SocketState, { label: string; description: string }> = {
  idle: {
    label: 'Live updates are loading',
    description: 'Live updates are waiting for this work stream to load.',
  },
  connecting: {
    label: 'Connecting to live updates',
    description: 'Rally is connecting to live work-stream updates.',
  },
  connected: {
    label: 'Live updates connected',
    description: 'Live work-stream updates are connected.',
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
    <Tooltip.Root delayDuration={300}>
      <Tooltip.Trigger asChild>
        <span
          aria-label={copy.label}
          className={clsx('socket-state', 'header-socket-state', `socket-${state}`)}
          role="status"
          tabIndex={0}
        >
          <span aria-hidden="true" />
          <span className="sr-only">{copy.label}</span>
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" side="bottom" sideOffset={6}>
          {copy.description}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function Avatar({
  member,
  size = 'medium',
  title = member.name,
}: {
  member: WorkspaceMember;
  size?: 'small' | 'medium' | 'large';
  title?: string | null;
}): React.JSX.Element {
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

export function AvatarStack({
  members,
  limit = 4,
  presentUserIds = [],
  currentUserId = null,
}: {
  members: WorkspaceMember[];
  limit?: number;
  presentUserIds?: readonly string[];
  currentUserId?: string | null;
}): React.JSX.Element {
  const visible = members.slice(0, limit);
  const overflow = members.length - visible.length;
  const present = new Set(presentUserIds);
  return (
    <span
      aria-label={members.map((member) => (
        present.has(member.id) && member.id !== currentUserId
          ? `${member.name} is viewing this workstream.`
          : member.name
      )).join('; ')}
      className="avatar-stack"
    >
      {visible.map((member) => {
        const showingPresence = present.has(member.id) && member.id !== currentUserId;
        if (!showingPresence) {
          return (
            <span className="avatar-stack-item" key={member.id}>
              <Avatar member={member} size="small" />
            </span>
          );
        }
        const presenceDescription = `${member.name} is viewing this workstream.`;
        return (
          <Tooltip.Root delayDuration={300} key={member.id}>
            <Tooltip.Trigger asChild>
              <span className="avatar-stack-item is-present">
                <span aria-hidden="true" className="avatar-presence-ping" />
                <Avatar member={member} size="small" title={null} />
              </span>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="tooltip" side="bottom" sideOffset={6}>
                {presenceDescription}
                <Tooltip.Arrow className="tooltip-arrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        );
      })}
      {overflow > 0 && <span className="avatar-overflow">+{overflow}</span>}
    </span>
  );
}

export function Badge({ children, className, ...props }: PropsWithChildren<HTMLAttributes<HTMLSpanElement>>): React.JSX.Element {
  return (
    <span className={clsx('badge', className)} {...props}>
      {children}
    </span>
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
      <span className="sr-only">Rally is naming this work stream</span>
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
  variant?: 'primary' | 'secondary';
}

/** Shared settings selector: bordered for primary form controls, text-only for
 * compact preference rows. Radix supplies native keyboard and screen-reader behavior. */
export function DropdownSelect({
  ariaLabel,
  disabled = false,
  onValueChange,
  options,
  value,
  variant = 'primary',
}: DropdownSelectProps): React.JSX.Element {
  return (
    <Select.Root disabled={disabled} onValueChange={onValueChange} value={value}>
      <Select.Trigger
        aria-label={ariaLabel}
        className={clsx('dropdown-select-trigger', `dropdown-select-trigger-${variant}`)}
      >
        <Select.Value />
        <Select.Icon aria-hidden="true" className="dropdown-select-chevron">
          <ChevronDown size={15} strokeWidth={1.7} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className={clsx('dropdown-select-content', `dropdown-select-content-${variant}`)}
          collisionPadding={10}
          position="popper"
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
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  initialFocusRef,
}: ModalProps): React.JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content"
          onOpenAutoFocus={(event) => {
            const initialFocus = initialFocusRef?.current;
            if (!initialFocus) return;
            event.preventDefault();
            initialFocus.focus();
          }}
        >
          <header className="dialog-header">
            <div>
              <Dialog.Title className="dialog-title">{title}</Dialog.Title>
              {description && <Dialog.Description className="dialog-description">{description}</Dialog.Description>}
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close dialog">
                <X size={16} />
              </IconButton>
            </Dialog.Close>
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
  return (
    <div aria-live="polite" className="center-state" role="status">
      {orbState
        ? <ThinkingOrb aria-hidden="true" className="loading-orb" size={orbSize} state={orbState} theme="dark" />
        : <LoaderCircle aria-hidden="true" className="spin" size={18} />}
      <span>{label}</span>
    </div>
  );
}

export function OpeningState({ label }: { label: string }): React.JSX.Element {
  return <LoadingState label={label} orbSize={64} orbState="connecting" />;
}

export function InlineError({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <p className="inline-error" role="alert">
      {children}
    </p>
  );
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
