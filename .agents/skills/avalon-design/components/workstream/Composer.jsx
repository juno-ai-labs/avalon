import React from 'react';

import { Icon } from '../core/Icon.jsx';
import { IconButton } from '../core/IconButton.jsx';

/** The bottom composer. One rounded field, tools on the left, send on the right;
 * the send button is ink-on-dark, not brand lime. */
export function Composer({ value, onChange, onSend, placeholder = 'Ask Avalon or update the work stream', hint, busy = false, className }) {
  const [focused, setFocused] = React.useState(false);
  return (
    <div className={className} style={{ background: '#262722', border: '1px solid ' + (focused ? '#5a5b54' : '#41423b'), borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-composer)', overflow: 'hidden' }}>
      <textarea
        onBlur={() => setFocused(false)}
        onChange={onChange}
        onFocus={() => setFocused(true)}
        placeholder={placeholder}
        readOnly={!onChange}
        style={{ background: 'transparent', border: 0, color: 'var(--ink)', display: 'block', fontFamily: 'inherit', fontSize: 'var(--text-14)', lineHeight: 1.5, minHeight: 51, outline: 0, padding: '13px 14px 4px', resize: 'none', width: '100%' }}
        value={value}
      />
      <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', minHeight: 38, padding: '2px 7px 6px' }}>
        <span style={{ alignItems: 'center', display: 'flex', gap: '5px' }}>
          <IconButton label="Attach a file" size={27}><Icon name="paperclip" size={15} /></IconButton>
          <IconButton label="Add a resource" size={27}><Icon name="link" size={15} /></IconButton>
          <IconButton label="Dictate" size={27}><Icon name="mic" size={15} /></IconButton>
        </span>
        {hint && <span style={{ color: 'var(--muted)', flex: 1, fontSize: 'var(--text-10)', margin: '0 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hint}</span>}
        <button
          aria-label={busy ? 'Stop' : 'Send'}
          onClick={onSend}
          style={{ alignItems: 'center', background: 'var(--ink)', border: 0, borderRadius: 'var(--radius-control)', color: '#171815', cursor: 'pointer', display: 'flex', height: 28, justifyContent: 'center', width: 28 }}
          type="button"
        >
          <Icon name={busy ? 'square' : 'arrow-up'} size={15} />
        </button>
      </div>
    </div>
  );
}
