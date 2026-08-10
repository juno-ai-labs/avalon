import React from 'react';

const labels = {
  idle: 'Idle',
  scheduled: 'Scheduled',
  running: 'Running',
  needs_input: 'Needs input',
  completed: 'Completed',
  failed: 'Failed',
};

const dot = {
  idle: { background: 'var(--muted-2)' },
  scheduled: { background: 'transparent', border: '1px solid #696962' },
  running: { animation: 'avalon-active-pulse 1.4s ease-in-out infinite', background: 'var(--brand-secondary)' },
  needs_input: { background: 'var(--status-yellow)' },
  completed: { background: 'var(--status-completed)' },
  failed: { background: 'var(--status-red)' },
};

/** Run status as a 7px dot plus optional text. Running pulses opacity; it never spins. */
export function StatusDot({ status = 'idle', compact = false, label, className }) {
  return (
    <span className={className} style={{ alignItems: 'center', color: 'var(--muted)', display: 'inline-flex', fontSize: 'var(--text-11)', gap: '6px', whiteSpace: 'nowrap' }}>
      <span style={{ borderRadius: 999, boxSizing: 'border-box', display: 'inline-block', height: compact ? 6 : 7, width: compact ? 6 : 7, ...dot[status] }} />
      {!compact && <span>{label ?? labels[status]}</span>}
    </span>
  );
}
