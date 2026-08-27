import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { cn } from './cn';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Required, and it is both the accessible name and the tooltip. An icon-only
   * control that has one but not the other is either unusable with a screen
   * reader or unguessable with a pointer, and taking one string closes both.
   */
  label: string;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, label, tooltipSide = 'bottom', ...props },
  ref,
) {
  return (
    <Tooltip delayDuration={450}>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          className={cn(
            'relative inline-flex h-[30px] w-[30px] items-center justify-center rounded',
            'border border-transparent bg-transparent p-0 text-ink-subtle',
            'transition-[background-color,border-color,color] duration-150 ease-out',
            'enabled:hover:border-line-hover enabled:hover:bg-surface-raised-hover enabled:hover:text-ink',
            className,
          )}
          ref={ref}
          type="button"
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
});
