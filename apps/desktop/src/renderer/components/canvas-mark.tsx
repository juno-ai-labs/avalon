import { PALETTE_RING, type CanvasArtifactKind, type WorkstreamAppearance } from '@rally/contracts';
import { IdentityTile } from '@rally/ui/components/identity-tile';
import { WORKSTREAM_ICON_COMPONENTS } from '@rally/ui/components/workstream-glyph';
import { markColors } from '@rally/ui/lib/project-palette';
import { Archive, FileText, Globe, PanelsTopLeft, type LucideIcon } from 'lucide-react';

/** What the sheet holds: its newest artifact's kind, or an empty layout while it is only its Chat. */
const KIND_ICON = { file: FileText, site: Globe, archive: Archive, chat: PanelsTopLeft } as const;

/**
 * A Canvas's default hue: one of the project palette's pastel hues, stable for
 * its id, the way a person's accent is chosen from theirs. design.html §1
 * colours each Canvas on its own; somebody may choose another
 * (`appearance.color`), and this is what an unchosen one wears.
 */
export function canvasHue(id: string): (typeof PALETTE_RING)[number] {
  const hash = [...id].reduce((total, character) => total + character.charCodeAt(0), 0);
  return PALETTE_RING[hash % PALETTE_RING.length]!;
}

/**
 * What a Canvas is drawn in: the icon and colour somebody chose, else its
 * newest artifact's kind and its id's hue, field by field. A caller with no
 * Canvas id (a list that names none) gets the cyan pair.
 */
export function canvasMark(id: string | undefined, kind: CanvasArtifactKind | null, appearance?: WorkstreamAppearance | undefined): {
  icon: LucideIcon; ink: string; tint: string;
} {
  const { ink, tint } = markColors(appearance?.color ?? (id ? canvasHue(id) : 'cyan'));
  return { icon: appearance?.icon ? WORKSTREAM_ICON_COMPONENTS[appearance.icon] : KIND_ICON[kind ?? 'chat'], ink, tint };
}

/**
 * A Canvas's mark: the page outline every artifact tile uses, holding its
 * chosen icon or what its newest artifact is, in its pastel pair through
 * `markColors`, the mechanism a Sidekick's hexagon uses, so both appearances
 * are themed.
 */
export function CanvasMark({ id, kind, size, appearance }: {
  id?: string;
  kind: CanvasArtifactKind | null;
  size?: number;
  appearance?: WorkstreamAppearance | undefined;
}): React.JSX.Element {
  const { icon, ink, tint } = canvasMark(id, kind, appearance);
  return <IdentityTile icon={icon} ink={ink} shape="sheet" size={size} tint={tint} />;
}
