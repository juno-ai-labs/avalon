/**
 * The sidebar's placeholder rows, in their own module because both the sidebar
 * and the Projects section it renders show them, and importing them from
 * `sidebar.tsx` would close a cycle with `project-sidebar-section.tsx`.
 */

/**
 * One row's worth of placeholder, in the geometry of the row it stands in for.
 *
 * Shaped rather than a single block because the sidebar's lists arrive
 * together now: the reader sees the layout they are about to get — a marker, a
 * title, sometimes a second line — and the rows fill in where the bars already
 * are, instead of a grey rectangle collapsing into a different shape. Widths
 * vary by position in CSS rather than here, so the set reads as a list of
 * unequal titles and not as a barcode.
 *
 * Decorative: the label for the wait is said once, by the section.
 */
export function SidebarSkeletonRow({ hint = false }: { hint?: boolean }): React.JSX.Element {
  return (
    <div aria-hidden="true" className="sidebar-row skeleton-row">
      <span className="skeleton-bar skeleton-row-marker" />
      <span className="sidebar-row-main">
        <span className="skeleton-bar skeleton-row-line" />
        {hint && <span className="skeleton-bar skeleton-row-subline" />}
      </span>
    </div>
  );
}

export function SidebarSkeletonRows({ count, hint = false }: { count: number; hint?: boolean }): React.JSX.Element {
  return (
    <div className="sidebar-list">
      {Array.from({ length: count }, (_, index) => <SidebarSkeletonRow hint={hint} key={index} />)}
    </div>
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
