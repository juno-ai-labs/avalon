import React from 'react';

/** Light-on-dark tooltip: the one inverted surface in the product. */
export function Tooltip({ label, side = 'bottom', children, className }) {
  const [open, setOpen] = React.useState(false);
  const offsets = {
    bottom: { left: '50%', top: 'calc(100% + 6px)', transform: 'translateX(-50%)' },
    top: { bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' },
    right: { left: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)' },
    left: { right: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)' },
  };
  return (
    <span className={className} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} style={{ display: 'inline-flex', position: 'relative' }}>
      {children}
      {open && (
        <span style={{ animation: 'avalon-fade-in 100ms ease-out', background: '#e9e8e1', borderRadius: 'var(--radius-sm)', color: '#1c1d1a', fontSize: 'var(--text-12)', padding: '5px 8px', pointerEvents: 'none', position: 'absolute', whiteSpace: 'nowrap', zIndex: 1000, ...offsets[side] }}>{label}</span>
      )}
    </span>
  );
}
