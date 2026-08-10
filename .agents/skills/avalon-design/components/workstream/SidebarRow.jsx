import React from 'react';

import { Icon } from '../core/Icon.jsx';
import { Badge } from '../core/Badge.jsx';

/** One navigation row in the left sidebar: work stream, automation, or note. */
export function SidebarRow({ title, hint, icon = 'circle-dot', active = false, unread = false, scope, onClick, className }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      className={className}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        alignItems: 'center',
        background: active ? '#343530' : hover ? '#22231f' : 'transparent',
        border: 0,
        borderRadius: 'var(--radius-md)',
        color: active || hover ? 'var(--ink)' : '#b7b6af',
        cursor: 'pointer',
        display: 'flex',
        fontSize: '12.5px',
        gap: '5px',
        minHeight: 30,
        minWidth: 0,
        padding: '3px 7px',
        textAlign: 'left',
        width: '100%',
      }}
      type="button"
    >
      <span style={{ alignItems: 'center', color: unread ? 'var(--brand-secondary)' : '#77766f', display: 'flex', flex: '0 0 18px', justifyContent: 'center' }}>
        <Icon name={icon} size={13} />
      </span>
      <span style={{ display: 'flex', flex: 1, flexDirection: 'column', lineHeight: 1.25, minWidth: 0 }}>
        <span style={{ color: unread ? 'var(--ink)' : undefined, fontWeight: unread ? 650 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {hint && <span style={{ alignItems: 'center', color: '#73736c', display: 'flex', fontSize: '10.5px', gap: '3px', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hint}</span>}
      </span>
      {scope && <Badge style={{ flex: '0 0 auto', fontSize: 9, lineHeight: '16px', maxWidth: 68, padding: '0 4px' }}>{scope}</Badge>}
    </button>
  );
}
