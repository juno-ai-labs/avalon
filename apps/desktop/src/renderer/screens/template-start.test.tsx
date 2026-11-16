import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real route, catalog and Canvas launcher; only the API is a double.
const api = vi.hoisted(() => ({ createCanvas: vi.fn(async () => ({ turnId: null })) }));
const capabilities = vi.hoisted(() => ({ guest: false }));
vi.mock('../lib/collaboration-session', () => ({
  useOptionalCollaborationSession: () => ({ api, session: { user: { id: 'viewer' }, workspace: { id: 'org', region: 'global', role: 'member' } } }),
  useShellCapabilities: () => ({ host: 'browser', guest: capabilities.guest }),
}));

import { TemplateStartScreen } from './template-start';

function Location(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="location">{location.pathname}</output><button onClick={() => void navigate(-1)}>Back</button></>;
}

function mount(slug: string): void {
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/canvases', `/marketplace/${slug}`]} initialIndex={1}>
    <Location /><Routes>
      <Route path="/canvases" element={<p>Canvases</p>} />
      <Route path="/canvases/:id" element={<p>Canvas</p>} />
      <Route path="/marketplace/:slug" element={<TemplateStartScreen />} />
    </Routes>
  </MemoryRouter></QueryClientProvider>);
}

describe('starting a Canvas from a template link', () => {
  beforeEach(() => { api.createCanvas.mockClear(); capabilities.guest = false; });

  it('starts one Canvas with the template prompt and replaces the route, so Back does not start another', async () => {
    mount('pr-dashboard');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toMatch(/^\/canvases\/[0-9a-f-]{36}$/u));
    expect(api.createCanvas).toHaveBeenCalledTimes(1);
    const [request] = api.createCanvas.mock.calls[0] as unknown as [{ prompt: { text: string } }];
    expect(request.prompt.text.startsWith('Build a live GitHub PR dashboard in this Canvas.')).toBe(true);
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByTestId('location').textContent).toBe('/canvases');
    expect(api.createCanvas).toHaveBeenCalledTimes(1);
  });

  it('opens the Canvases home for a slug the catalog does not hold', () => {
    mount('no-such-template');
    expect(screen.getByTestId('location').textContent).toBe('/canvases');
    expect(api.createCanvas).not.toHaveBeenCalled();
  });

  it('starts nothing for a guest', () => {
    capabilities.guest = true;
    mount('pr-dashboard');
    expect(screen.getByTestId('location').textContent).toBe('/canvases');
    expect(api.createCanvas).not.toHaveBeenCalled();
  });
});
