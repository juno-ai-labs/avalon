import type { MobileCommand } from './protocol';

export type SidebarDrop = { section: 'pins'; index: number } | { section: 'canvases' };

/** A drop changes pin membership/order, never the canvas directory itself. */
export function sidebarDropCommand(pins: string[], id: string, target: SidebarDrop | null): MobileCommand | null {
  if (!target) return null;
  const from = pins.indexOf(id);
  if (target.section === 'canvases') return from < 0 ? null : { type: 'pin', id, pinned: false };
  const index = Math.max(0, Math.min(pins.length, target.index));
  const ids = pins.filter((pin) => pin !== id);
  const to = index - (from >= 0 && from < index ? 1 : 0);
  if (from < 0) return { type: 'pin', id, pinned: true, ...(ids[to] ? { beforeId: ids[to] } : {}) };
  ids.splice(to, 0, id);
  return ids.every((pin, i) => pin === pins[i]) ? null : { type: 'reorder', ids };
}
