import { Navigate } from 'react-router-dom';

import { OpeningState } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { useConversationAdmission } from '../lib/conversation-admission';
import { layoutKey, readLayout } from '../lib/desktop-layout';
import { LANDING_ROUTE, RESTORED_ROUTE, restorableRoute } from '../lib/landing';

/**
 * The root route: the Canvas or Sidekick this person last had open on this
 * device, else the Canvases home.
 *
 * Nothing is restored while onboarding is pending. Admission is false until
 * the account and Organization journeys are known to be finished, and the
 * onboarding screen owns the window until then; a route opened underneath it
 * would mount its screen, and any error that screen raised would surface over
 * onboarding. Finishing onboarding lands on the Canvases home itself.
 */
export function LandingScreen(): React.JSX.Element {
  const { session } = useAppSession();
  const admitted = useConversationAdmission();
  if (!admitted) return <OpeningState label="Opening…" />;
  const saved = session?.workspace && session.user
    ? restorableRoute(readLayout(layoutKey(session.workspace.id, session.user.id, 'last-route'))) : null;
  return saved ? <Navigate replace state={RESTORED_ROUTE} to={saved} /> : <Navigate replace to={LANDING_ROUTE} />;
}
