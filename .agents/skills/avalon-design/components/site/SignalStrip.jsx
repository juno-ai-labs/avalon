import React from 'react';

/** Full-bleed lime band of monospace product claims, separated by dots. */
export function SignalStrip({ items = [], className }) {
  return (
    <div className={className} style={{ background: 'var(--brand-primary)', color: '#0b0d0b', overflow: 'hidden' }}>
      <div style={{ alignItems: 'center', display: 'flex', gap: '2rem', justifyContent: 'center', minHeight: 47, paddingInline: '1rem', whiteSpace: 'nowrap' }}>
        {items.map((item, index) => (
          <React.Fragment key={item}>
            {index > 0 && <i style={{ background: '#0b0d0b', borderRadius: 999, height: 4, opacity: 0.45, width: 4 }} />}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{item}</span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
