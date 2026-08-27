import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactNode, RefObject } from 'react';

import { cn } from './cn';
import { Icon } from './icon';
import { IconButton } from './icon-button';
import { isComposingKeyEvent } from '../../lib/ime';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
}

/**
 * The whole dialog, not a set of parts.
 *
 * Radix hands out `Root`/`Portal`/`Overlay`/`Content`/`Title`/`Close` and every
 * caller assembles the same eight of them. Two things in that assembly are not
 * optional and both are easy to leave out: a `Title`, without which the dialog
 * is announced as an unnamed group, and the composition guard below.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  initialFocusRef,
  className,
}: DialogProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-scrim animate-[fade-in_130ms_ease-out]" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[101] w-[500px] min-w-[420px] -translate-x-1/2 -translate-y-1/2',
            // Under 560px the frame gives up its floor and takes the window,
            // which is what `app.css`'s media query did for `.dialog-content`.
            'max-[560px]:w-[calc(100vw-24px)] max-[560px]:min-w-0',
            'max-h-[min(720px,calc(100vh-48px))] max-w-[calc(100vw-32px)] overflow-hidden',
            'rounded-xl border border-line-hover bg-surface-subtle shadow-lg',
            'animate-[dialog-in_150ms_ease-out]',
            className,
          )}
          /* Escape belongs to the IME while it is composing: it abandons the
             candidate, and Radix must not read the same keystroke as a request
             to close the dialog and take the typed draft with it. Radix calls
             this before dismissing and skips the dismissal when the event is
             defaultPrevented. A native KeyboardEvent, so no `nativeEvent`. */
          onEscapeKeyDown={(event) => {
            if (isComposingKeyEvent(event)) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            const initialFocus = initialFocusRef?.current;
            if (!initialFocus) return;
            event.preventDefault();
            initialFocus.focus();
          }}
        >
          <header className="flex items-start justify-between border-b border-b-hairline border-line px-[18px] pb-3.5 pt-[17px]">
            <div>
              <DialogPrimitive.Title className="m-0 text-[15px] font-strong text-ink">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mb-0 ml-0 mr-6 mt-1 text-[12px] text-ink-muted">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton label="Close dialog">
                <Icon name="close" size="md" />
              </IconButton>
            </DialogPrimitive.Close>
          </header>
          {children != null && (
            <div className="max-h-[520px] overflow-auto px-[calc(var(--av-sys-space-pane-padding)_-_2px)] py-[calc(var(--av-sys-space-pane-padding)_-_4px)]">
              {children}
            </div>
          )}
          {footer && (
            <footer className="flex items-center justify-end gap-2 border-t border-t-hairline border-line px-[18px] py-3">
              {footer}
            </footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
