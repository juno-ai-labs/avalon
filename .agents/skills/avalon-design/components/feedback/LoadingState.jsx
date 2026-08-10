import React from 'react';

/** Centred loading row: a pulsing Avalon mark or a spinning ring, plus a label. */
export function LoadingState({ label = 'Loading…', mark = false, className }) {
  return (
    <div aria-live="polite" className={className} role="status" style={{ alignItems: 'center', color: 'var(--muted)', display: 'flex', fontSize: 'var(--text-13)', gap: '8px', justifyContent: 'center', padding: '24px' }}>
      {mark ? (
        <span style={{ animation: 'avalon-active-pulse 1.35s ease-in-out infinite', background: 'var(--brand-primary)', display: 'inline-block', height: 20, WebkitMask: 'url("/assets/brand/avalon-mark.png") center / contain no-repeat', mask: 'url("/assets/brand/avalon-mark.png") center / contain no-repeat', width: 20 }} />
      ) : (
        <span style={{ animation: 'avalon-spin 0.8s linear infinite', border: '2px solid #45463f', borderRadius: 999, borderTopColor: 'var(--ink-soft)', display: 'inline-block', height: 16, width: 16 }} />
      )}
      <span>{label}</span>
    </div>
  );
}
