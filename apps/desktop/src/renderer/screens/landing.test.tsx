import * as Tooltip from '@radix-ui/react-tooltip';
import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { ConversationAdmissionProvider } from '../lib/conversation-admission';
import { layoutKey } from '../lib/desktop-layout';
import { AutomationScreen } from './automation';
import { LandingScreen } from './landing';

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({
  session: { user: { id: 'person' }, workspace: { id: 'org' } },
}) }));

const getAutomation = vi.hoisted(() => vi.fn());
vi.mock('../lib/collaboration-session', () => ({
  useOptionalCollaborationSession: () => null,
  useCollaborationSession: () => ({ session: undefined, api: {
    getAutomation,
    getAutomationRuns: () => Promise.resolve([]),
    getSidekickDelegates: () => new Promise(() => undefined),
  } }),
  useShellCapabilities: () => ({ host: 'desktop', guest: false }),
}));
vi.mock('./conversation-surface', () => ({ ConversationSurface: () => <div /> }));

function Destination(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="destination">{location.pathname}</div>;
}

function open(): string {
  render(<MemoryRouter initialEntries={['/']}><Routes>
    <Route element={<LandingScreen />} path="/" />
    <Route element={<Destination />} path="*" />
  </Routes></MemoryRouter>);
  return screen.getByTestId('destination').textContent ?? '';
}

describe('the landing route', () => {
  beforeEach(() => { localStorage.clear(); getAutomation.mockReset(); });

  it('opens the Canvases home on a device that saved nothing', () => {
    expect(open()).toBe('/canvases');
  });

  it('reopens the Canvas or Sidekick last open on this device', () => {
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/sidekicks/00000000-0000-7000-8000-000000000a51');
    expect(open()).toBe('/sidekicks/00000000-0000-7000-8000-000000000a51');
  });

  it('does not reopen New Sidekick, which would create one on every launch', () => {
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/sidekicks/new');
    expect(open()).toBe('/canvases');
  });

  it('opens the Canvases home where a Channel or Thread route was saved before the cutover', () => {
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/channels/general/threads/launch');
    expect(open()).toBe('/canvases');
  });

  it('restores nothing while onboarding is pending, and the stored route once it is done', () => {
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/sidekicks/00000000-0000-7000-8000-000000000a51');
    const tree = (admitted: boolean) => <MemoryRouter initialEntries={['/']}><ConversationAdmissionProvider allowed={admitted}><Routes>
      <Route element={<LandingScreen />} path="/" />
      <Route element={<Destination />} path="*" />
    </Routes></ConversationAdmissionProvider></MemoryRouter>;
    const { rerender } = render(tree(false));
    expect(screen.queryByTestId('destination')).toBeNull();
    expect(screen.getByText('Opening…')).toBeInTheDocument();
    rerender(tree(true));
    expect(screen.getByTestId('destination').textContent).toBe('/sidekicks/00000000-0000-7000-8000-000000000a51');
  });
});

describe('a restored route whose object is gone', () => {
  beforeEach(() => { localStorage.clear(); getAutomation.mockReset(); });

  function launch(entry: string) {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Tooltip.Provider><ErrorNoticeProvider><MemoryRouter initialEntries={[entry]}><Routes>
        <Route element={<LandingScreen />} path="/" />
        <Route element={<AutomationScreen />} path="/sidekicks/:id" />
        <Route element={<Destination />} path="*" />
      </Routes></MemoryRouter></ErrorNoticeProvider></Tooltip.Provider>
    </QueryClientProvider>);
  }

  it('lands on the Sidekicks home with no dialog when the stored Sidekick does not exist', async () => {
    localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/sidekicks/00000000-0000-7000-8000-000000000a51');
    getAutomation.mockRejectedValue(new ApiError('This Sidekick does not exist', 404, 'sidekick_not_found'));
    launch('/');
    expect((await screen.findByTestId('destination')).textContent).toBe('/sidekicks');
    expect(getAutomation).toHaveBeenCalledWith('00000000-0000-7000-8000-000000000a51', expect.anything());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('still says so when a Sidekick someone opened does not exist', async () => {
    getAutomation.mockRejectedValue(new ApiError('This Sidekick does not exist', 404, 'sidekick_not_found'));
    launch('/sidekicks/00000000-0000-7000-8000-000000000a51');
    await waitFor(() => expect(screen.getByRole('alertdialog')).toHaveTextContent('Sidekick could not be opened'));
    expect(screen.queryByTestId('destination')).toBeNull();
  });
});
