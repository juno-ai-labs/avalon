import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from './cn';

const badgeVariants = cva(
  cn(
    'inline-flex max-w-[140px] items-center overflow-hidden text-ellipsis whitespace-nowrap',
    'rounded-sm border px-1.5 text-[10.5px] font-[520] leading-[18px]',
  ),
  {
    variants: {
      tone: {
        neutral: 'border-line-strong bg-surface-raised text-ink-muted',
        success: 'border-success-edge bg-success-wash text-success-base',
        warning: 'border-warning-edge bg-warning-wash text-warning-base',
        danger: 'border-danger-edge bg-danger-wash text-danger-base',
        accent: 'border-accent-edge bg-accent-wash text-accent-base',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export const badgeTones = ['neutral', 'success', 'warning', 'danger', 'accent'] satisfies BadgeTone[];

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

/**
 * `data-slot` rather than a class, for the one rule outside this file that
 * still needs to find a badge — `.automation-overview-title` hides its own at
 * narrow widths. A marker survives a rename of the component and cannot be
 * mistaken for the thing that styles it; it is the same convention Catalyst
 * uses to let a parent size the icon inside it.
 */
export function Badge({ className, tone, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ tone }), className)} data-slot="badge" {...props} />;
}
