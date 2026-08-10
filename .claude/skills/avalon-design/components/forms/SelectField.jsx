import React from 'react';

import { Icon } from '../core/Icon.jsx';

/** Settings dropdown. `primary` is bordered; `secondary` is text-only for dense preference rows. */
export function SelectField({ options = [], value, onChange, variant = 'primary', ariaLabel, className }) {
  const bordered = variant === 'primary';
  return (
    <span className={className} style={{ alignItems: 'center', background: bordered ? '#242521' : 'transparent', border: '1px solid ' + (bordered ? '#3b3c37' : 'transparent'), borderRadius: 'var(--radius-control)', color: bordered ? 'var(--ink-soft)' : 'var(--muted)', display: 'inline-flex', gap: '8px', minHeight: bordered ? 34 : 26, padding: bordered ? '0 9px 0 11px' : '0 4px', position: 'relative' }}>
      <select
        aria-label={ariaLabel}
        onChange={onChange}
        style={{ appearance: 'none', background: 'transparent', border: 0, color: 'inherit', fontFamily: 'inherit', fontSize: 'var(--text-12)', outline: 0, padding: 0, paddingRight: 18, width: '100%' }}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value} style={{ background: '#292a26' }} value={option.value}>{option.label}</option>
        ))}
      </select>
      <Icon name="chevron-down" size={15} style={{ position: 'absolute', right: bordered ? 8 : 0, pointerEvents: 'none' }} />
    </span>
  );
}
