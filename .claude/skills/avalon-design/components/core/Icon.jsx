import React from 'react';

const CDN = 'https://unpkg.com/lucide-static@0.544.0/icons/';

/** Lucide glyph rendered as a mask so it inherits currentColor, matching the
 * product's lucide-react usage without an npm dependency. */
export function Icon({ name, size = 16, className, style, title }) {
  const url = `url("${CDN}${name}.svg")`;
  return (
    <span
      aria-hidden={title ? undefined : 'true'}
      aria-label={title}
      className={className}
      role={title ? 'img' : undefined}
      style={{
        background: 'currentColor',
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
