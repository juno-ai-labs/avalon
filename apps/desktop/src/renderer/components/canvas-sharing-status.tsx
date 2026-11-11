import type { CanvasSummary } from '@rally/contracts';

import { CANVAS_VISIBILITY_OPTIONS } from '../lib/canvas-sharing';

/** The sharing setting, including the writer Sidekick's inherited audience. */
export function CanvasSharingStatus({ canvas, currentUserId }: {
  canvas: Pick<CanvasSummary, 'visibility' | 'createdByUserId' | 'writerSidekickId'>;
  currentUserId: string | undefined;
}): React.JSX.Element {
  const option = CANVAS_VISIBILITY_OPTIONS[canvas.visibility];
  const inherited = canvas.writerSidekickId !== null && canvas.visibility !== 'workspace';
  const creator = canvas.createdByUserId === currentUserId;
  const Icon = inherited ? CANVAS_VISIBILITY_OPTIONS.participants.icon : option.icon;
  const text = inherited
    ? `${canvas.visibility === 'participants' ? 'Specific people' : creator ? 'You' : 'Creator'} and the Sidekick's audience`
    : canvas.visibility === 'creator' && creator ? 'Only you' : option.label;
  return <span className="canvas-sharing-status" title={text}>
    <Icon aria-hidden="true" size={14} stroke={1.8} />
    <span>{text}</span>
  </span>;
}
