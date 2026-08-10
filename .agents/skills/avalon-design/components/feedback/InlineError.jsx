import React from 'react';

/** Muted red inline error. Boxed variant is used inside the composer. */
export function InlineError({ children, boxed = false, className }) {
  return (
    <p
      className={className}
      role="alert"
      style={{
        background: boxed ? '#3a2422' : 'transparent',
        border: boxed ? '1px solid #5b302d' : 0,
        borderRadius: boxed ? 'var(--radius-sm)' : 0,
        color: '#e69a94',
        fontSize: 'var(--text-12)',
        margin: boxed ? 0 : '8px 0 0',
        padding: boxed ? '6px 8px' : 0,
      }}
    >
      {children}
    </p>
  );
}
