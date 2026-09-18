import { ConnectorApiKeyGuidanceCatalog, connectorApiKeyMismatch, type ConnectorInstallationProvider } from '@rally/contracts';
import type { ReactNode } from 'react';
import { Button, InlineError } from './primitives';
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
export function ConnectorApiKeyIssuingLink({ provider, variant = 'link' }: { provider: ConnectorInstallationProvider; variant?: 'link' | 'button' }): React.JSX.Element {
  const { issuingUrl, issuingLabel } = ConnectorApiKeyGuidanceCatalog[provider];
  const open = () => void desktopBridge().openExternal(issuingUrl);
  if (variant === 'button') return <Button onClick={open}>{issuingLabel} ↗</Button>;
  return (
    <button className="granola-key-guide-link" onClick={open} type="button">
      {issuingLabel} ↗
    </button>
  );
}

export function ConnectorApiKeyField({ provider, value, onChange, disabled = false, label, id, inputClassName, inputLabel, help, autoFocus = false }: {
  provider: ConnectorInstallationProvider;
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
  const format = ConnectorApiKeyGuidanceCatalog[provider].format;
  const mismatch = connectorApiKeyMismatch(provider, value);
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
          onChange={(event) => onChange(event.currentTarget.value)}
          {...(format ? { placeholder: format.placeholder } : {})}
          spellCheck={false}
          type="password"
          value={value}
        />
        {help && <small>{help}</small>}
      </label>
      {mismatch && <InlineError>{mismatch}</InlineError>}
    </>
  );
}
