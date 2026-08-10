import React from 'react';

import { Avatar } from '../identity/Avatar.jsx';
import { AvalonMark } from '../core/AvalonMark.jsx';

/** One transcript entry. Agent and human messages share the same left-aligned
 * column — Avalon never uses chat bubbles or right-aligned "my messages". */
export function MessageBlock({ author, time, children, agent = false, streaming = false, accent = '#9ec9f5', markSrc, className }) {
  return (
    <article className={className} style={{ margin: '0 0 29px' }}>
      <header style={{ alignItems: 'center', display: 'flex', gap: '8px', marginBottom: 6 }}>
        {agent ? <AvalonMark size={18} src={markSrc} /> : <Avatar name={author} size="small" />}
        <span style={{ color: agent ? 'var(--ink)' : accent, fontSize: 'var(--text-12)', fontWeight: 620 }}>{agent ? 'Avalon' : author}</span>
        {time && <time style={{ color: '#6f6f68', fontSize: '9.5px' }}>{time}</time>}
      </header>
      <div style={{ color: '#dfded9', fontSize: 'var(--text-14)', lineHeight: 1.6, overflowWrap: 'anywhere' }}>
        {children}
        {streaming && <span style={{ animation: 'avalon-active-pulse 0.9s infinite', background: 'var(--brand-primary)', display: 'inline-block', height: 13, marginLeft: 2, verticalAlign: 'text-bottom', width: 2 }} />}
      </div>
    </article>
  );
}
