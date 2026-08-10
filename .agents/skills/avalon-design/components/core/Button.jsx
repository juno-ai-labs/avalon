import React from 'react';

const base = {
  alignItems: 'center',
  borderRadius: 'var(--radius-control)',
  display: 'inline-flex',
  fontFamily: 'inherit',
  gap: '7px',
  justifyContent: 'center',
  lineHeight: 1.2,
  minHeight: 32,
  padding: '5px 11px',
  transition: 'background-color 140ms ease, border-color 140ms ease, color 140ms ease',
  whiteSpace: 'nowrap',
};

const variants = {
  default: { background: 'var(--raised)', border: '1px solid var(--line)', color: 'var(--ink-soft)' },
  primary: { background: 'var(--brand-primary)', border: '1px solid var(--brand-primary)', color: '#111210', fontWeight: 590 },
  secondary: { background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--ink-soft)' },
  quiet: { background: 'transparent', border: '1px solid transparent', color: 'var(--muted)' },
  danger: { background: 'transparent', border: '1px solid var(--line)', color: 'var(--status-red)' },
};

const hovers = {
  default: { background: 'var(--raised-hover)', borderColor: '#41423c', color: 'var(--ink)' },
  primary: { background: 'var(--brand-primary-hover)', borderColor: 'var(--brand-primary-hover)' },
  secondary: { background: 'var(--raised-hover)', borderColor: '#41423c', color: 'var(--ink)' },
  quiet: { color: 'var(--ink)' },
  danger: { background: 'rgba(216,117,111,0.12)', color: '#ef8a83' },
};

/** Desktop-workspace button. 32px min height, 7px radius, no shadow. */
export function Button({ variant = 'default', size = 'medium', icon, children, disabled, className, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const sizing = size === 'small' ? { fontSize: 'var(--text-12)', minHeight: 28, padding: '3px 9px' } : { fontSize: 'var(--text-13)' };
  return (
    <button
      className={className}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...base,
        ...variants[variant],
        ...sizing,
        ...(hover && !disabled ? hovers[variant] : null),
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.48 : 1,
        ...style,
      }}
      type="button"
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
