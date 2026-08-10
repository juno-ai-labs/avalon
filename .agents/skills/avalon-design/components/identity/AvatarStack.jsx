import React from 'react';

import { Avatar } from './Avatar.jsx';

/** Overlapping participant avatars with a +N overflow pill. */
export function AvatarStack({ members = [], limit = 4, className }) {
  const visible = members.slice(0, limit);
  const overflow = members.length - visible.length;
  return (
    <span className={className} style={{ alignItems: 'center', display: 'inline-flex' }}>
      {visible.map((member, index) => (
        <Avatar
          key={member.id ?? member.name ?? index}
          imageUrl={member.avatarUrl}
          name={member.name}
          size="small"
          style={{ border: '2px solid var(--surface)', marginLeft: index === 0 ? 0 : -7 }}
        />
      ))}
      {overflow > 0 && (
        <span style={{ alignItems: 'center', background: '#33342f', border: '2px solid var(--surface)', borderRadius: 999, color: 'var(--muted)', display: 'inline-flex', fontSize: 9, height: 24, justifyContent: 'center', marginLeft: -7, minWidth: 24, padding: '0 4px' }}>+{overflow}</span>
      )}
    </span>
  );
}
