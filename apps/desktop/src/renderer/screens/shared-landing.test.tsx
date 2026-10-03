import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { expect, it } from 'vitest';
import { SharedNavigationDirectorySchema } from '@rally/contracts/scope-grants';
import { CollaborationSessionProvider } from '../lib/collaboration-session';
import { conversationDirectoryQueryKey } from '../lib/conversation-directory';
import { SharedLanding } from './shared-landing';

const workspaceId = '00000000-0000-7000-8000-000000000002';
const session = {
  apiBaseUrl: 'https://api.example.test', expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id: '00000000-0000-7000-8000-0000000000a1', name: 'Guest', email: 'guest@example.test' },
  workspace: { id: workspaceId, name: 'Studio', region: 'global', role: null, timezone: 'UTC', accessClass: 'guest' as const },
};
const parentId = '00000000-0000-7000-8000-000000000021';
const breakoutId = '00000000-0000-7000-8000-000000000031';

function Opened(): React.JSX.Element {
  const location = useLocation();
  return <p>Opened {location.pathname}{location.search}</p>;
}

function renderLanding(client: QueryClient, path = '/'): void {
  render(
    <QueryClientProvider client={client}>
      <CollaborationSessionProvider api={null} session={session}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<SharedLanding />} path="/" />
            <Route element={<SharedLanding />} path="/spaces/:spaceId" />
            <Route element={<Opened />} path="/workstreams/:id" />
          </Routes>
        </MemoryRouter>
      </CollaborationSessionProvider>
    </QueryClientProvider>,
  );
}

it('opens the Breakout a guest holds when Main is not theirs', async () => {
  const client = new QueryClient();
  const directory = SharedNavigationDirectorySchema.parse({
    spaces: [],
    workstreams: [{ parentId, title: 'Launch', scope: 'personal', archived: false,
      conversations: [{ substreamId: breakoutId, title: 'Risks', scope: 'personal', archived: false }] }],
  });
  client.setQueryData(conversationDirectoryQueryKey(workspaceId), directory);
  renderLanding(client);
  expect(await screen.findByText(`Opened /workstreams/${parentId}?substream=${breakoutId}`)).toBeInTheDocument();
});

it('says the shared channels could not load instead of waiting forever', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await client.fetchQuery({
    queryKey: conversationDirectoryQueryKey(workspaceId),
    queryFn: async () => { throw new Error('offline'); },
  }).catch(() => undefined);
  renderLanding(client);
  expect(await screen.findByText('Shared channels could not be loaded')).toBeInTheDocument();
});
