import React from 'react';

/** Marketing-page button: pill-ish (radius scales from --radius-site), 48px tall,
 * lifts 2px on hover. Primary is brand lime on near-black. */
export function SiteButton({ variant = 'primary', href = '#', icon, children, arrow = '↘', className }) {
  const [hover, setHover] = React.useState(false);
  const styles = {
    primary: { background: hover ? 'var(--brand-primary-hover, #e2ef1e)' : 'var(--brand-primary)', borderColor: hover ? 'var(--brand-primary-hover, #e2ef1e)' : 'var(--brand-primary)', color: '#0b0d0b' },
    quiet: { backdropFilter: 'blur(10px)', background: hover ? 'rgba(240,239,232,.1)' : 'rgba(12,14,12,.35)', borderColor: hover ? 'rgba(240,239,232,.28)' : 'var(--line)', color: hover ? 'var(--ink)' : 'rgba(240,239,232,.72)' },
  };
  return (
    <a
      className={className}
      href={href}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        alignItems: 'center',
        border: '1px solid var(--line)',
        borderRadius: 'calc(var(--radius-site) * .72)',
        display: 'inline-flex',
        fontSize: 'var(--text-12)',
        fontWeight: 600,
        gap: '10px',
        justifyContent: 'center',
        minHeight: 48,
        padding: '11px 16px',
        textDecoration: 'none',
        transform: hover ? 'translateY(-2px)' : 'none',
        transition: 'background 180ms ease, border-color 180ms ease, color 180ms ease, transform 180ms ease',
        ...styles[variant],
      }}
    >
      {icon}
      {children}
      {arrow && <span style={{ marginLeft: 12, transform: hover ? 'translate(2px, 2px)' : 'none', transition: 'transform 180ms ease' }}>{arrow}</span>}
    </a>
  );
}
