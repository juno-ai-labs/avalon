import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { cn } from './cn';

/**
 * The measurements are `.button`'s, carried over digit for digit.
 *
 * 7, 11 and 5 pixels are not on Tailwind's scale and are not on any scale —
 * they are where the stylesheet arrived. Rounding them to `gap-2 px-3 py-1.5`
 * while swapping the backing would have moved every button in the product
 * inside a change whose whole claim is that nothing moved, and a screenshot
 * diff that is supposed to be empty is worth more here than a tidy number.
 * Normalising the control scale is a real decision and it is the team's; see
 * the open question in `docs/component-library.md`.
 */
const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-[7px] whitespace-nowrap rounded',
    'min-h-control px-[11px] py-[5px]',
    'border border-line bg-surface-raised text-ink-subtle',
    'transition-[background-color,border-color,color] duration-150 ease-out',
    'enabled:hover:border-line-hover enabled:hover:bg-surface-raised-hover enabled:hover:text-ink',
  ),
  {
    variants: {
      variant: {
        /** The ordinary control: a bordered, raised surface. */
        default: '',
        /** One per view at most — the action the screen exists to take. */
        primary: cn(
          'border-brand-base bg-brand-base font-strong text-brand-on',
          'enabled:hover:border-brand-hover enabled:hover:bg-brand-hover enabled:hover:text-brand-on',
        ),
        /** Destructive and irreversible. */
        danger: cn(
          'border-danger-base bg-danger-base font-strong text-danger-on',
          'enabled:hover:border-danger-strong enabled:hover:bg-danger-strong enabled:hover:text-danger-on',
        ),
        /** Present but not competing — a cancel beside a primary. */
        quiet: 'border-transparent bg-transparent text-ink-muted',
        /**
         * Reads as a link rather than a control. No border, no fill, and its
         * own tighter geometry, which is why it overrides the padding above.
         */
        text: cn(
          'min-h-0 gap-[5px] border-transparent bg-transparent p-[3px] text-ink-muted',
          'enabled:hover:border-transparent enabled:hover:bg-transparent enabled:hover:text-ink',
        ),
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;

export const buttonVariantNames = ['default', 'primary', 'danger', 'quiet', 'text'] satisfies ButtonVariant[];

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

/**
 * `type` defaults to `button` because the HTML default is `submit`, and a
 * button inside a form that nobody meant to be a submit button is the oldest
 * bug in this file's history.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, type = 'button', ...props },
  ref,
) {
  return <button className={cn(buttonVariants({ variant }), className)} ref={ref} type={type} {...props} />;
});
