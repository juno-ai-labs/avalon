import type { IconGroupAction } from '@rally/ui/components/icon-group';
import { createContext, useContext, useEffect, type PropsWithChildren, type ReactNode } from 'react';
import { LevelRow, useTitleMenuNav } from '@rally/ui/components/title-pill';

export interface DetailHeaderAction extends IconGroupAction {
  /** Lazily mounted content for a level in the host title menu. */
  menu?: ReactNode;
}

/** A detail's own menu levels use the host's breadcrumb and keyboard navigation. */
export function DetailActionMenu({ actions, children, rowsOnly = false }: { actions: readonly DetailHeaderAction[]; children?: ReactNode; rowsOnly?: boolean }): React.JSX.Element {
  const nav = useTitleMenuNav();
  const sections = actions.filter((action) => action.menu !== undefined);
  const current = sections.find((action) => action.key === nav.view?.key);
  if (!rowsOnly && current) return <>{current.menu}</>;
  return <>{children ?? sections.map((action) => <LevelRow icon={action.icon} key={action.key} label={action.label} view={{ key: action.key, label: action.label }} />)}</>;
}

/**
 * How a detail hands the actions that belong to *it* to its host's header.
 *
 * A panel header already owns the surface's own controls: the title,
 * versions, archive, close. What it cannot know is that the thing it is showing
 * has controls of its own, and a detail that draws them in its body puts chrome
 * inside the content — which, for a live artifact, means a row of buttons that
 * reads as part of the page being previewed rather than as Rally's.
 *
 * So the host listens and the detail declares. The alternative was to hoist
 * each detail's state into the rail so the rail could build the actions itself,
 * which spreads one detail's logic across two components and grows the rail by
 * one branch per kind of resource. Here the rail gains one capability that
 * every detail can use, and knows nothing about any of them.
 *
 * The detail declares actions as data and may supply lazy menu-level content.
 * The host draws the actions as tiles, rows, or header controls; opening a
 * section mounts its content inside the same title-menu navigation. An earlier version portaled
 * finished buttons into the header, which left them square, spaced apart from
 * the group, and outside its fold.
 *
 * A detail rendered with no host declares to nobody: there is no fallback that
 * draws them in place, because a fallback that only appears where the host was
 * forgotten is a second layout nobody looks at.
 */
const DetailHeaderActionsSink = createContext<((actions: readonly DetailHeaderAction[]) => void) | null>(null);

/** Listen for a detail's actions. `onActions` is called with `[]` when the detail unmounts. */
export function DetailHeaderActionsHost({
  children,
  onActions,
}: PropsWithChildren<{ onActions: (actions: readonly DetailHeaderAction[]) => void }>): React.JSX.Element {
  return <DetailHeaderActionsSink.Provider value={onActions}>{children}</DetailHeaderActionsSink.Provider>;
}

/**
 * Declare the detail's actions, from anywhere inside the host. Pass a memoised
 * array: each new one is sent to the host, and the host re-renders on it.
 */
export function useDetailHeaderActions(actions: readonly DetailHeaderAction[]): boolean {
  const sink = useContext(DetailHeaderActionsSink);
  useEffect(() => {
    sink?.(actions);
  }, [actions, sink]);
  useEffect(() => () => sink?.([]), [sink]);
  return sink !== null;
}
