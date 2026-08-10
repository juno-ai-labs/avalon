import React from 'react';

/** The woven Avalon mark. It is an alpha mask, so it always paints in one flat
 * colour (brand lime by default) — never a multi-colour logo. */
export function AvalonMark({ size = 24, color = 'var(--brand-primary)', src = '/assets/brand/avalon-mark.png', className, style }) {
  const url = `url("${src}")`;
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        background: 'currentColor',
        color,
        display: 'inline-block',
        flex: '0 0 auto',
        height: size,
        width: size,
        WebkitMask: `${url} center / contain no-repeat`,
        mask: `${url} center / contain no-repeat`,
        ...style,
      }}
    />
  );
}
