import React from 'react';

import { Icon } from '../core/Icon.jsx';
import { Button } from '../core/Button.jsx';

/** In-stream routing suggestion from connected activity. Yellow-keyed, never red. */
export function SuggestionBlock({ label = 'Suggested', title, reason, actions, resolved = false, resolution, className }) {
  return (
    <section className={className} style={{ background: '#24241f', border: '1px solid ' + (resolved ? 'var(--line)' : '#484434'), borderRadius: 'var(--radius-lg)', margin: '0 0 16px', opacity: resolved ? 0.78 : 1, padding: 14 }}>
      <header style={{ alignItems: 'flex-start', display: 'flex', gap: '10px' }}>
        <span style={{ alignItems: 'center', background: '#3a3423', borderRadius: 'var(--radius-md)', color: 'var(--status-yellow)', display: 'flex', height: 30, justifyContent: 'center', width: 30 }}><Icon name="sparkles" size={15} /></span>
        <div style={{ flex: 1 }}>
          <small style={{ color: 'var(--status-yellow)', fontSize: 9, fontWeight: 650, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{label}</small>
          <h3 style={{ fontSize: 'var(--text-13)', lineHeight: 1.38, margin: '2px 0 0' }}>{title}</h3>
        </div>
      </header>
      {reason && (
        <div style={{ background: '#1c1d1a', borderRadius: 'var(--radius-md)', marginTop: 12, padding: '9px 10px' }}>
          <small style={{ color: 'var(--muted)', fontSize: 9, textTransform: 'uppercase' }}>Why</small>
          <p style={{ color: 'var(--ink-soft)', fontSize: '11.5px', margin: '3px 0 0' }}>{reason}</p>
        </div>
      )}
      {resolved ? (
        <p style={{ alignItems: 'center', color: 'var(--status-green)', display: 'flex', fontSize: '10.5px', gap: '5px', margin: '10px 0 0' }}><Icon name="check" size={12} />{resolution}</p>
      ) : (
        <footer style={{ display: 'flex', gap: '7px', justifyContent: 'flex-end', marginTop: 11 }}>{actions ?? <><Button size="small" variant="quiet">Dismiss</Button><Button size="small" variant="primary">Open work stream</Button></>}</footer>
      )}
    </section>
  );
}
