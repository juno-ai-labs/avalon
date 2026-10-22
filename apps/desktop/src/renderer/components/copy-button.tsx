import clsx from 'clsx';
import { IconAlertCircle, IconCheck, IconCopy } from '@tabler/icons-react';
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useCopy, type CopyState, type UseCopyOptions } from '../lib/use-copy';
import { Toast } from '@rally/ui/components/toast';
import { ErrorNotice, IconButton } from './primitives';

/** The name the control takes while it is showing an outcome; the caller's label is its idle name. */
const stateLabel: Record<Exclude<CopyState, 'idle'>, string> = {
  copied: 'Copied',
  failed: 'Copy failed — click to retry',
};

/** What the live region says. Empty while idle, so a region that has nothing to say says nothing. */
const stateStatus: Record<CopyState, string> = {
  idle: '',
  copied: 'Copied.',
  failed: 'Copy failed. Try again.',
};

export interface CopyButtonProps extends
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick' | 'value'>,
  UseCopyOptions {
  /** The control's name while idle, e.g. `Copy endpoint`. It is also the tooltip. */
  label: string;
  /** The glyph's size. The box around it is `.icon-button`'s, or whatever a host rule makes it. */
  size?: number;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * The one control that copies a value to the clipboard.
 *
 * An icon alone — the label is its tooltip and its accessible name — so it sits
 * beside the value it copies rather than under it as a sentence. The outcome is
 * shown in the control itself: the glyph becomes a check or an alert, the name
 * says which, and a live region announces it, because after a click the
 * tooltip is closed and the glyph is what a person is looking at. A failed copy
 * keeps the same click as its retry.
 *
 * Every surface that offers to copy something renders this or drives `useCopy`
 * underneath a control of its own; the direct callers of the bridge are only the
 * ones that are menu items.
 */
export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(function CopyButton(
  { className, copyText, label, onCopied, size = 14, tooltipSide, value, ...props },
  ref,
) {
  const { copy, state } = useCopy({ copyText, onCopied, value });
  return (
    <>
      <IconButton
        ref={ref}
        className={clsx('copy-button', state !== 'idle' && `copy-button-${state}`, className)}
        label={copyStateLabel(state, label)}
        onClick={() => void copy()}
        tooltipSide={tooltipSide}
        {...props}
      >
        {state === 'copied'
          ? <IconCheck aria-hidden="true" size={size} stroke={1.9} />
          : state === 'failed'
            ? <IconAlertCircle aria-hidden="true" size={size} stroke={1.9} />
            : <IconCopy aria-hidden="true" size={size} stroke={1.9} />}
      </IconButton>
      <CopyStatus state={state} />
    </>
  );
});

/**
 * The pieces of `CopyButton` for a host that draws the button itself, such as
 * a copy action in a header's `IconGroup`: its name and the live region, which
 * the caller renders once wherever it likes. The glyph is the host's own set.
 */
export function copyStateLabel(state: CopyState, label: string): string {
  return state === 'idle' ? label : stateLabel[state];
}

export function CopyStatus({ state, visible = false }: { state: CopyState; visible?: boolean }): React.JSX.Element {
  if (!visible) return <span aria-live="polite" className="sr-only" role="status">{stateStatus[state]}</span>;
  return <>
    <Toast icon={<IconCheck aria-hidden="true" size={16} stroke={1.9} />} open={state === 'copied'}>{stateStatus.copied}</Toast>
    {state === 'failed' && <ErrorNotice>{stateStatus.failed}</ErrorNotice>}
  </>;
}

/**
 * A value shown to be copied rather than read: a caption, the value in a
 * read-only field, and the copy control beside it.
 *
 * The field exists because a connection URL is longer than the box and a
 * secret is deliberately the one thing nobody should retype — the control is
 * how the value leaves the screen. A secret is masked: it cannot be read back
 * off the screen, so the control is its only way out, and a failed copy is
 * shown in the control for that reason.
 */
export function CopyField({ copyLabel, inputLabel, label, secret = false, value }: {
  /** The copy control's name, e.g. `Copy endpoint`. */
  copyLabel: string;
  /** The field's accessible name where the caption alone is ambiguous, e.g. `Fireflies endpoint URL`. */
  inputLabel?: string;
  /** The caption over the field. */
  label: ReactNode;
  /** Masks the value. */
  secret?: boolean;
  value: string;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className="form-field copy-field">
      <label htmlFor={id}>{label}</label>
      <input
        aria-label={inputLabel}
        id={id}
        readOnly
        spellCheck={false}
        type={secret ? 'password' : undefined}
        value={value}
      />
      <CopyButton label={copyLabel} value={value} />
    </div>
  );
}
