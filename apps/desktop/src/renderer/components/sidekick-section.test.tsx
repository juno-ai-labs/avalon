import { fireEvent, render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it, vi } from 'vitest';
import type { WorkstreamAutomationSummary } from '../lib/types';
import { SidekickSection, workstreamSidekickRows } from './sidekick-section';
const openSidekicks = vi.hoisted(() => vi.fn());
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ openSidekicks }),
  desktopServicesAvailable: () => false,
}));

const owned: WorkstreamAutomationSummary = {
  id: 'owned-1', name: 'Release notes', description: 'Draft the notes.', loadable: true,
  status: 'active', updatedAt: '2026-09-09T00:00:00.000Z',
};

/** Radix needs the provider the app installs at its root; the rows use `Tip`. */
function renderSection(props: React.ComponentProps<typeof SidekickSection>) {
  return render(<Tooltip.Provider><SidekickSection {...props} /></Tooltip.Provider>);
}

describe('SidekickSection', () => {
  it('explains the recommendation through the circular carambola marker', async () => {
    renderSection({ items: [{ id: 'one', name: 'Editor', description: 'Review wording', recommended: true }] });
    const marker = screen.getByRole('img', { name: 'Recommended Sidekick' });
    expect(marker.querySelector('.tabler-icon-carambola')).not.toBeNull();
    expect(screen.queryByText('Recommended')).toBeNull();
    fireEvent.pointerMove(marker, { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Recommended for every substream in this work stream');
    expect(screen.getByRole('tooltip')).toHaveTextContent('isn’t automatically loaded');
  });
  it('opens a row and keeps removal in its right-click menu', () => {
    const remove = vi.fn();
    renderSection({ items: [
      { id: 'one', name: 'Editor', description: 'Review wording', note: 'Unavailable', onRemove: remove },
    ] });
    expect(screen.getByText('Unavailable · Review wording')).toBeVisible();
    const row = screen.getByRole('button', { name: 'Editor' });
    expect(screen.queryByRole('button', { name: 'Remove Editor' })).toBeNull();
    // Compact drops every title in this rail, so the row has to carry a mark.
    expect(row.querySelector('.workstream-context-mark .automation-glyph')).not.toBeNull();
    fireEvent.click(row);
    expect(openSidekicks).toHaveBeenCalledWith('one');
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from this substream' }));
    expect(remove).toHaveBeenCalledOnce();
  });

  it('opens shared management even when no local attachment remains', () => {
    const remove = vi.fn();
    renderSection({ items: [{ id: 'one', name: 'Editor', description: '', recommended: true,
      onRemoveRecommendation: remove }] });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Editor' }));
    expect(screen.queryByRole('menuitem', { name: 'Remove from this substream' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove work stream recommendation' }));
    expect(remove).toHaveBeenCalledOnce();
  });

  it('does not open an empty menu merely because the host can load options', () => {
    const load = vi.fn();
    renderSection({ items: [{ id: 'one', name: 'Owned guide', description: '' }], onMenuOpen: load });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Owned guide' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });

  it('shows a loading label while lazy row actions are unknown', () => {
    const load = vi.fn();
    renderSection({ items: [{ id: 'one', name: 'Shared guide', description: '', managementPending: true }], onMenuOpen: load });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Shared guide' }));
    expect(screen.getByText('Loading Sidekick options…')).toBeVisible();
    expect(load).toHaveBeenCalledOnce();
  });

  it('keeps a row that cannot be detached free of a remove control', () => {
    renderSection({ items: [{ id: 'one', name: 'Editor', description: 'Review wording' }] });
    expect(screen.queryByRole('button', { name: 'Remove Editor' })).toBeNull();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Editor' }));
    expect(screen.queryByRole('menuitem', { name: 'Remove from this substream' })).toBeNull();
  });

  it('leaves no heading behind for an empty answer or a pending one, and surfaces read failures', () => {
    const { rerender } = renderSection({ items: [] });
    expect(screen.queryByRole('heading', { name: 'Sidekicks' })).toBeNull();
    rerender(<Tooltip.Provider><SidekickSection /></Tooltip.Provider>);
    expect(screen.queryByRole('heading', { name: 'Sidekicks' })).toBeNull();
    rerender(<Tooltip.Provider><SidekickSection items={[]} error="Could not load Sidekicks" /></Tooltip.Provider>);
    expect(screen.getByText('Could not load Sidekicks')).toBeVisible();
  });

  it('keeps the rows that arrived beside a failure rather than replacing them', () => {
    // A detach that failed, or one of the two reads behind this section: the
    // Sidekicks it did not take down are still the room's, and blanking them
    // loses a list that worked to report a failure about something else.
    renderSection({
      items: [{ id: 'one', name: 'Editor', description: 'Review wording' }],
      error: 'That Sidekick could not be removed.',
    });
    expect(screen.getByText('That Sidekick could not be removed.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Editor' })).toBeVisible();
  });
});

describe('workstreamSidekickRows', () => {
  it('keeps local removal and shared recommendation removal distinct on a merged row', () => {
    const remove = vi.fn();
    const attachment = { id: 'shared', name: 'Editor', description: 'Writing guidance', available: true };
    const localRemove = vi.fn();
    const rows = workstreamSidekickRows({ owned: [], attached: [attachment], recommended: [attachment], onRemoveAttachment: localRemove, onChangeRecommendation: remove, recommendationOptions: { canManage: true, items: [{ ...attachment, attached: true }] } });
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.recommended).toBe(true);
    rows?.[0]?.onRemove?.();
    expect(localRemove).toHaveBeenCalledWith('shared');
    expect(remove).not.toHaveBeenCalled();
    rows?.[0]?.onRemoveRecommendation?.();
    expect(remove).toHaveBeenCalledWith('shared', false);
  });
  it('keeps parent actions absent without management and offers eligible local recommendations', () => {
    const attachment = { id: 'shared', name: 'Editor', description: '', available: true };
    const change = vi.fn();
    const make = (canManage: boolean) => workstreamSidekickRows({ owned: [], attached: [attachment], recommended: [],
      onRemoveAttachment: vi.fn(), onChangeRecommendation: change,
      recommendationOptions: { canManage, items: [{ ...attachment, attached: false }] },
    })?.[0];
    expect(make(false)?.onRemove).toBeTypeOf('function');
    expect(make(false)?.onRecommend).toBeUndefined();
    expect(make(false)?.onRemoveRecommendation).toBeUndefined();
    make(true)?.onRecommend?.();
    expect(change).toHaveBeenCalledWith('shared', true);
  });

  it('waits for all three answers before claiming the room has any', () => {
    expect(workstreamSidekickRows({ owned: undefined, attached: [], recommended: [] })).toBeUndefined();
    expect(workstreamSidekickRows({ owned: [], attached: undefined, recommended: [] })).toBeUndefined();
    expect(workstreamSidekickRows({ owned: [], attached: [], recommended: undefined })).toBeUndefined();
    expect(workstreamSidekickRows({ owned: [], attached: [], recommended: [] })).toEqual([]);
  });

  it('puts the room’s own first and keeps the attachments it does not own', () => {
    const rows = workstreamSidekickRows({
      recommended: [],
      owned: [owned, { ...owned, id: 'owned-2', name: 'Standup digest', status: 'paused' }],
      attached: [{ id: 'attached-1', name: 'Editor', description: 'Review wording', available: false }],
    });
    expect(rows?.map((row) => [row.id, row.note])).toEqual([
      ['owned-1', undefined], ['owned-2', 'Paused'], ['attached-1', 'Unavailable'],
    ]);
  });

  it('keeps the attachment\u2019s own answer about availability on a merged row', () => {
    // Publishing a triggered revision over an instruction-only one clears
    // `loadable` while the room's conversation keeps the attachment: the
    // Sidekick is active, so the lifecycle has nothing to say, and only the
    // attachment knows the next run will not load it.
    const rows = workstreamSidekickRows({
      recommended: [],
      owned: [owned],
      attached: [{ id: owned.id, name: owned.name, description: owned.description, available: false }],
    });
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.note).toBe('Unavailable');
  });

  it('draws one row for a Sidekick the room owns and has also loaded', () => {
    const onRemoveAttachment = vi.fn();
    const rows = workstreamSidekickRows({
      recommended: [],
      owned: [{ ...owned, status: 'draft', appearance: { icon: 'rocket', color: 'teal' } }],
      attached: [{ id: owned.id, name: 'Stale name', description: 'Stale description', available: true }],
      onRemoveAttachment,
    });
    expect(rows).toHaveLength(1);
    // The owned summary describes it — it carries the chosen appearance and the
    // live lifecycle — and the attachment contributes only its removal.
    expect(rows?.[0]).toMatchObject({ name: 'Release notes', note: 'Draft', appearance: { icon: 'rocket', color: 'teal' } });
    rows?.[0]?.onRemove?.();
    expect(onRemoveAttachment).toHaveBeenCalledWith(owned.id);
  });

  it('offers no removal to somebody who may not detach one', () => {
    const rows = workstreamSidekickRows({
      recommended: [],
      owned: [],
      attached: [{ id: 'attached-1', name: 'Editor', description: 'Review wording', available: true }],
    });
    expect(rows?.[0]?.onRemove).toBeUndefined();
  });
});
