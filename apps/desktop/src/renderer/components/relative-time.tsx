import * as Tooltip from '@radix-ui/react-tooltip';

import { useNow } from '../lib/clock';
import { formatDateTime, formatRelative } from '../lib/format';

/**
 * A moment described relative to now — "7 minutes ago", "in 2 hours" — that
 * stays true as now moves, and gives up the exact local time on hover.
 *
 * Every relative time in the renderer renders through here rather than calling
 * `formatRelative` in place: a label computed once at render is right for the
 * minute it was painted and wrong for the rest of the session, and a person
 * who wants to know *when* rather than *how long ago* should not have to open
 * the inspector to find out. The clock is `useNow`, one shared interval for
 * the whole screen.
 */
export function RelativeTime({
  className,
  format = formatRelative,
  value,
}: {
  /** A class for the `<time>` itself, where a surface styles it by name. */
  className?: string;
  /**
   * The label, given the instant and the clock it is read against. The
   * default is the feed's "7 minutes ago"; a surface with its own calendar
   * vocabulary ("Yesterday", a weekday) passes its own and still ticks.
   */
  format?: (value: string, now: Date) => string;
  /** An ISO-8601 instant. */
  value: string;
}): React.JSX.Element {
  const now = useNow();
  return (
    // The provider is the component's own rather than the host's. A timestamp
    // appears in the feed, both sidebars, the inspector, a dropdown menu and a
    // command palette, and requiring each of those to have wrapped itself in
    // one would make a shared primitive throw in the surface that forgot —
    // which is the sort of thing a test host reproduces and a person finds.
    // Radix nests providers, so an app-level one above this stays in effect for
    // everything else.
    <Tooltip.Provider delayDuration={450}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <time className={className} dateTime={value}>{format(value, new Date(now))}</time>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip" side="top" sideOffset={6}>
            {formatDateTime(value)}
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
