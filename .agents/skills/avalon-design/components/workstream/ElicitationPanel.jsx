import React from 'react';

import { OptionCard } from '../forms/OptionCard.jsx';
import { Icon } from '../core/Icon.jsx';

/** Structured question from the agent, docked above the composer. The whole
 * point of Avalon: judgment comes back to a person inside the same stream. */
export function ElicitationPanel({ question, options = [], selected, onSelect, onSkip, onSubmit, className }) {
  return (
    <section className={className} style={{ background: '#242522', border: '1px solid #3e3f3b', borderRadius: 'var(--radius-2xl)', boxShadow: 'var(--shadow-panel)', padding: '14px 14px 13px', width: '100%' }}>
      <header style={{ alignItems: 'flex-start', display: 'flex', gap: '14px', justifyContent: 'space-between', minHeight: 34 }}>
        <div style={{ minWidth: 0 }}>
          <small style={{ color: 'var(--brand-primary)', fontSize: 9, fontWeight: 650, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Needs input</small>
          <h3 style={{ color: '#f0efeb', fontSize: 'var(--text-15)', fontWeight: 590, lineHeight: 1.38, margin: '4px 0 0' }}>{question}</h3>
        </div>
        <span style={{ alignItems: 'center', color: '#aaa9a3', display: 'flex', height: 29, justifyContent: 'center', width: 29 }}><Icon name="chevron-down" size={16} /></span>
      </header>
      <div style={{ display: 'grid', gap: '5px', margin: '11px 0 0' }}>
        {options.map((option, index) => (
          <OptionCard
            description={option.description}
            key={option.value ?? index}
            onSelect={() => onSelect && onSelect(option.value ?? index)}
            selected={selected === (option.value ?? index)}
            shortcut={String(index + 1)}
            title={option.title}
          />
        ))}
      </div>
      <div style={{ alignItems: 'center', display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onSkip} style={{ background: '#383936', border: 0, borderRadius: 'var(--radius-control)', color: '#c7c6c1', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'var(--text-12)', minHeight: 33, padding: '0 12px' }} type="button">Skip</button>
        <button onClick={onSubmit} style={{ alignItems: 'center', background: 'var(--brand-primary)', border: 0, borderRadius: 'var(--radius-control)', color: '#111210', cursor: 'pointer', display: 'inline-flex', fontFamily: 'inherit', fontSize: 'var(--text-12)', fontWeight: 590, gap: '7px', minHeight: 33, padding: '0 12px' }} type="button">Send answer<kbd style={{ color: '#777872', fontFamily: 'inherit', fontSize: '10.5px', fontWeight: 500 }}>↵</kbd></button>
      </div>
    </section>
  );
}
