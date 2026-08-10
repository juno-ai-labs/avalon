import React from 'react';

import { Icon } from '../core/Icon.jsx';

const stateColor = { started: 'var(--brand-secondary)', completed: 'var(--status-green)', failed: 'var(--status-red)' };
const stateIcon = { started: 'loader-circle', completed: 'check', failed: 'triangle-alert' };

/** Collapsed record of one agent tool call. Expands to show arguments and result. */
export function ToolBlock({ name, detail, state = 'completed', duration, icon = 'wrench', children, defaultOpen = false, className }) {
  return (
    <details className={className} open={defaultOpen} style={{ background: '#20211e', border: '1px solid var(--line-soft)', borderRadius: 'var(--radius-control)', color: 'var(--muted)', margin: '0 0 16px', overflow: 'hidden' }}>
      <summary style={{ alignItems: 'center', cursor: 'pointer', display: 'grid', gap: '8px', gridTemplateColumns: '22px minmax(0,1fr) auto auto 14px', listStyle: 'none', minHeight: 38, padding: '5px 10px' }}>
        <span style={{ alignItems: 'center', color: '#888881', display: 'flex', justifyContent: 'center' }}><Icon name={icon} size={14} /></span>
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <strong style={{ color: '#bdbcb5', fontSize: 'var(--text-11)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</strong>
          {detail && <small style={{ color: '#77766f', fontSize: '9.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</small>}
        </span>
        <span style={{ alignItems: 'center', color: stateColor[state], display: 'flex' }}><Icon name={stateIcon[state]} size={13} /></span>
        <span style={{ fontSize: '9.5px' }}>{duration}</span>
        <Icon name="chevron-right" size={13} />
      </summary>
      {children && (
        <div style={{ borderTop: '1px solid var(--line)', display: 'grid', gap: '12px', padding: '11px 12px' }}>
          <pre style={{ background: '#171815', borderRadius: 'var(--radius-sm)', color: '#aaa9a2', fontSize: 'var(--text-10)', margin: 0, maxHeight: 220, overflow: 'auto', padding: 9, whiteSpace: 'pre-wrap' }}>{children}</pre>
        </div>
      )}
    </details>
  );
}
