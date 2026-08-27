import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

import { cn } from './cn';

/**
 * One field, where there were four.
 *
 * `.granola-key-input`, `.rename-workstream-field input`, `.form-field
 * textarea` and `.elicitation-other-option input` each wrote their own sunken
 * fill, their own border step and their own padding — 9/10, 10, 10/11 — and no
 * two of them focused the same way. None of that was a decision; it is what
 * happens when the fourth field is written by copying the third.
 */
const field = cn(
  'w-full rounded-sm border border-line-strong bg-surface-sunken text-ink outline-0',
  'placeholder:text-ink-disabled',
  'focus:border-line-focus focus:shadow-focus-quiet',
  'disabled:cursor-not-allowed disabled:opacity-[0.48]',
);

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, ...props }, ref) {
  return <input className={cn(field, 'px-[10px] py-[9px]', className)} ref={ref} {...props} />;
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea className={cn(field, 'resize-y p-[10px] leading-[1.5]', className)} ref={ref} {...props} />;
});
