import type { CanvasArtifactKind } from '@rally/contracts';
import { IdentityTile } from '@rally/ui/components/identity-tile';
import { Archive, FileText, Globe, PanelsTopLeft } from 'lucide-react';

/** A Canvas has no hue of its own, as a pinned artifact's tile has none. */
const CANVAS_TILE = { ink: 'var(--av-ref-color-neutral-11)', tint: 'var(--av-sys-color-surface-elevated-hover)' } as const;

const KIND_ICON = { file: FileText, site: Globe, archive: Archive } as const;

/**
 * A Canvas's mark: the page outline every artifact tile uses, holding what its
 * newest artifact is, or an empty layout while it has none.
 */
export function CanvasMark({ kind, size }: { kind: CanvasArtifactKind | null; size?: number }): React.JSX.Element {
  return <IdentityTile icon={kind ? KIND_ICON[kind] : PanelsTopLeft} ink={CANVAS_TILE.ink} shape="sheet" size={size} tint={CANVAS_TILE.tint} />;
}
