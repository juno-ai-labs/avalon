import React from 'react';

/** Small metadata chip: scope labels, trigger types, counts. */
export function Badge({ children, tone = 'default', className, style }) {
  const tones = {
    default: { background: '#33342f', borderColor: '#3c3d37', color: '#aaa9a2' },
    brand: { background: 'rgba(206,220,0,0.12)', borderColor: 'rgba(206,220,0,0.32)', color: 'var(--brand-primary)' },
    blue: { background: 'rgba(71,199,252,0.12)', borderColor: 'rgba(71,199,252,0.3)', color: 'var(--brand-secondary)' },
  };
  return (
    <span
      className={className}
      style={{
        alignItems: 'center',
        border: '1px solid',
        borderRadius: 'var(--radius-sm)',
        display: 'inline-flex',
        fontSize: '10.5px',
        fontWeight: 520,
        lineHeight: '18px',
        maxWidth: 140,
        overflow: 'hidden',
        padding: '0 6px',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        ...tones[tone],
        ...style,
      }}
    >
      {children}
    </span>
  );
}
