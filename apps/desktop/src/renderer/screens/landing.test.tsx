import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { layoutKey } from '../lib/desktop-layout';
import { LandingScreen } from './landing';

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({
  session: { user: { id: 'person' }, workspace: { id: 'org' } },
}) }));

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
  beforeEach(() => localStorage.clear());

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
});
