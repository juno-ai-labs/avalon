import React from 'react';

import { Icon } from '../core/Icon.jsx';

/** Selectable card used for region choice and agent elicitation options.
 * Selection is signalled by a lime-tinted fill and border, never by a filled radio. */
export function OptionCard({ title, description, icon, selected = false, onSelect, shortcut, control = 'check', className }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      aria-pressed={selected}
      className={className}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        alignItems: 'center',
        background: selected ? 'color-mix(in srgb, var(--brand-primary) 8%, #41423f)' : hover ? 'color-mix(in srgb, var(--brand-primary) 7%, #373835)' : '#30312e',
        border: '1px solid ' + (selected ? 'color-mix(in srgb, var(--brand-primary) 32%, #4b4c48)' : hover ? 'color-mix(in srgb, var(--brand-primary) 28%, transparent)' : 'transparent'),
        borderRadius: 'var(--radius-lg)',
        cursor: 'pointer',
        display: 'grid',
        gap: '12px',
        gridTemplateColumns: icon ? 'auto minmax(0,1fr) auto' : 'minmax(0,1fr) auto',
        minHeight: 61,
        padding: '9px 12px',
        textAlign: 'left',
        transition: 'background-color 120ms ease, border-color 120ms ease',
        width: '100%',
      }}
      type="button"
    >
      {icon && <span style={{ alignItems: 'center', background: '#2a2b27', border: '1px solid #393a35', borderRadius: 'var(--radius-control)', color: 'var(--ink-soft)', display: 'flex', height: 37, justifyContent: 'center', width: 37 }}>{icon}</span>}
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <strong style={{ color: '#f2f1ed', fontSize: '13.5px', fontWeight: 520, lineHeight: 1.35 }}>{title}</strong>
        {description && <small style={{ color: '#9d9c97', fontSize: 'var(--text-12)', lineHeight: 1.42, marginTop: 3 }}>{description}</small>}
      </span>
      <span style={{ alignItems: 'center', display: 'flex', gap: '10px' }}>
        {shortcut && <kbd style={{ color: '#a5a49f', fontFamily: 'inherit', fontSize: 'var(--text-12)' }}>{shortcut}</kbd>}
        {control === 'check' && (
          <span style={{ alignItems: 'center', background: selected ? 'var(--brand-primary)' : 'transparent', border: '1px solid ' + (selected || hover ? 'var(--brand-primary)' : '#6e6f6b'), borderRadius: 'var(--radius-xs)', color: '#111210', display: 'flex', height: 16, justifyContent: 'center', width: 16 }}>
            {selected && <Icon name="check" size={12} />}
          </span>
        )}
      </span>
    </button>
  );
}
