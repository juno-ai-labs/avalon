import React from 'react';

import { Icon } from '../core/Icon.jsx';

/** Compact 36px search input used in Settings navigation. */
export function SearchField({ value, onChange, placeholder = 'Search', className, ...rest }) {
  const [focused, setFocused] = React.useState(false);
  return (
    <span className={className} style={{ alignItems: 'center', background: '#242521', border: '1px solid ' + (focused ? 'var(--brand-secondary)' : '#3b3c37'), borderRadius: 'var(--radius-control)', boxShadow: focused ? '0 0 0 1px color-mix(in srgb, var(--brand-secondary) 45%, transparent)' : 'none', color: 'var(--muted)', display: 'flex', gap: '8px', height: 36, padding: '0 10px' }}>
      <Icon name="search" size={14} />
      <input
        onBlur={() => setFocused(false)}
        onChange={onChange}
        onFocus={() => setFocused(true)}
        placeholder={placeholder}
        style={{ background: 'transparent', border: 0, color: 'var(--ink)', fontFamily: 'inherit', fontSize: 'var(--text-12)', height: '100%', minWidth: 0, outline: 0, padding: 0, width: '100%' }}
        type="search"
        value={value}
        {...rest}
      />
    </span>
  );
}
