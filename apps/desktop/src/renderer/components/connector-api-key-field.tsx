import { ConnectorApiKeyGuidanceCatalog, connectorApiKeyMismatch, type ConnectorApiKeyProvider } from '@rally/contracts';
import { useState, type ReactNode } from 'react';
import { Button, ErrorNotice } from './primitives';
import { desktopBridge } from '../lib/platform';

/**
 * The one API key step, as one control.
 *
 * Connecting an API-key connector is meant to be a paste and nothing else, and
 * three modals each built that step by hand: their own link to a documentation
 * page, their own input, and — in Granola's case — a regex inline in a disabled
 * button that told the person nothing about why it was dead. This is that step
 * once: the link goes to the page that issues the key, the field carries the
 * documented shape as its placeholder, and a paste that cannot be a key for
 * this provider says so under the field instead of silently refusing to submit.
 *
 * What a key looks like and where it comes from is declared per provider in
 * `@rally/contracts`, beside the pattern the API and the adapter check, so a
 * provider that documents no format simply gets no check here.
 */
export function ConnectorApiKeyIssuingLink({ provider, variant = 'link' }: { provider: ConnectorApiKeyProvider; variant?: 'link' | 'button' }): React.JSX.Element {
  const { issuingUrl, issuingLabel } = ConnectorApiKeyGuidanceCatalog[provider];
  const open = () => void desktopBridge().openExternal(issuingUrl);
  if (variant === 'button') return <Button onClick={open}>{issuingLabel} ↗</Button>;
  return (
    <button className="connector-key-guide-link" onClick={open} type="button">
      {issuingLabel} ↗
    </button>
  );
}

export function ConnectorApiKeyField({ provider, value, onChange, disabled = false, label, id, inputClassName, inputLabel, help, autoFocus = false }: {
  provider: ConnectorApiKeyProvider;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label: ReactNode;
  id?: string;
  inputClassName?: string;
  inputLabel: string;
  help?: ReactNode;
  autoFocus?: boolean;
}): React.JSX.Element {
  // A half-typed key is not a wrong key. `connectorApiKeyMismatch` already
  // carves out the empty field for that reason, and somebody typing `g`, `gr`,
  // `grn` is the same person: a message saying Granola keys start with `grn_`
  // is untrue of what they have typed so far, and it would be on screen, in an
  // alert, from the first character to the last. So the verdict waits for a
  // moment when the value could be finished — a paste, which is the case this
  // step is built for and arrives as one event, or leaving the field. Once
  // shown it stays live, so correcting the key clears it as it is corrected,
  // and emptying the field starts the person over.
  const [settled, setSettled] = useState(false);
  const format = ConnectorApiKeyGuidanceCatalog[provider].format;
  const mismatch = settled ? connectorApiKeyMismatch(provider, value) : null;
  return (
    <>
      <label className="form-field" htmlFor={id}>
        <span>{label}</span>
        <input
          aria-label={inputLabel}
          autoComplete="off"
          autoFocus={autoFocus}
          className={inputClassName}
          disabled={disabled}
          id={id}
          onBlur={() => setSettled(true)}
          onChange={(event) => {
            if (!event.currentTarget.value.trim()) setSettled(false);
            onChange(event.currentTarget.value);
          }}
          onPaste={() => setSettled(true)}
          {...(format ? { placeholder: format.placeholder } : {})}
          spellCheck={false}
          type="password"
          value={value}
        />
        {help && <small>{help}</small>}
      </label>
      {mismatch && <ErrorNotice>{mismatch}</ErrorNotice>}
    </>
  );
}
