import { createContext, useContext, type PropsWithChildren, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Where a detail draws the actions that belong to *it* rather than to its host.
 *
 * A rail or lightbox header already owns the surface's own controls: the title,
 * versions, archive, close. What it cannot know is that the thing it is showing
 * has controls of its own, and a detail that draws them in its body puts chrome
 * inside the content — which, for a live artifact, means a row of buttons that
 * reads as part of the page being previewed rather than as Rally's.
 *
 * So the host offers a slot and the detail fills it. The alternative was to
 * hoist each detail's state into the rail so the rail could render the buttons
 * itself, which spreads one detail's logic across two components and grows the
 * rail by one branch per kind of resource. Here the rail gains one capability
 * that every detail can use, and knows nothing about any of them.
 *
 * A detail rendered with no host renders no actions: `DetailHeaderActions`
 * returns nothing rather than falling back to drawing them in place, because a
 * fallback that only appears where the slot was forgotten is a second layout
 * nobody looks at.
 */
const DetailHeaderActionsTarget = createContext<HTMLElement | null>(null);

/**
 * Offer the slot. `target` is the element in the host's header that a detail's
 * actions are drawn into, and `null` until that element mounts.
 */
export function DetailHeaderActionsHost({
  children,
  target,
}: PropsWithChildren<{ target: HTMLElement | null }>): React.JSX.Element {
  return <DetailHeaderActionsTarget.Provider value={target}>{children}</DetailHeaderActionsTarget.Provider>;
}

/** Fill the slot, from anywhere inside the host. */
export function DetailHeaderActions({ children }: { children: ReactNode }): React.JSX.Element | null {
  const target = useContext(DetailHeaderActionsTarget);
  if (!target) return null;
  return createPortal(children, target);
}
