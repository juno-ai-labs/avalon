import React from 'react';

/** Onboarding / dialog text input: 46px tall, 9px radius, prefix slot for an icon. */
export function TextField({ label, hint, prefix, value, onChange, placeholder, type = 'text', className, ...rest }) {
  const [focused, setFocused] = React.useState(false);
  return (
    <label className={className} style={{ display: 'grid', gap: '7px' }}>
      {label && <span style={{ color: 'var(--muted)', fontSize: '10.5px' }}>{label}</span>}
      <span style={{ alignItems: 'center', background: 'var(--surface-input)', border: '1px solid ' + (focused ? '#77786f' : '#30312c'), borderRadius: 'var(--radius-lg)', boxShadow: focused ? '0 0 0 2px rgba(130,151,172,0.12)' : 'none', color: '#77766f', display: 'flex', gap: '10px', minHeight: 46, padding: '0 13px' }}>
        {prefix}
        <input
          onBlur={() => setFocused(false)}
          onChange={onChange}
          onFocus={() => setFocused(true)}
          placeholder={placeholder}
          style={{ background: 'transparent', border: 0, color: 'var(--ink)', flex: 1, fontFamily: 'inherit', fontSize: 'var(--text-13)', outline: 0, padding: 0 }}
          type={type}
          value={value}
          {...rest}
        />
      </span>
      {hint && <span style={{ color: '#77766f', fontSize: '10.5px', lineHeight: 1.45 }}>{hint}</span>}
    </label>
  );
}
