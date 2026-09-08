import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SidekicksLibraryScreen } from './sidekicks-library';

vi.mock('../lib/app-session', () => ({
  useAppSession: () => ({ api: { getSidekicks: async () => [
    { id: 'personal', name: 'Daily brief', description: 'Prepare my morning notes.', scope: 'you', status: 'active' },
    { id: 'team', name: 'Team brief', description: 'Share the latest product news.', scope: 'workspace', status: 'active' },
  ] } }),
}));

describe('SidekicksLibraryScreen', () => {
  it('combines ownership and text filters and recovers from no matches', async () => {
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SidekicksLibraryScreen /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('link', { name: /Daily brief/ })).toHaveAttribute('href', '/sidekicks/personal');
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(screen.queryByRole('link', { name: /Daily brief/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Team brief/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Sidekicks' }), { target: { value: 'morning' } });
    expect(screen.getByText('No matching Sidekicks')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));
    expect(screen.getByRole('link', { name: /Daily brief/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Team brief/ })).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Sidekick ownership' })).getByRole('button', { name: 'Everyone' })).toHaveAttribute('aria-pressed', 'true');
  });
});
