import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@rally/contracts/search';
import { ApiError } from '../lib/api';
import { SearchModal } from './search-modal';
import * as perfTrace from '../lib/perf-trace';

const result: SearchResult = {
  id: 'message-1', category: 'messages', title: 'Customer research', sourceLabel: 'Customer research',
  occurredAt: null, excerpt: 'Alex Danilowicz replied', excerptStart: 0,
  highlights: [{ start: 5, end: 10 }], revision: '1',
  location: { kind: 'message', parentKind: 'canvas', workstreamId: '00000000-0000-7000-8000-000000000001',
    substreamId: '0', turnId: 'turn-1', transcriptSequence: 1, range: { start: 5, end: 10 } },
};
/**
 * jsdom has no IntersectionObserver. This double records what the modal
 * observes so a test can bring the end of the list into view on purpose.
 */
const observers = new Set<{ callback: IntersectionObserverCallback; targets: Element[] }>();
class FakeIntersectionObserver {
  private readonly entry: { callback: IntersectionObserverCallback; targets: Element[] };
  constructor(callback: IntersectionObserverCallback) { this.entry = { callback, targets: [] }; observers.add(this.entry); }
  observe(target: Element) { this.entry.targets.push(target); }
  unobserve() {}
  disconnect() { observers.delete(this.entry); }
  takeRecords() { return []; }
}
// The config unstubs globals after every test, so the double is installed per test.
beforeEach(() => { observers.clear(); vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver); });
async function reachEndOfList() {
  await act(async () => {
    for (const { callback, targets } of [...observers]) {
      callback(targets.map((target) => ({ isIntersecting: true, target } as IntersectionObserverEntry)), {} as IntersectionObserver);
    }
  });
}
function setup(search: React.ComponentProps<typeof SearchModal>['search']) {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  const client = new QueryClient();
  const tree = (open: boolean) => <QueryClientProvider client={client}><SearchModal workspaceId="workspace:user"
    open={open} onOpenChange={onOpenChange} onSelect={onSelect} search={search} /></QueryClientProvider>;
  const view = render(tree(true));
  // RTL wraps `rerender` in `act`, so opening and closing settles like a click.
  return { onSelect, onOpenChange, client, setOpen: (open: boolean) => { view.rerender(tree(open)); } };
}
describe('organization search modal', () => {
  afterEach(() => { focusManager.setFocused(undefined); });
  it('presents an empty page as no matches without a partial-results state', async () => {
    setup(async () => ({ results: [] }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'danil' } });
    expect(await screen.findByText('No results')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry search' })).not.toBeInTheDocument();
  });

  it('queries the selected source and opens the highlighted canonical result with Enter', async () => {
    const search = vi.fn(async () => ({ results: [result] }));
    const { onSelect, onOpenChange } = setup(search);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['All', 'Messages', 'Links', 'Artifacts', 'Files']);
    fireEvent.click(screen.getByRole('tab', { name: 'Messages' }));
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'danil' } });
    const option = await screen.findByRole('option');
    expect(option.querySelector('strong')).toHaveTextContent('Danil');
    // Rows carry no ⌘-number badge; the excerpt and its source own the row.
    expect(option.querySelector('kbd')).toBeNull();
    expect(search).toHaveBeenLastCalledWith({ query: 'danil', category: 'messages', pageSize: 7 }, expect.any(AbortSignal));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(result);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it('waits for three characters before searching on any tab', async () => {
    const search = vi.fn(async () => ({ results: [result] }));
    setup(search);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'pr' } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(search).not.toHaveBeenCalled();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('What are you looking for?')).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Messages' }));
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    fireEvent.change(input, { target: { value: 'pri' } });
    await waitFor(() => expect(search).toHaveBeenCalledWith({ query: 'pri', category: 'all', pageSize: 7 }, expect.any(AbortSignal)));
  });

  it('continues past an empty page as its end comes into view and measures through the first result paint', async () => {
    const end = vi.fn();
    const trace = vi.spyOn(perfTrace, 'startPerfTrace').mockReturnValue({
      traceId: 'search-test', mark: vi.fn(), annotate: vi.fn(), end, step: async (_name, run) => run(),
    });
    try {
      const search = vi.fn<React.ComponentProps<typeof SearchModal>['search']>()
        .mockResolvedValueOnce({ results: [], nextCursor: 'next' })
        .mockResolvedValueOnce({ results: [result], nextCursor: null });
      setup(search);
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'danil' } });
      await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
      await act(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(end).not.toHaveBeenCalled();
      await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
      expect(search).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('No results')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /more results/ })).not.toBeInTheDocument();
      await reachEndOfList();
      await screen.findByRole('option');
      expect(search).toHaveBeenLastCalledWith({ query: 'danil', category: 'all', pageSize: 7, cursor: 'next' }, expect.any(AbortSignal));
      await waitFor(() => expect(end).toHaveBeenCalledWith({ outcome: 'completed' }));
    } finally { trace.mockRestore(); }
  });

  it('keeps the first page visible while loading a continuation and preserves result order', async () => {
    let finish: ((value: { results: SearchResult[]; nextCursor: null }) => void) | undefined;
    const search = vi.fn<React.ComponentProps<typeof SearchModal>['search']>()
      .mockResolvedValueOnce({ results: [result], nextCursor: 'next' })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    setup(search);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'danil' } });
    await screen.findByRole('option');
    await reachEndOfList();
    await waitFor(() => expect(finish).toBeDefined());
    expect(screen.getByText('Loading more…')).toBeVisible();
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(search).toHaveBeenLastCalledWith({ query: 'danil', category: 'all', pageSize: 7, cursor: 'next' }, expect.any(AbortSignal));
    await act(async () => finish!({ results: [{ ...result, id: 'message-2', excerpt: 'Second result', highlights: [] }], nextCursor: null }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(screen.getAllByRole('option').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Alex Danilowicz'), expect.stringContaining('Second result'),
    ]);
    expect(screen.queryByText('Loading more…')).not.toBeInTheDocument();
  });

  it('brings the highlighted row back under a footer that just took its room', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const second = { ...result, id: 'message-2', excerpt: 'Second result', highlights: [] };
    const search = vi.fn<React.ComponentProps<typeof SearchModal>['search']>()
      .mockResolvedValueOnce({ results: [result, second], nextCursor: 'next' })
      .mockImplementationOnce(() => new Promise(() => {}));
    setup(search);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'danil' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Second result'));
    // Reaching the last row is what asks for the next page, and it leaves the
    // highlight where it is, so nothing but the footer's arrival can restore it.
    scrollIntoView.mockClear();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await screen.findByText('Loading more…');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.instances.at(-1)).toHaveAttribute('aria-selected', 'true');
  });

  it('loads the next page when the keyboard reaches the last row', async () => {
    const search = vi.fn<React.ComponentProps<typeof SearchModal>['search']>()
      .mockResolvedValueOnce({ results: [result], nextCursor: 'next' })
      .mockResolvedValueOnce({ results: [{ ...result, id: 'message-2', excerpt: 'Second result', highlights: [] }], nextCursor: null });
    setup(search);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'danil' } });
    await screen.findByRole('option');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(search).toHaveBeenLastCalledWith({ query: 'danil', category: 'all', pageSize: 7, cursor: 'next' }, expect.any(AbortSignal));
  });

  it('keeps prior results on a transient continuation failure, waits for the retry, and retries the same cursor', async () => {
    const search = vi.fn<React.ComponentProps<typeof SearchModal>['search']>()
      .mockResolvedValueOnce({ results: [result], nextCursor: 'next' })
      .mockRejectedValueOnce(new ApiError('Unavailable', 503))
      .mockResolvedValueOnce({ results: [{ ...result, id: 'message-2' }], nextCursor: null });
    setup(search);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'danil' } });
    await screen.findByRole('option');
    await reachEndOfList();
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    const retry = await screen.findByRole('button', { name: 'Retry loading more results' });
    expect(screen.getByRole('listbox')).not.toContainElement(retry);
    // Outside the listbox but inside the fixed body: that is what makes the
    // footer take its room from the list rather than from the modal.
    expect(retry.closest('.rally-search-body')).not.toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(1);
    // A failed cursor is not retried by scrolling; only the button asks again.
    await reachEndOfList();
    expect(search).toHaveBeenCalledTimes(2);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(search.mock.calls[2]?.[0].cursor).toBe('next');
  });

  it.each([401, 403])('hides prior results after a %s continuation denial', async (status) => {
    const search = vi.fn<React.ComponentProps<typeof SearchModal>['search']>()
      .mockResolvedValueOnce({ results: [result], nextCursor: 'next' })
      .mockRejectedValueOnce(new ApiError('Access changed', status));
    setup(search);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'danil' } });
    await screen.findByRole('option');
    await reachEndOfList();
    await screen.findByText('Search could not be completed. Please try again.');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more results/ })).not.toBeInTheDocument();
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
  it('repaints a reopened search from the last pages instead of asking again', async () => {
    const search = vi.fn(async () => ({ results: [result] }));
    const { setOpen } = setup(search);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'danil' } });
    await screen.findByRole('option');
    expect(search).toHaveBeenCalledTimes(1);
    setOpen(false);
    setOpen(true);
    // The rows are there without a request, so nothing readmitted them.
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('asks again for a search reopened after the cache window', async () => {
    const search = vi.fn(async () => ({ results: [result] }));
    const { setOpen } = setup(search);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'danil' } });
    await screen.findByRole('option');
    setOpen(false);
    // Only the clock the window is measured against moves; the debounce, the
    // query's own timers and this file's waits stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 30_001);
      setOpen(true);
      await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    } finally { vi.useRealTimers(); }
    expect(search).toHaveBeenLastCalledWith({ query: 'danil', category: 'all', pageSize: 7 }, expect.any(AbortSignal));
  });

  it('measures the cache window from the first page, not the last continuation', async () => {
    const search = vi.fn<React.ComponentProps<typeof SearchModal>['search']>()
      .mockResolvedValueOnce({ results: [result], nextCursor: 'next' })
      .mockResolvedValueOnce({ results: [{ ...result, id: 'message-2' }], nextCursor: null })
      .mockResolvedValue({ results: [result], nextCursor: null });
    // Only `Date` is faked, so the pages can be admitted at times the test
    // chooses while the debounce and every wait below stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const admittedAt = Date.now();
      const { setOpen } = setup(search);
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'danil' } });
      await screen.findByRole('option');
      // The continuation lands inside the window and must not extend it: the
      // first page is what the reader would be shown again, and nothing has
      // readmitted it.
      vi.setSystemTime(admittedAt + 25_000);
      await reachEndOfList();
      await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
      expect(search).toHaveBeenCalledTimes(2);
      vi.setSystemTime(admittedAt + 30_001);
      setOpen(false);
      setOpen(true);
      await waitFor(() => expect(search).toHaveBeenCalledTimes(3));
    } finally { vi.useRealTimers(); }
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
