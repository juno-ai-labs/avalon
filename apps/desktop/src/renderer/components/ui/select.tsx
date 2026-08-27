import * as SelectPrimitive from '@radix-ui/react-select';

import { cn } from './cn';
import { Icon } from './icon';
import { overlayItem, overlaySurface } from './surfaces';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface SelectProps {
  /** The accessible name. The trigger shows the value, not the question. */
  label: string;
  options: SelectOption[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  /** `quiet` drops the frame, for a preference row where the label is beside it. */
  variant?: 'default' | 'quiet';
  className?: string;
}

/**
 * A single-select over Radix, which supplies the keyboard and the screen-reader
 * behaviour a `<div role="listbox">` spends four hundred lines failing to.
 */
export function Select({
  label,
  options,
  value,
  onValueChange,
  disabled = false,
  variant = 'default',
  className,
}: SelectProps): React.JSX.Element {
  return (
    <SelectPrimitive.Root disabled={disabled} onValueChange={onValueChange} value={value}>
      <SelectPrimitive.Trigger
        aria-label={label}
        className={cn(
          'inline-flex items-center gap-2.5 rounded px-2.5 py-2 text-start leading-[1.25] text-ink outline-none',
          'transition-[background-color] duration-150 ease-out',
          '[&:hover:not([data-disabled])]:bg-surface-raised-hover',
          'focus-visible:shadow-focus',
          'data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-muted data-[disabled]:opacity-[0.55]',
          variant === 'default'
            ? 'min-w-[190px] justify-between border border-line-hover bg-surface-raised-hover'
            : 'justify-end border border-transparent pr-0.5',
          className,
        )}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon asChild>
          <span className="inline-flex shrink-0 text-ink-muted">
            <Icon name="chevron-down" size="sm" />
          </span>
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className={cn(
            overlaySurface,
            'z-[300] max-h-[min(390px,var(--radix-select-content-available-height))] overflow-hidden',
            'min-w-[var(--radix-select-trigger-width)]',
          )}
          collisionPadding={10}
          position="popper"
          sideOffset={6}
        >
          <SelectPrimitive.Viewport className="max-h-[378px] overflow-y-auto">
            {options.map((option) => (
              <SelectPrimitive.Item
                className={cn(overlayItem, 'min-h-[38px] justify-between gap-3 px-2.5 py-2 data-[state=checked]:bg-surface-raised-hover')}
                key={option.value}
                value={option.value}
              >
                <span className="flex min-w-0 flex-col">
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  {option.description && (
                    <small className="mt-[3px] text-[10.5px] leading-[1.35] text-ink-muted">{option.description}</small>
                  )}
                </span>
                <SelectPrimitive.ItemIndicator asChild>
                  <span className="inline-flex shrink-0 text-brand-ink">
                    <Icon name="check" size="md" />
                  </span>
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
