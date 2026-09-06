import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@rally/contracts/search';
import { SearchModal } from './search-modal';

const result: SearchResult = {
  id: 'message-1', category: 'messages', title: 'Customer research', sourceLabel: 'Customer research',
  occurredAt: null, excerpt: 'Alex Danilowicz replied', excerptStart: 0,
  highlights: [{ start: 5, end: 10 }], revision: '1',
  location: { kind: 'message', workstreamId: '00000000-0000-7000-8000-000000000001',
    substreamId: '0', turnId: 'turn-1', transcriptSequence: 1, range: { start: 5, end: 10 } },
};
function setup(search: React.ComponentProps<typeof SearchModal>['search']) {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><SearchModal workspaceId="workspace:user"
    open onOpenChange={onOpenChange} onSelect={onSelect} search={search} /></QueryClientProvider>);
  return { onSelect, onOpenChange, client };
}
describe('workspace search modal', () => {
  it('queries the selected source and opens the highlighted canonical result with Enter', async () => {
    const search = vi.fn(async () => ({ results: [result] }));
    const { onSelect, onOpenChange } = setup(search);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['All', 'Messages', 'Links', 'Artifacts', 'Files']);
    fireEvent.click(screen.getByRole('tab', { name: 'Messages' }));
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'danil' } });
    const option = await screen.findByRole('option');
    expect(option.querySelector('strong')).toHaveTextContent('Danil');
    expect(search).toHaveBeenLastCalledWith({ query: 'danil', category: 'messages' }, expect.any(AbortSignal));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(result);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it('discards an old category response that arrives after a newer query', async () => {
    let finishOld: ((value: { results: SearchResult[] }) => void) | undefined;
    const search = vi.fn((request) => request.category === 'all'
      ? new Promise<{ results: SearchResult[] }>((resolve) => { finishOld = resolve; })
      : Promise.resolve({ results: [] }));
    setup(search);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'danil' } });
    await waitFor(() => expect(finishOld).toBeDefined());
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    await screen.findByText('No results');
    finishOld!({ results: [result] });
    await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());
  });
  it('distinguishes an unavailable index from no matches', async () => {
    setup(async () => { throw new Error('unavailable'); });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'danil' } });
    expect(await screen.findByRole('status')).toBeInTheDocument();
    await screen.findByText('Search could not be completed. Please try again.');
    expect(screen.queryByText('No results')).not.toBeInTheDocument();
  });
  it('hides previously authorized results when revalidation fails', async () => {
    const search = vi.fn().mockResolvedValueOnce({ results: [result] }).mockRejectedValue(new Error('access changed'));
    const { client } = setup(search);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'danil' } });
    await screen.findByRole('option');
    await act(() => client.invalidateQueries({ queryKey: ['workspace-search'] }));
    await screen.findByText('Search could not be completed. Please try again.');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });
});
