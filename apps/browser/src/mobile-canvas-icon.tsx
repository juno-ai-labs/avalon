import type { WorkstreamAppearance } from '@rally/contracts';
import { canvasMark } from '../../desktop/src/renderer/components/canvas-mark';

/** The saved glyph catalog is deferred independently of dashboard content. */
export default function MobileCanvasIcon({ id, appearance, size }: { id: string; appearance: WorkstreamAppearance; size: number }) {
  const { icon: Icon } = canvasMark(id, appearance);
  return <Icon size={size} strokeWidth={1.9} />;
}
