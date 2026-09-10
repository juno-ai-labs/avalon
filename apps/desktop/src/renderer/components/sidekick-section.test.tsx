import { fireEvent, render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it, vi } from 'vitest';
import type { WorkstreamAutomationSummary } from '../lib/types';
import { SidekickSection, workstreamSidekickRows } from './sidekick-section';
const openSidekicks = vi.hoisted(() => vi.fn());
vi.mock('../lib/platform', () => ({ desktopBridge: () => ({ openSidekicks }) }));

const owned: WorkstreamAutomationSummary = {
  id: 'owned-1', name: 'Release notes', description: 'Draft the notes.', loadable: true,
  status: 'active', updatedAt: '2026-09-09T00:00:00.000Z',
};

/** Radix needs the provider the app installs at its root; the rows use `Tip`. */
function renderSection(props: React.ComponentProps<typeof SidekickSection>) {
  return render(<Tooltip.Provider><SidekickSection {...props} /></Tooltip.Provider>);
}

describe('SidekickSection', () => {
  it('opens a row, notes what is true of it, and separates removal', () => {
    const remove = vi.fn();
    renderSection({ items: [
      { id: 'one', name: 'Editor', description: 'Review wording', note: 'Unavailable', onRemove: remove },
    ] });
    expect(screen.getByText('Unavailable · Review wording')).toBeVisible();
    const row = screen.getByRole('button', { name: 'Editor' });
    expect(row).not.toHaveClass('sidekick-section-remove');
    // Compact drops every title in this rail, so the row has to carry a mark.
    expect(row.querySelector('.workstream-context-mark .automation-glyph')).not.toBeNull();
    fireEvent.click(row);
    expect(openSidekicks).toHaveBeenCalledWith('one');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Editor' }));
    expect(remove).toHaveBeenCalledOnce();
  });

  it('keeps a row that cannot be detached free of a remove control', () => {
    renderSection({ items: [{ id: 'one', name: 'Editor', description: 'Review wording' }] });
    expect(screen.queryByRole('button', { name: 'Remove Editor' })).toBeNull();
  });

  it('leaves no heading behind for an empty answer or a pending one, and surfaces read failures', () => {
    const { rerender } = renderSection({ items: [] });
    expect(screen.queryByRole('heading', { name: 'Sidekicks' })).toBeNull();
    rerender(<Tooltip.Provider><SidekickSection /></Tooltip.Provider>);
    expect(screen.queryByRole('heading', { name: 'Sidekicks' })).toBeNull();
    rerender(<Tooltip.Provider><SidekickSection items={[]} error="Could not load Sidekicks" /></Tooltip.Provider>);
    expect(screen.getByText('Could not load Sidekicks')).toBeVisible();
  });
});

describe('workstreamSidekickRows', () => {
  it('waits for both answers before claiming the room has any', () => {
    expect(workstreamSidekickRows({ owned: undefined, attached: [] })).toBeUndefined();
    expect(workstreamSidekickRows({ owned: [], attached: undefined })).toBeUndefined();
    expect(workstreamSidekickRows({ owned: [], attached: [] })).toEqual([]);
  });

  it('puts the room’s own first and keeps the attachments it does not own', () => {
    const rows = workstreamSidekickRows({
      owned: [owned, { ...owned, id: 'owned-2', name: 'Standup digest', status: 'paused' }],
      attached: [{ id: 'attached-1', name: 'Editor', description: 'Review wording', available: false }],
    });
    expect(rows?.map((row) => [row.id, row.note])).toEqual([
      ['owned-1', undefined], ['owned-2', 'Paused'], ['attached-1', 'Unavailable'],
    ]);
  });

  it('draws one row for a Sidekick the room owns and has also loaded', () => {
    const onRemoveAttachment = vi.fn();
    const rows = workstreamSidekickRows({
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
      owned: [],
      attached: [{ id: 'attached-1', name: 'Editor', description: 'Review wording', available: true }],
    });
    expect(rows?.[0]?.onRemove).toBeUndefined();
  });
});
