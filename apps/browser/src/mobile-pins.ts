import type { MobileCommand } from '../../mobile/src/protocol';

type PinApi = {
  setCanvasPinned: (id: string, pinned: boolean) => Promise<void>;
  reorderCanvasPins: (ids: string[]) => Promise<void>;
};

/** The existing pin endpoint appends; save membership before positioning it. */
export async function writeMobilePins(api: PinApi, pins: string[], command: Extract<MobileCommand, { type: 'pin' | 'reorder' }>): Promise<void> {
  if (command.type === 'reorder') return api.reorderCanvasPins(command.ids);
  await api.setCanvasPinned(command.id, command.pinned);
  if (!command.pinned || !command.beforeId || command.beforeId === command.id) return;
  const ids = pins.filter((id) => id !== command.id);
  const before = ids.indexOf(command.beforeId);
  if (before < 0) return;
  ids.splice(before, 0, command.id);
  await api.reorderCanvasPins(ids);
}
