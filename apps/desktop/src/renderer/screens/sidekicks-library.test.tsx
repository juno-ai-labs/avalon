import type * as PlatformModule from '../lib/platform';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidekicksLibraryScreen, SidekicksWindow } from './sidekicks-library';

const getSidekicks = vi.hoisted(() => vi.fn());
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api: { getSidekicks } }) }));
const openThread = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/platform', async (importOriginal) => ({
  ...await importOriginal<typeof PlatformModule>(),
  desktopBridge: () => ({ openThread }),
}));
const THREAD_ID = '0191c0de-0000-7000-8000-00000000cafe';

beforeEach(() => {
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

  it('names the owning Thread and opens it without opening the Sidekick', async () => {
    getSidekicks.mockResolvedValue([
      { id: 'notes', name: 'Release notes', description: 'Draft the notes.', scope: 'workstream', status: 'active',
        owningWorkstreamId: THREAD_ID, owningThread: { id: THREAD_ID, title: 'Release room', appearance: { icon: 'rocket', color: 'purple' } } },
      { id: 'left', name: 'Standup', description: 'Collect updates.', scope: 'workstream', status: 'draft', owningWorkstreamId: THREAD_ID },
    ]);
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);

    const notes = (await screen.findByRole('link', { name: 'Release notes' })).closest('li')!;
    const thread = within(notes).getByRole('button', { name: 'Release room' });
    // A sibling of the row's link, never inside it: a button in an anchor is
    // invalid markup and reads as one control to a screen reader.
    expect(thread.closest('a')).toBeNull();
    fireEvent.click(thread);
    expect(openThread).toHaveBeenCalledWith(THREAD_ID);

    // A row whose Thread the reader is not in keeps the plain word.
    const standup = screen.getByRole('link', { name: 'Standup' }).closest('li')!;
    expect(within(standup).getByText('Thread').closest('small')).toHaveTextContent('Draft · Thread');
    expect(within(standup).queryByRole('button')).toBeNull();
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
