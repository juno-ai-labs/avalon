import React from 'react';

/** Centred empty state for a pane with no content yet. */
export function EmptyState({ title, description, action, className }) {
  return (
    <div className={className} style={{ color: 'var(--muted)', margin: 'auto', maxWidth: 390, padding: '32px 20px', textAlign: 'center' }}>
      <p style={{ color: 'var(--ink-soft)', fontSize: 'var(--text-14)', fontWeight: 570, margin: '0 0 4px' }}>{title}</p>
      <p style={{ fontSize: 'var(--text-13)', margin: '0 0 14px' }}>{description}</p>
      {action}
    </div>
  );
}
