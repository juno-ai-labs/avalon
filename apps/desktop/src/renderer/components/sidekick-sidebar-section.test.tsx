import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyVersionedSidebarList } from '../lib/sidebar-list-store';
import type { AutomationSummary } from '../lib/types';
import { SidekicksSection } from './sidekick-sidebar-section';

const setSidekickPinned = vi.hoisted(() => vi.fn());
vi.mock('../lib/collaboration-session', () => ({
  useCollaborationSession: () => ({ api: { setSidekickPinned }, session: { user: { id: 'user-1' } } }),
}));

function sidekick(id: string, name: string, overrides: Partial<AutomationSummary> = {}): AutomationSummary {
  return { id, name, description: '', scope: 'workspace', status: 'active', updatedAt: '2026-11-07T09:00:00.000Z', ...overrides };
}

function renderSection(rows: AutomationSummary[] | null, at = '/'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (rows) applyVersionedSidebarList(client, 'automations', 1, rows);
  render(<QueryClientProvider client={client}><Tooltip.Provider><MemoryRouter initialEntries={[at]}>
    <SidekicksSection scroll={createRef()} />
  </MemoryRouter></Tooltip.Provider></QueryClientProvider>);
}

beforeEach(() => {
  setSidekickPinned.mockReset().mockResolvedValue(undefined);
});

describe('SidekicksSection', () => {
  it('puts the Sidekicks waiting on someone first, then Pinned, then the rest', () => {
    renderSection([
      sidekick('support', 'Support inbox', { unread: true }),
      sidekick('triage', 'Incident triage', { needsInput: true, pinnedPosition: 0 }),
      sidekick('changelog', 'Weekly changelog', { pinnedPosition: 1, nextRunAt: '2099-11-13T22:00:00.000Z' }),
      sidekick('revenue', 'Revenue analyst', { status: 'paused' }),
    ], '/sidekicks/support');
    const waiting = screen.getByRole('region', { name: 'Needs input' });
    expect(within(waiting).getByRole('link', { name: /Incident triage/ })).toHaveTextContent('Needs input');
    const pinned = screen.getByRole('region', { name: 'Pinned Sidekicks' });
    // A Sidekick waiting on someone is drawn once, where it waits.
    expect(within(pinned).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/sidekicks/changelog']);
    expect(within(pinned).getByText(/^Next run/)).toBeInTheDocument();
    const all = screen.getByRole('region', { name: 'All Sidekicks' });
    const support = within(all).getByRole('link', { name: /Support inbox/ });
    expect(support).toHaveAttribute('aria-current', 'page');
    expect(support).toHaveClass('is-unread');
    expect(within(all).getByRole('link', { name: /Revenue analyst/ })).toHaveTextContent('Paused');
  });

  it("says what a waiting Sidekick asked, on its Needs input row", () => {
    renderSection([sidekick('triage', 'Incident triage', { needsInput: true, pendingQuestion: 'Which status page gets the update?' })]);
    const waiting = screen.getByRole('region', { name: 'Needs input' });
    expect(within(waiting).getByRole('link', { name: /Incident triage/ })).toHaveTextContent('Which status page gets the update?');
  });

  it('pins a Sidekick dragged into Pinned, and unpins from its menu', async () => {
    renderSection([sidekick('support', 'Support inbox'), sidekick('changelog', 'Weekly changelog', { pinnedPosition: 0 })]);
    const target = screen.getByRole('region', { name: 'Pinned Sidekicks' });
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(screen.getByRole('link', { name: /Support inbox/ }), { dataTransfer });
    const over = createEvent.dragOver(target, { dataTransfer });
    fireEvent(target, over);
    expect(over.defaultPrevented).toBe(true);
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(setSidekickPinned).toHaveBeenCalledWith('support', true));
    fireEvent.contextMenu(screen.getByRole('link', { name: /Weekly changelog/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
    expect(setSidekickPinned).toHaveBeenCalledWith('changelog', false);
  });

  it('draws the sidebar skeleton until the list arrives', () => {
    renderSection(null);
    expect(screen.getByRole('region', { name: 'Pinned Sidekicks' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('region', { name: 'Needs input' })).toBeNull();
  });
});
