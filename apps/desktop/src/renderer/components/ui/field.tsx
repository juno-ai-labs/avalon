import { createContext, useContext, useId, type HTMLAttributes, type LabelHTMLAttributes, type ReactNode } from 'react';

import { cn } from './cn';

/**
 * The id the label points at and the error is announced through.
 *
 * Every form in the renderer wires this by hand, and most of them wire only
 * half of it: a `<label>` wrapping its input needs no `htmlFor`, so the pattern
 * spread, and then the description and the error below it had nothing tying
 * them to the control at all. A screen reader read the label and stopped.
 * `Field` mints one id and hands it to all four parts.
 */
interface FieldContext {
  controlId: string;
  describedBy: string;
}

const FieldContext = createContext<FieldContext | null>(null);

function useField(part: string): FieldContext {
  const context = useContext(FieldContext);
  if (!context) throw new Error(`<${part}> must be inside a <Field>.`);
  return context;
}

/** The props a `Field` hands its control. Spread them onto the input. */
export function useFieldControl(): { id: string; 'aria-describedby': string } {
  const { controlId, describedBy } = useField('field control');
  return { id: controlId, 'aria-describedby': describedBy };
}

export function Field({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  const id = useId();
  return (
    <FieldContext.Provider value={{ controlId: `${id}-control`, describedBy: `${id}-described` }}>
      <div className={cn('grid gap-1.5', className)}>{children}</div>
    </FieldContext.Provider>
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  const { controlId } = useField('Label');
  return <label className={cn('text-[10.5px] text-ink-muted', className)} htmlFor={controlId} {...props} />;
}

export function Description({ className, ...props }: HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  const { describedBy } = useField('Description');
  return <p className={cn('m-0 text-[10px] leading-[1.45] text-ink-muted', className)} id={describedBy} {...props} />;
}

/**
 * `role="alert"` rather than a live region on the field: the message appears in
 * response to a submit the person just made, so it is worth interrupting for.
 */
export function ErrorMessage({ className, ...props }: HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  const { describedBy } = useField('ErrorMessage');
  return (
    <p className={cn('m-0 text-[12px] text-danger-soft', className)} id={describedBy} role="alert" {...props} />
  );
}

/** A group of fields under one legend. */
export function Fieldset({
  legend,
  children,
  className,
}: {
  legend: string;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <fieldset className={cn('m-0 grid gap-4 border-0 p-0', className)}>
      <legend className="p-0 text-[11.5px] font-strong text-ink">{legend}</legend>
      {children}
    </fieldset>
  );
}
