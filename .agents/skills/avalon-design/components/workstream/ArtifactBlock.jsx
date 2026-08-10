import React from 'react';

import { Icon } from '../core/Icon.jsx';

/** A produced output attached to the stream — a document, sheet, or file. */
export function ArtifactBlock({ kind = 'Document', title, description, icon = 'file-text', onClick, className }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      className={className}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ alignItems: 'center', background: hover ? '#2a2b27' : '#252621', border: '1px solid ' + (hover ? '#4a4b44' : '#393a34'), borderRadius: 'var(--radius-7, 8px)', color: 'var(--ink-soft)', cursor: 'pointer', display: 'grid', gap: '10px', gridTemplateColumns: '34px minmax(0,1fr) 18px', padding: 10, textAlign: 'left', width: '100%' }}
      type="button"
    >
      <span style={{ alignItems: 'center', background: '#363731', borderRadius: 'var(--radius-md)', display: 'flex', height: 34, justifyContent: 'center', width: 34 }}><Icon name={icon} size={16} /></span>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <small style={{ color: 'var(--muted)', fontSize: 9, textTransform: 'uppercase' }}>{kind}</small>
        <strong style={{ fontSize: 'var(--text-12)' }}>{title}</strong>
        {description && <p style={{ color: 'var(--muted)', fontSize: '10.5px', margin: '3px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{description}</p>}
      </span>
      <Icon name="chevron-right" size={14} style={{ color: 'var(--muted)' }} />
    </button>
  );
}
