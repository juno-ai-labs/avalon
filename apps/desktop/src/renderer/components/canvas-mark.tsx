import type { CanvasArtifactKind, PaletteKey } from '@rally/contracts';
import { IdentityTile } from '@rally/ui/components/identity-tile';
import { markColors } from '@rally/ui/lib/project-palette';
import { Archive, FileText, Globe, PanelsTopLeft } from 'lucide-react';

/**
 * Each kind's glyph and hue. design.html §1 and §2 tint a Canvas's sheet by
 * what it holds, in the project palette's pastel pairs (a document violet, a
 * page blue, a bundle amber), and §5 switches the same marks to their dark
 * pairs; a Canvas that is only its Chat so far takes cyan.
 */
const KIND_MARK: Record<CanvasArtifactKind | 'chat', { icon: typeof FileText; hue: PaletteKey }> = {
  file: { icon: FileText, hue: 'violet' },
  site: { icon: Globe, hue: 'blue' },
  archive: { icon: Archive, hue: 'amber' },
  chat: { icon: PanelsTopLeft, hue: 'cyan' },
};

/**
 * A Canvas's mark: the page outline every artifact tile uses, holding what its
 * newest artifact is, or an empty layout while it has none, in that kind's
 * pastel pair, the same `markColors` a Sidekick's hexagon takes.
 */
export function CanvasMark({ kind, size }: { kind: CanvasArtifactKind | null; size?: number }): React.JSX.Element {
  const mark = KIND_MARK[kind ?? 'chat'];
  const { ink, tint } = markColors(mark.hue);
  return <IdentityTile icon={mark.icon} ink={ink} shape="sheet" size={size} tint={tint} />;
}
