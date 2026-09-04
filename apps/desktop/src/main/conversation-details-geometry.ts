import type { Rectangle } from 'electron';

/** The panel owns only the width it added, never a snapshot of user geometry. */
export function conversationDetailsGeometry(
  bounds: Rectangle,
  workArea: Rectangle,
  addedWidth: number,
  requestedWidth: number,
  minimumWidth: number,
  previousAppliedWidth = bounds.width,
): { bounds: Rectangle; addedWidth: number } {
  // Like GrokBot, a manual resize takes ownership of the width. Closing the
  // inspector must not undo it; moving the window alone still permits shrink.
  if (bounds.width !== previousAppliedWidth) addedWidth = 0;
  const baseWidth = Math.max(minimumWidth, bounds.width - addedWidth);
  const width = Math.min(workArea.width, baseWidth + Math.round(requestedWidth));
  const x = Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width));
  return {
    bounds: { ...bounds, x, width },
    addedWidth: Math.max(0, width - baseWidth),
  };
}
