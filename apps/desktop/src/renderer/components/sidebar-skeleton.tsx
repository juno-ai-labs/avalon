/**
 * The sidebar's placeholder rows, in their own module because both the sidebar
 * and the Spaces section it renders show them, and importing them from
 * `sidebar.tsx` would close a cycle with `space-sidebar-section.tsx`.
 */

import { SidebarList, SidebarRow } from '@rally/ui/components/resizable-sidebar';

/**
 * The shape of the mark a row stands in for: a Channel's round glyph, or a
 * Space's square tile. Both are the 36px slot the real row draws its icon in,
 * so a compact rail shows the same column of marks it resolves into.
 */
type SidebarSkeletonMark = 'glyph' | 'tile';

/** Every row, or only some, carries the activity line, as a real list does. */
type SidebarSkeletonHint = boolean | 'some';

/**
 * One row's worth of placeholder, in the geometry of the row it stands in for.
 *
 * Shaped rather than a single block because the sidebar's lists arrive
 * together now: the reader sees the layout they are about to get — a mark, a
 * title, sometimes a second line — and the rows fill in where the bars already
 * are, instead of a grey rectangle collapsing into a different shape. Widths
 * vary by position in CSS rather than here, so the set reads as a list of
 * unequal titles and not as a barcode.
 *
 * Decorative: the label for the wait is said once, by the section.
 */
export function SidebarSkeletonRow({ hint = false, mark = 'glyph' }: { hint?: boolean; mark?: SidebarSkeletonMark }): React.JSX.Element {
  return (
    <SidebarRow as="div" aria-hidden="true" className="skeleton-row">
      <span className="sidebar-row-icon">
        <span className={`skeleton-bar skeleton-row-mark is-${mark}`} />
      </span>
      <span className="sidebar-row-main">
        <span className="skeleton-bar skeleton-row-line" />
        {hint && <span className="skeleton-bar skeleton-row-subline" />}
      </span>
    </SidebarRow>
  );
}

export function SidebarSkeletonRows({ count, hint = false, mark }: {
  count: number;
  hint?: SidebarSkeletonHint;
  mark?: SidebarSkeletonMark;
}): React.JSX.Element {
  return (
    <SidebarList>
      {Array.from({ length: count }, (_, index) => (
        <SidebarSkeletonRow hint={hint === 'some' ? index % 3 === 1 : hint} key={index} mark={mark} />
      ))}
    </SidebarList>
  );
}

/** A dated group of work streams, heading included — what the list resolves into. */
export function SidebarSkeletonGroup({ count }: { count: number }): React.JSX.Element {
  return (
    <div className="sidebar-group">
      <span aria-hidden="true" className="skeleton-bar skeleton-group-label" />
      <SidebarSkeletonRows count={count} hint />
    </div>
  );
}
