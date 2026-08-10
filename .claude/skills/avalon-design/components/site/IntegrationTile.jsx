import React from 'react';

/** One connection in the integrations grid. The ↗ is always lime. */
export function IntegrationTile({ name, href, className }) {
  const [hover, setHover] = React.useState(false);
  const Tag = href ? 'a' : 'span';
  return (
    <Tag
      className={className}
      href={href}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        alignItems: 'center',
        background: 'var(--surface)',
        border: '1px solid ' + (hover ? 'rgba(206,220,0,.36)' : 'rgba(240,239,232,.08)'),
        borderRadius: 'calc(var(--radius-site) * .65)',
        color: 'var(--ink-soft)',
        display: 'flex',
        fontSize: 'var(--text-11)',
        justifyContent: 'space-between',
        minHeight: 62,
        padding: '13px 15px',
        textDecoration: 'none',
        transform: hover ? 'translateY(-2px)' : 'none',
        transition: 'border-color 180ms ease, transform 180ms ease',
      }}
    >
      {name}
      <span style={{ color: 'var(--brand-primary)', fontSize: 'var(--text-10)' }}>↗</span>
    </Tag>
  );
}
