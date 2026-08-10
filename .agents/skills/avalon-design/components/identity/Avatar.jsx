import React from 'react';

const sizes = { small: 24, medium: 30, large: 38 };
const fontSizes = { small: 9, medium: 10, large: 11 };

/** Round member avatar with initials fallback. Avalon itself uses the mark, not an avatar. */
export function Avatar({ name = '', imageUrl, size = 'medium', className, style }) {
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || '?';
  return (
    <span
      className={className}
      style={{
        alignItems: 'center',
        background: '#3a3d3a',
        border: '1px solid #4a4c47',
        borderRadius: 999,
        color: '#e6e5df',
        display: 'inline-flex',
        flex: '0 0 auto',
        fontSize: fontSizes[size],
        fontWeight: 650,
        height: sizes[size],
        justifyContent: 'center',
        overflow: 'hidden',
        verticalAlign: 'middle',
        width: sizes[size],
        ...style,
      }}
      title={name}
    >
      {imageUrl ? <img alt="" src={imageUrl} style={{ height: '100%', objectFit: 'cover', width: '100%' }} /> : initials}
    </span>
  );
}
