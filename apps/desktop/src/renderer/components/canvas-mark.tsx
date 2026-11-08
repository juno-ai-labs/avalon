import { PALETTE_RING, type CanvasArtifactKind } from '@rally/contracts';
import { IdentityTile } from '@rally/ui/components/identity-tile';
import { markColors } from '@rally/ui/lib/project-palette';
import { Archive, FileText, Globe, PanelsTopLeft } from 'lucide-react';

/** What the sheet holds: its newest artifact's kind, or an empty layout while it is only its Chat. */
const KIND_ICON = { file: FileText, site: Globe, archive: Archive, chat: PanelsTopLeft } as const;

/**
 * A Canvas's hue: one of the project palette's pastel hues, stable for its id,
 * the way a person's accent is chosen from theirs. design.html §1 colours each
 * Canvas on its own, and a Canvas stores no colour, so the id decides.
 */
export function canvasHue(id: string): (typeof PALETTE_RING)[number] {
  const hash = [...id].reduce((total, character) => total + character.charCodeAt(0), 0);
  return PALETTE_RING[hash % PALETTE_RING.length]!;
}

/**
 * A Canvas's mark: the page outline every artifact tile uses, holding what its
 * newest artifact is, in the Canvas's own pastel pair through `markColors`, the
 * mechanism a Sidekick's hexagon uses, so both appearances are themed. A
 * caller with no Canvas id (a list that names none) gets the cyan pair.
 */
export function CanvasMark({ id, kind, size }: { id?: string; kind: CanvasArtifactKind | null; size?: number }): React.JSX.Element {
  const { ink, tint } = markColors(id ? canvasHue(id) : 'cyan');
  return <IdentityTile icon={KIND_ICON[kind ?? 'chat']} ink={ink} shape="sheet" size={size} tint={tint} />;
}
