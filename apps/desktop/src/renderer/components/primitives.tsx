import * as AvatarPrimitive from '@radix-ui/react-avatar';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import clsx from 'clsx';
import { LoaderCircle, X } from 'lucide-react';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { statusLabel } from '../lib/format';
import type { HarnessStatus, WorkspaceMember } from '../lib/types';

export function AvalonMark({ className }: { className?: string }): React.JSX.Element {
  return <span aria-hidden="true" className={clsx('avalon-mark', className)} />;
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

export function StatusDot({ status, compact = false }: { status: HarnessStatus; compact?: boolean }): React.JSX.Element {
  return (
    <span className={clsx('status-indicator', `status-${status}`, compact && 'status-compact')}>
      <span aria-hidden="true" className="status-dot" />
      {!compact && <span>{statusLabel[status]}</span>}
      {compact && <span className="sr-only">{statusLabel[status]}</span>}
    </span>
  );
}

export function Avatar({ member, size = 'medium' }: { member: WorkspaceMember; size?: 'small' | 'medium' | 'large' }): React.JSX.Element {
  const initials = member.name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <AvatarPrimitive.Root className={clsx('avatar', `avatar-${size}`)} title={member.name}>
      {member.avatarUrl && <AvatarPrimitive.Image alt="" className="avatar-image" src={member.avatarUrl} />}
      <AvatarPrimitive.Fallback className="avatar-fallback" delayMs={200}>
        {initials || '?'}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

export function AvatarStack({ members, limit = 4 }: { members: WorkspaceMember[]; limit?: number }): React.JSX.Element {
  const visible = members.slice(0, limit);
  const overflow = members.length - visible.length;
  return (
    <span aria-label={members.map((member) => member.name).join(', ')} className="avatar-stack">
      {visible.map((member) => (
        <Avatar key={member.id} member={member} size="small" />
      ))}
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

interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ open, onOpenChange, title, description, children, footer }: ModalProps): React.JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
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
          <div className="dialog-body">{children}</div>
          {footer && <footer className="dialog-footer">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }): React.JSX.Element {
  return (
    <div aria-live="polite" className="center-state" role="status">
      <LoaderCircle aria-hidden="true" className="spin" size={18} />
      <span>{label}</span>
    </div>
  );
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
