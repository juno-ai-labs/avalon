import { Navigate } from 'react-router-dom';

import { useAppSession } from '../lib/app-session';
import { layoutKey, readLayout } from '../lib/desktop-layout';
import { LANDING_ROUTE, restorableRoute } from '../lib/landing';

/**
 * The root route: the Canvas or Sidekick this person last had open on this
 * device, else the Canvases home.
 */
export function LandingScreen(): React.JSX.Element {
  const { session } = useAppSession();
  const saved = session?.workspace && session.user
    ? restorableRoute(readLayout(layoutKey(session.workspace.id, session.user.id, 'last-route'))) : null;
  return <Navigate replace to={saved ?? LANDING_ROUTE} />;
}
