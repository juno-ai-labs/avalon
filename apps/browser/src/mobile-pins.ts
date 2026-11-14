import type { MobileCommand } from '../../mobile/src/protocol';

type PinApi = {
  setCanvasPinned: (id: string, pinned: boolean) => Promise<void>;
  reorderCanvasPins: (ids: string[]) => Promise<void>;
};

export class PinPlacementError extends Error {
  constructor(cause: unknown) {
    super('Canvas pinned, but its position could not be saved.', { cause });
    this.name = 'PinPlacementError';
  }
}

/** The existing pin endpoint appends; save membership before positioning it. */
export async function writeMobilePins(api: PinApi, pins: string[], command: Extract<MobileCommand, { type: 'pin' | 'reorder' }>): Promise<void> {
  if (command.type === 'reorder') return api.reorderCanvasPins(command.ids);
  await api.setCanvasPinned(command.id, command.pinned);
  if (!command.pinned || !command.beforeId) return;
  const ids = pins.filter((id) => id !== command.id);
  const before = ids.indexOf(command.beforeId);
  if (before < 0) return;
  ids.splice(before, 0, command.id);
  try { await api.reorderCanvasPins(ids); } catch (cause) { throw new PinPlacementError(cause); }
}
