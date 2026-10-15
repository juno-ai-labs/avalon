import type { Rectangle } from 'electron';

/**
 * The panel owns only the width it added and the distance it moved the window
 * left to fit that width on screen, never a snapshot of user geometry.
 */
export function conversationDetailsGeometry(
  bounds: Rectangle,
  workArea: Rectangle,
  addedWidth: number,
  requestedWidth: number,
  minimumWidth: number,
  previousAppliedWidth = bounds.width,
  shiftedLeft = 0,
  previousAppliedX = bounds.x,
): { bounds: Rectangle; addedWidth: number; shiftedLeft: number } {
  // Like GrokBot, a manual resize takes ownership of the width. Closing the
  // inspector must not undo it; moving the window alone still permits shrink.
  if (bounds.width !== previousAppliedWidth) addedWidth = 0;
  // A window the person moved or resized is where they put it: closing the
  // panel shrinks it in place rather than sliding it back.
  if (bounds.width !== previousAppliedWidth || bounds.x !== previousAppliedX) shiftedLeft = 0;
  const baseWidth = Math.max(minimumWidth, bounds.width - addedWidth);
  const baseX = bounds.x + shiftedLeft;
  const width = Math.min(workArea.width, baseWidth + Math.round(requestedWidth));
  const x = Math.max(workArea.x, Math.min(baseX, workArea.x + workArea.width - width));
  return {
    bounds: { ...bounds, x, width },
    addedWidth: Math.max(0, width - baseWidth),
    shiftedLeft: Math.max(0, baseX - x),
  };
}
