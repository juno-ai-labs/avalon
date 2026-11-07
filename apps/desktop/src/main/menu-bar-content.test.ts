import { describe, expect, it } from 'vitest';
import { menuBarContent } from './menu-bar-content';
import type { ListedCanvas, ListedSidekick } from './sidebar-lists-watch';

function canvas(id: string, title: string, extra: Partial<ListedCanvas> = {}): ListedCanvas {
  return { id, title, unread: false, updatedAt: '2026-11-07T09:00:00.000Z', ...extra };
}

function sidekick(id: string, name: string, extra: Partial<ListedSidekick> = {}): ListedSidekick {
  return { id, name, needsInput: false, unread: false, ...extra };
}

describe('menu bar content', () => {
  it('lists what the rail counts: Sidekicks that need input, then unread Sidekicks and Canvases', () => {
    const content = menuBarContent({
      sidekicks: [sidekick('quiet', 'Quiet'), sidekick('fresh', 'Fresh', { unread: true }), sidekick('triage', 'Incident triage', { needsInput: true, unread: true })],
      canvases: [canvas('read', 'Read'), canvas('q4', 'Q4 review', { unread: true })],
    });
    expect(content.attention.map((row) => [row.kind, row.id, row.detail])).toEqual([
      ['sidekick', 'triage', 'Needs input'],
      ['sidekick', 'fresh', 'Unread'],
      ['canvas', 'q4', 'Unread'],
    ]);
    expect(content.attentionComplete).toBe(true);
  });

  it('lists every Canvas newest first under Recent Canvases, and names an untitled one', () => {
    const content = menuBarContent({
      sidekicks: [],
      canvases: [
        canvas('old', 'Old', { updatedAt: '2026-11-01T09:00:00.000Z' }),
        canvas('new', '  ', { updatedAt: '2026-11-07T09:00:00.000Z' }),
      ],
    });
    expect(content.recents.map((row) => [row.id, row.title])).toEqual([['new', 'Untitled'], ['old', 'Old']]);
  });

  it('is not complete until each list has arrived', () => {
    expect(menuBarContent({ canvases: null, sidekicks: [] })).toMatchObject({ attentionComplete: false, recentsComplete: false });
    expect(menuBarContent({ canvases: [], sidekicks: null })).toMatchObject({ attentionComplete: false, recentsComplete: true });
  });
});
