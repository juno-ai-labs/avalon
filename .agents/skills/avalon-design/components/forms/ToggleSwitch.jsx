import React from 'react';

/** 21×12 track toggle used for "watch this resource" style preferences. */
export function ToggleSwitch({ checked = false, onChange, label, disabled = false, className }) {
  return (
    <label className={className} style={{ alignItems: 'center', color: 'var(--muted)', cursor: disabled ? 'not-allowed' : 'pointer', display: 'inline-flex', fontSize: '10.5px', gap: '6px', opacity: disabled ? 0.52 : 1 }}>
      <input checked={checked} disabled={disabled} onChange={onChange} readOnly={!onChange} style={{ opacity: 0, position: 'absolute' }} type="checkbox" />
      <span style={{ background: checked ? 'var(--brand-primary)' : '#4a4b44', borderRadius: 999, height: 12, position: 'relative', transition: 'background 140ms ease', width: 21 }}>
        <span style={{ background: checked ? '#111210' : '#d8d7d2', borderRadius: 999, height: 8, left: checked ? 11 : 2, position: 'absolute', top: 2, transition: 'left 140ms ease', width: 8 }} />
      </span>
      {label}
    </label>
  );
}
