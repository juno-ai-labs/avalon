import clsx from 'clsx';

/**
 * The Organization is still creating General and placing every Channel in it.
 *
 * Shown instead of the hierarchy rather than beside it: a Space directory
 * missing General, or a Channel with no Space, is not a state any surface is
 * allowed to render, so there is nothing truthful to show underneath.
 */
export function SpacesOpeningCard({ className }: { className?: string }): React.JSX.Element {
  return (
    <div className={clsx('space-opening-card', className)} role="status">
      <span>Rally is opening this organization. Spaces appear once every channel has one.</span>
    </div>
  );
}
