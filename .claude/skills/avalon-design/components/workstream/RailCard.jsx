import React from 'react';

import { Icon } from '../core/Icon.jsx';
import { ToggleSwitch } from '../forms/ToggleSwitch.jsx';

/** A resource, connection, or background task in the right context rail. */
export function RailCard({ title, meta, icon = 'file', trailing, watchable = false, watched = false, onWatchChange, className }) {
  const [hover, setHover] = React.useState(false);
  return (
    <li className={className} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ background: 'var(--raised)', border: '1px solid ' + (hover ? '#40413b' : 'transparent'), borderRadius: 'var(--radius-control)', listStyle: 'none', overflow: 'hidden' }}>
      <div style={{ alignItems: 'center', display: 'grid', gap: '8px', gridTemplateColumns: '27px minmax(0,1fr) auto', minHeight: 48, padding: '7px 8px' }}>
        <span style={{ alignItems: 'center', background: '#383933', borderRadius: 'var(--radius-sm)', color: '#aaa9a2', display: 'flex', height: 27, justifyContent: 'center', width: 27 }}><Icon name={icon} size={14} /></span>
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <strong style={{ color: '#c5c4bd', fontSize: '10.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</strong>
          {meta && <small style={{ color: '#77766f', fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta}</small>}
        </span>
        {trailing}
      </div>
      {watchable && (
        <div style={{ borderTop: '1px solid #343530', padding: '4px 8px 4px 43px' }}>
          <ToggleSwitch checked={watched} label="Watch for changes" onChange={onWatchChange} />
        </div>
      )}
    </li>
  );
}
