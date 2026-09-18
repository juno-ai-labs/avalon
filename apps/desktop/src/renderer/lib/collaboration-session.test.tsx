import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { CookieClientSession } from '@rally/contracts/client-session';
import { CollaborationSessionProvider, useCollaborationSession } from './collaboration-session';
import { RallyApi } from './api';

function Probe(): React.JSX.Element {
  const { api, session, connectorSetup } = useCollaborationSession();
  return <output>{JSON.stringify({ viewer: api?.viewerUserId, user: session?.user.id,
    setup: connectorSetup !== null, hasBearer: session !== null && 'accessToken' in session })}</output>;
}

it('provides collaboration identity and API without desktop setup or bearer credentials', () => {
  const session: CookieClientSession = { authentication: 'cookie',
    apiBaseUrl: '/regional/global/browser/api/workspace', expiresAt: '2026-10-01T00:00:00.000Z',
    user: { id: 'guest', name: 'Guest', email: 'guest@example.test' }, workspace: null };
  const api = new RallyApi(session.apiBaseUrl, session);
  const view = render(<CollaborationSessionProvider api={api} session={session}><Probe /></CollaborationSessionProvider>);
  expect(screen.getByRole('status')).toHaveTextContent(JSON.stringify({ viewer: 'guest', user: 'guest', setup: false, hasBearer: false }));
  view.rerender(<CollaborationSessionProvider api={null} session={null}><Probe /></CollaborationSessionProvider>);
  expect(screen.getByRole('status')).toHaveTextContent(JSON.stringify({ setup: false, hasBearer: false }));
});
