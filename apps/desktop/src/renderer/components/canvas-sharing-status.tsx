import type { CanvasSummary } from '@rally/contracts';

import { CANVAS_VISIBILITY_OPTIONS } from '../lib/canvas-sharing';

/** The configured audience, using the Share panel's labels and icons. */
export function CanvasSharingStatus({ canvas, currentUserId }: {
  canvas: Pick<CanvasSummary, 'visibility' | 'createdByUserId'>;
  currentUserId: string | undefined;
}): React.JSX.Element {
  const { icon: Icon, label } = CANVAS_VISIBILITY_OPTIONS[canvas.visibility];
  const text = canvas.visibility === 'creator' && canvas.createdByUserId === currentUserId ? 'Only you' : label;
  return <span className="canvas-sharing-status" title={text}>
    <Icon aria-hidden="true" size={14} stroke={1.8} />
    <span>{text}</span>
  </span>;
}
