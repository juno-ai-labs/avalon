import React from 'react';

/** 30×30 transparent square that fills in on hover. Always give it a label —
 * the product renders that label in a tooltip. */
export function IconButton({ label, children, active = false, disabled, size = 30, className, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      aria-label={label}
      className={className}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        alignItems: 'center',
        background: active ? 'color-mix(in srgb, var(--brand-primary) 12%, var(--raised))' : hover && !disabled ? 'var(--raised-hover)' : 'transparent',
        border: '1px solid ' + (hover && !disabled && !active ? '#41423c' : 'transparent'),
        borderRadius: 'var(--radius-control)',
        color: active ? 'var(--brand-primary)' : hover && !disabled ? 'var(--ink)' : 'var(--ink-soft)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'inline-flex',
        height: size,
        justifyContent: 'center',
        opacity: disabled ? 0.48 : 1,
        padding: 0,
        position: 'relative',
        transition: 'background-color 140ms ease, border-color 140ms ease, color 140ms ease',
        width: size,
        ...style,
      }}
      title={label}
      type="button"
      {...rest}
    >
      {children}
    </button>
  );
}
