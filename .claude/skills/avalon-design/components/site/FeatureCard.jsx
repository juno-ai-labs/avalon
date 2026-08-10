import React from 'react';

/** Marketing feature tile: faint diagonal wash, hairline border that turns lime
 * on hover, and a 4px lift. Content sits at the top; a visual sits at the bottom. */
export function FeatureCard({ label, title, children, visual, wide = false, className }) {
  const [hover, setHover] = React.useState(false);
  return (
    <article
      className={className}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: 'linear-gradient(145deg, rgba(240,239,232,.045), rgba(240,239,232,.012))',
        border: '1px solid ' + (hover ? 'rgba(206,220,0,.36)' : 'rgba(240,239,232,.08)'),
        borderRadius: 'var(--radius-site)',
        gridColumn: wide ? 'span 2' : 'auto',
        minHeight: 340,
        overflow: 'hidden',
        padding: 'clamp(1.5rem, 3vw, 2.4rem)',
        position: 'relative',
        transform: hover ? 'translateY(-4px)' : 'none',
        transition: 'border-color 220ms ease, transform 220ms ease',
      }}
    >
      <span style={{ color: 'var(--brand-primary)', fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</span>
      <h3 style={{ fontSize: 'var(--display-card)', fontWeight: 500, letterSpacing: '-0.045em', lineHeight: 1.05, margin: '2rem 0 1rem' }}>{title}</h3>
      <p style={{ color: 'var(--muted)', fontSize: 'var(--text-12)', lineHeight: 1.7, margin: 0, maxWidth: 500 }}>{children}</p>
      {visual}
    </article>
  );
}
