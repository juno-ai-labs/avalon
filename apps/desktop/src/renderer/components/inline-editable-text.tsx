import { useRef, useState } from 'react';

import { ErrorNotice } from './primitives';
import { isComposingKeyEvent } from '../lib/ime';

/**
 * A value shown as text that turns into a field on double-click, or on Enter
 * or Space while focused.
 *
 * Enter saves and Escape cancels; leaving the field also cancels, so only an
 * explicit Enter writes. A draft `validate` refuses stays open with its reason.
 * The saved value shows at once while `onSave` runs and falls back to `value`
 * if it rejects; the caller owns the error message. A blank or unchanged value
 * saves nothing, and it cannot be edited again until the save settles.
 */
export function InlineEditableText({
  ariaLabel,
  disabled = false,
  onSave,
  validate,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  onSave: (next: string) => Promise<unknown>;
  /** The reason a trimmed draft cannot be saved, or null when it can. */
  validate?: (next: string) => string | null;
  value: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<{ reason: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  // Set by Enter and Escape, not by blur: a keyboard user keeps their place,
  // while a click elsewhere keeps the focus it moved to.
  const returnFocus = useRef(false);
  const shown = saving ?? value;

  const open = (): void => {
    setDraft(shown);
    setInvalid(null);
  };

  const close = (refocus: boolean): void => {
    returnFocus.current = refocus;
    setDraft(null);
    setInvalid(null);
  };

  const commit = (): void => {
    const next = draft?.trim() ?? '';
    if (!next || next === value) {
      close(true);
      return;
    }
    const reason = validate?.(next) ?? null;
    if (reason) {
      setInvalid({ reason });
      return;
    }
    close(true);
    setSaving(next);
    onSave(next).catch(() => undefined).finally(() => setSaving(null));
  };

  const focusOnReturn = (element: HTMLElement | null): void => {
    if (!element || !returnFocus.current) return;
    returnFocus.current = false;
    element.focus();
  };

  if (draft !== null) {
    return (
      <span className="inline-editable-field">
        <input
          aria-invalid={invalid ? true : undefined}
          aria-label={ariaLabel}
          autoFocus
          className="inline-editable-input"
          onBlur={(event) => {
            if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('[role="alertdialog"]'))) close(false);
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(null);
          }}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            // Enter and Escape belong to an IME composition while one is open.
            if (isComposingKeyEvent(event.nativeEvent)) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape') {
              // A prevented Escape is one the Settings window will not close on.
              event.preventDefault();
              close(true);
            }
          }}
          value={draft}
        />
        {invalid && <ErrorNotice occurrence={invalid}>{invalid.reason}</ErrorNotice>}
      </span>
    );
  }

  if (disabled) return <strong>{shown}</strong>;

  // Locked while a save is in flight, so two saves never race to be last. It
  // stays the same element, so focus returned to it survives the save.
  if (saving !== null) {
    return <strong aria-busy="true" className="inline-editable-text" ref={focusOnReturn} tabIndex={-1}>{shown}</strong>;
  }

  return (
    <strong
      aria-label={`${ariaLabel}: ${shown}. Double-click or press Enter to edit.`}
      className="inline-editable-text"
      onDoubleClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
      ref={focusOnReturn}
      role="button"
      tabIndex={0}
      title="Double-click to edit"
    >
      {shown}
    </strong>
  );
}
