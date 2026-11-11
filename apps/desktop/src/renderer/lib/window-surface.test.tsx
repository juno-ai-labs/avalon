import { fireEvent, render, screen } from '@testing-library/react';
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { LandingScreen } from '../screens/landing';
import { AppRouteNavigation } from './app-navigation';
import { layoutKey } from './desktop-layout';
import { setDeviceStartupPage } from './device-preferences';
import { useUiStore } from './ui-store';
import { useCloseWindowSurface } from './window-surface';

vi.mock('./app-session', () => ({ useAppSession: () => ({
  session: { user: { id: 'person' }, workspace: { id: 'org' } },
}) }));
vi.mock('./collaboration-session', () => ({ useShellCapabilities: () => ({ host: 'browser' }) }));

function Settings() {
  const close = useCloseWindowSurface();
  return <button onClick={close}>Close settings</button>;
}
function Destination() {
  return <div data-testid="destination">{useLocation().pathname}</div>;
}
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/#/settings');
  useUiStore.getState().setSidebarSection('activity');
});

it.each([
  '/canvases/00000000-0000-7000-8000-000000000a51',
  '/sidekicks/00000000-0000-7000-8000-000000000a51',
  '/activity',
])('closing browser Settings resumes %s with the default startup choice', async (saved) => {
  localStorage.setItem(layoutKey('org', 'person', 'last-route'), saved);
  render(<HashRouter><AppRouteNavigation /><Routes>
    <Route path="/settings" element={<Settings />} />
    <Route path="/" element={<LandingScreen />} />
    <Route path="*" element={<Destination />} />
  </Routes></HashRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
  expect(await screen.findByTestId('destination')).toHaveTextContent(saved);
  expect(useUiStore.getState().sidebarSection).toBe('activity');
});

it('keeps Last Opened behavior when returning from Settings', async () => {
  setDeviceStartupPage('last-opened');
  localStorage.setItem(layoutKey('org', 'person', 'last-route'), '/sidekicks');
  render(<HashRouter><AppRouteNavigation /><Routes>
    <Route path="/settings" element={<Settings />} />
    <Route path="/" element={<LandingScreen />} />
    <Route path="*" element={<Destination />} />
  </Routes></HashRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
  expect(await screen.findByTestId('destination')).toHaveTextContent('/sidekicks');
});
