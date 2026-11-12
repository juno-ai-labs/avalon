import type { CanvasArtifactVisibility, CanvasVisibility } from '@rally/contracts';
import { IconBuilding, IconLock, IconUsers, IconWorld } from '@tabler/icons-react';

/** The audience choices shared by the Share panel and Canvas list rows. */
export const CANVAS_VISIBILITY_OPTIONS = {
  creator: { icon: IconLock, label: 'Only the creator', description: 'Nobody else can open it.' },
  participants: { icon: IconUsers, label: 'Specific people', description: 'The people chosen below, guests among them.' },
  workspace: { icon: IconBuilding, label: 'Everyone in the Organization', description: 'Every member can open it, and any guests you add.' },
} satisfies Record<CanvasVisibility, { icon: typeof IconLock; label: string; description: string }>;

/**
 * Who can open a Canvas's artifacts. One setting per Canvas, read by the Share
 * panel and by every artifact card in its Chat, so the two always use the same
 * words. `short` is the card's: it sits in a row beside the artifact's title.
 */
export const ARTIFACT_VISIBILITY_OPTIONS = {
  editors: { icon: IconLock, label: 'Editors only', short: 'Editors' },
  participants: { icon: IconUsers, label: 'Specific people', short: 'People' },
  workspace: { icon: IconBuilding, label: 'Everyone in the Organization', short: 'Organization' },
  public: { icon: IconWorld, label: 'Anyone with the link', short: 'Public' },
} satisfies Record<CanvasArtifactVisibility, { icon: typeof IconLock; label: string; short: string }>;

/**
 * The editor list an audience update carries for an editor audience.
 *
 * The update replaces both audiences at once, so a change to artifact access
 * alone resends the editors through this too. An Organization-wide Canvas
 * lists only its guests: its members are editors by membership, not by name.
 */
export function editorUserIds(
  canvas: { visibility: CanvasVisibility; participantUserIds: readonly string[] },
  isGuest: (userId: string) => boolean,
): string[] {
  if (canvas.visibility === 'creator') return [];
  if (canvas.visibility === 'workspace') return canvas.participantUserIds.filter(isGuest);
  return [...canvas.participantUserIds];
}
