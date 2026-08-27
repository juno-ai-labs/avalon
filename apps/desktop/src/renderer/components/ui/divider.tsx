import type { HTMLAttributes } from 'react';

import { cn } from './cn';

export interface DividerProps extends HTMLAttributes<HTMLDivElement> {
  /** The faint rule between rows of one list, rather than between sections. */
  soft?: boolean;
  orientation?: 'horizontal' | 'vertical';
}

/**
 * A rule, drawn as a border rather than as a filled box, so its thickness is
 * `sys.size.border.hairline` and a theme that wants a half-pixel line on a
 * retina display gets one. A `1px` box would not round the same way.
 *
 * Radix has a `Separator`, and this is not it: the package is not a dependency
 * and a decorative rule is nine lines of markup. Adding one for this would be
 * the kind of dependency nobody can later argue for removing.
 */
export function Divider({ className, soft, orientation = 'horizontal', ...props }: DividerProps): React.JSX.Element {
  return (
    <div
      aria-orientation={orientation}
      className={cn(
        'shrink-0 border-line',
        soft && 'border-line-subtle',
        orientation === 'vertical' ? 'h-full border-l border-l-hairline' : 'w-full border-t border-t-hairline',
        className,
      )}
      role="separator"
      {...props}
    />
  );
}
