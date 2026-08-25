import type { ButtonHTMLAttributes, LabelHTMLAttributes, PropsWithChildren, ReactNode } from 'react';

export function Button({ variant = 'secondary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet';
}): React.JSX.Element {
  return <button {...props} className={`ace-button ace-button-${variant}${props.className ? ` ${props.className}` : ''}`} />;
}

export function SegmentedControl<T extends string>({ options, value, onChange, large = false }: {
  options: readonly T[]; value: T; onChange: (value: T) => void; large?: boolean;
}): React.JSX.Element {
  return <div aria-label="Choose a value" className={`segmented${large ? ' large' : ''}`} role="group">
    {options.map((option) => <button aria-pressed={value === option} className={value === option ? 'selected' : ''} key={option} onClick={() => onChange(option)} type="button">{option[0]?.toUpperCase()}{option.slice(1)}</button>)}
  </div>;
}

export function Field({ label, children, className = '', ...props }: PropsWithChildren<LabelHTMLAttributes<HTMLLabelElement> & {
  label: string; className?: string;
}>): React.JSX.Element {
  return <label {...props} className={className}><span>{label}</span>{children}</label>;
}

export function Panel({ children, className = '' }: PropsWithChildren<{ className?: string }>): React.JSX.Element {
  return <article className={`ace-panel${className ? ` ${className}` : ''}`}>{children}</article>;
}

export function StatusDot({ active, label }: { active: boolean; label: string }): React.JSX.Element {
  return <span aria-label={label} className={`status-dot${active ? ' on' : ''}`} role="img" />;
}

export function EmptyState({ title, description }: { title: string; description: ReactNode }): React.JSX.Element {
  return <div className="empty-rules"><strong>{title}</strong><span>{description}</span></div>;
}
