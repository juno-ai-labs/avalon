import React from 'react';

/** Uppercase monospace label above a marketing headline. `eyebrow` prefixes a
 * lime index number; `kicker` is the lime section label. */
export function Kicker({ children, index, tone = 'kicker', className }) {
  return (
    <p className={className} style={{ color: tone === 'kicker' ? 'var(--brand-primary)' : 'rgba(240,239,232,.58)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', margin: 0, textTransform: 'uppercase' }}>
      {index && <span style={{ color: 'var(--brand-primary)', marginRight: 12 }}>{index}</span>}
      {children}
    </p>
  );
}
