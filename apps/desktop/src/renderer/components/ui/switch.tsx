import { forwardRef, type InputHTMLAttributes } from 'react';

import { cn } from './cn';

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> {
  /** The accessible name. A switch with no visible label beside it needs one. */
  label?: string;
  className?: string;
}

/**
 * A checkbox wearing a track and a knob.
 *
 * It stays a real `<input type="checkbox">` rather than a `role="switch"` div
 * because the platform already gives it the keyboard, the form value and the
 * label association, and a hand-rolled switch loses at least one of those. The
 * input is visually hidden rather than removed, which is what lets `peer-*`
 * drive the track: the checked state lives in the DOM, not in React state, so
 * an uncontrolled form still submits the right value.
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, className, ...props },
  ref,
) {
  return (
    <label
      className={cn(
        'relative inline-flex cursor-pointer',
        'has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-[0.52]',
        className,
      )}
    >
      {/* `role="switch"` on a checkbox is the ARIA pattern for an on/off
          control: it keeps the platform's keyboard and form value while a
          screen reader announces "on"/"off" rather than "checked". The
          hand-written markup this replaces carried it on some rows and not
          others, which is the sort of thing only a component can fix once. */}
      <input
        className="peer sr-only"
        ref={ref}
        role="switch"
        type="checkbox"
        {...(label ? { 'aria-label': label } : {})}
        {...props}
      />
      <span
        className={cn(
          'h-5 w-[34px] rounded-pill bg-toggle-track transition-[background] duration-150',
          'peer-checked:bg-success-fill peer-focus-visible:shadow-focus-quiet',
          // `after:` is the knob. The shadow is what makes the off state read
          // as a control: a light theme puts a white knob on a grey track,
          // which is barely two to one on its own.
          'after:absolute after:left-[3px] after:top-[3px] after:h-3.5 after:w-3.5 after:rounded-full',
          'after:bg-toggle-knob-off after:shadow-sm after:content-[""]',
          'after:transition-[background,transform] after:duration-150',
          'peer-checked:after:translate-x-3.5 peer-checked:after:bg-success-strong',
        )}
      />
    </label>
  );
});
