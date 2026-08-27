import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';

import { cn } from './cn';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * The arrow is drawn here rather than left to the caller.
 *
 * Every one of the seven tooltips in the renderer wrote `<Tooltip.Arrow
 * className="tooltip-arrow" />` by hand, and the one that did not is the one
 * that looked wrong. A part that is mandatory is not a part.
 */
export const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, children, sideOffset = 6, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        className={cn(
          'z-[1000] rounded-sm bg-tooltip-background px-2 py-[5px] text-[12px] text-tooltip-foreground',
          'animate-[tooltip-in_100ms_ease-out]',
          className,
        )}
        ref={ref}
        sideOffset={sideOffset}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-tooltip-background" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
});
