import type * as PlatformModule from '../lib/platform';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidekicksLibraryRoute, SidekicksLibraryScreen, SidekicksWindow } from './sidekicks-library';

const getSidekicks = vi.hoisted(() => vi.fn());
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api: { getSidekicks } }) }));
const shell = vi.hoisted(() => ({ host: 'desktop' as 'desktop' | 'browser', guest: false }));
vi.mock('../lib/collaboration-session', () => ({ useShellCapabilities: () => shell }));
const openThread = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/platform', async (importOriginal) => ({
  ...await importOriginal<typeof PlatformModule>(),
  desktopBridge: () => ({ openThread }),
}));

beforeEach(() => {
  shell.host = 'desktop';
  shell.guest = false;
  getSidekicks.mockReset().mockResolvedValue([
    { id: 'personal', name: 'Daily brief', description: 'Prepare my morning notes.', scope: 'you', status: 'active' },
    { id: 'team', name: 'Team brief', description: 'Share the latest product news.', scope: 'workspace', status: 'active' },
  ]);
});

describe('SidekicksLibraryScreen', () => {
  it('does not claim a zero count while loading or after a failed load', async () => {
    getSidekicks.mockRejectedValue(new Error('Unavailable'));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole('status', { name: 'Sidekick count' })).toBeEmptyDOMElement();
    await screen.findByText('Unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('status', { name: 'Sidekick count' })).toBeEmptyDOMElement();
  });

  it('combines ownership and text filters and recovers from no matches', async () => {
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('link', { name: /Daily brief/ })).toHaveAttribute('href', '/sidekicks/personal');
    expect(screen.getByRole('region', { name: 'Your Sidekicks' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Sidekick count' })).toHaveTextContent('2 Sidekicks');
    fireEvent.click(screen.getByRole('button', { name: 'Organization' }));
    expect(screen.queryByRole('link', { name: /Daily brief/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Team brief/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Sidekicks' }), { target: { value: 'morning' } });
    expect(screen.getByRole('region', { name: 'Search results' })).toBeInTheDocument();
    expect(screen.getByText('No matching Sidekicks')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));
    expect(screen.getByRole('link', { name: /Daily brief/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Team brief/ })).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Sidekick ownership' })).getByRole('button', { name: 'Everyone' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the Sidekicks home', () => {
  it('lists each Sidekick as a row with its status, who it is shared with and when it next wakes', async () => {
    getSidekicks.mockResolvedValue([
      { id: 'triage', name: 'Incident triage', description: 'Watches alerts.', scope: 'you', audience: 'people', status: 'active', needsInput: true, updatedAt: '2026-11-07T09:00:00.000Z' },
      { id: 'changelog', name: 'Weekly changelog', description: 'Every Friday.', scope: 'workspace', audience: 'workspace', status: 'active', nextRunAt: '2099-11-13T22:00:00.000Z', updatedAt: '2026-11-07T09:00:00.000Z' },
      { id: 'revenue', name: 'Revenue analyst', description: 'Keeps revenue current.', scope: 'you', audience: 'personal', status: 'paused', updatedAt: '2026-11-07T09:00:00.000Z' },
    ]);
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);
    const triage = (await screen.findByRole('link', { name: 'Incident triage' })).closest('li')!;
    expect(within(triage).getByText('Needs input')).toBeInTheDocument();
    expect(within(triage).getByText('Named people')).toBeInTheDocument();
    const changelog = screen.getByRole('link', { name: 'Weekly changelog' }).closest('li')!;
    expect(within(changelog).getByText('Organization')).toBeInTheDocument();
    expect(within(changelog).getByText('Active')).toBeInTheDocument();
    expect(within(changelog).getByText('Next').nextElementSibling).not.toHaveTextContent('—');
    const revenue = screen.getByRole('link', { name: 'Revenue analyst' }).closest('li')!;
    expect(within(revenue).getByText('Paused')).toBeInTheDocument();
    expect(within(revenue).getByText('Next').nextElementSibling).toHaveTextContent('—');
    fireEvent.click(screen.getByRole('button', { name: 'Paused' }));
    expect(screen.getByRole('link', { name: 'Revenue analyst' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Weekly changelog' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Only you' }));
    // Shared with named people is not only its author's.
    expect(screen.queryByRole('link', { name: 'Incident triage' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Revenue analyst' })).toBeInTheDocument();
  });

  it('offers New Sidekick beside the empty copy when there are none', async () => {
    getSidekicks.mockResolvedValue([]);
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText('No Sidekicks yet')).toBeInTheDocument();
    expect(screen.getByText('Describe what you would like to delegate to create one.')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'New Sidekick' })).toHaveLength(2);
  });

  it.each(['desktop', 'browser'] as const)('renders in the main window rather than handing off to the Sidekicks window (%s)', async (host) => {
    shell.host = host;
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SidekicksLibraryRoute /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('link', { name: /Daily brief/ })).toHaveAttribute('href', '/sidekicks/personal');
    expect(screen.queryByText('Opening Sidekicks…')).toBeNull();
  });
});

describe('SidekicksWindow', () => {
  function renderWindow(): void {
    render(<QueryClientProvider client={new QueryClient()}><SidekicksWindow /></QueryClientProvider>);
  }

  it('closes the window on Escape', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    renderWindow();
    await screen.findByRole('link', { name: /Daily brief/ });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(close).toHaveBeenCalledOnce();
  });

  it('leaves the keystroke to a search box that still holds a filter', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    renderWindow();
    const search = await screen.findByRole('searchbox', { name: 'Search Sidekicks' });
    fireEvent.change(search, { target: { value: 'morning' } });

    // Chromium answers Escape in a `type="search"` field by clearing it. A
    // window that vanished on the same keystroke would never let anyone see the
    // filter come off.
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: '' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });
});
