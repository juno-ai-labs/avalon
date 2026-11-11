import type { CanvasVisibility } from '@rally/contracts';
import { IconBuilding, IconLock, IconUsers } from '@tabler/icons-react';

/** The audience choices shared by the Share panel and Canvas list rows. */
export const CANVAS_VISIBILITY_OPTIONS = {
  creator: { icon: IconLock, label: 'Only the creator', description: 'Nobody else can open it.' },
  participants: { icon: IconUsers, label: 'Specific people', description: 'The people chosen below, guests among them.' },
  workspace: { icon: IconBuilding, label: 'Everyone in the Organization', description: 'Every member can open it, and any guests you add.' },
} satisfies Record<CanvasVisibility, { icon: typeof IconLock; label: string; description: string }>;
