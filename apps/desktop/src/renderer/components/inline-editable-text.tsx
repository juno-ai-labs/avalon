import { useState } from 'react';

import { isComposingKeyEvent } from '../lib/ime';

/**
 * A value shown as text that turns into a field on double-click.
 *
 * Enter saves and Escape cancels; leaving the field also cancels, so only an
 * explicit Enter writes. The saved value shows at once while `onSave` runs and
 * falls back to `value` if it rejects; the caller owns the error message. A
 * blank or unchanged value saves nothing.
 */
export function InlineEditableText({
  ariaLabel,
  disabled = false,
  onSave,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  onSave: (next: string) => Promise<unknown>;
  value: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const shown = saving ?? value;

  const commit = (): void => {
    const next = draft?.trim() ?? '';
    setDraft(null);
    if (!next || next === value) return;
    setSaving(next);
    onSave(next).catch(() => undefined).finally(() => setSaving(null));
  };

  if (draft !== null) {
    return (
      <input
        aria-label={ariaLabel}
        autoFocus
        className="inline-editable-input"
        onBlur={() => setDraft(null)}
        onChange={(event) => setDraft(event.target.value)}
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
            setDraft(null);
          }
        }}
        value={draft}
      />
    );
  }

  if (disabled) return <strong>{shown}</strong>;

  return (
    <strong
      aria-label={`${ariaLabel}: ${shown}. Double-click or press Enter to edit.`}
      className="inline-editable-text"
      onDoubleClick={() => setDraft(shown)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          setDraft(shown);
        }
      }}
      role="button"
      tabIndex={0}
      title="Double-click to edit"
    >
      {shown}
    </strong>
  );
}
