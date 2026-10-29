import { describe, expect, it } from 'vitest';

import { placeAnnotationEditor } from './annotation-anchor';

const frame = { x: 760, y: 60, width: 420, height: 800 };
const viewport = { width: 1600, height: 900 };

describe('placing the comment editor beside a framed selection', () => {
  it('sits to the right of the element when the window has room', () => {
    expect(placeAnnotationEditor({ x: 20, y: 300, width: 100, height: 30 }, frame, viewport))
      .toEqual({ x: 760 + 20 + 100 + 12, y: 360 });
  });

  it('drops below the element, aligned to its left, when the right would leave the window', () => {
    expect(placeAnnotationEditor({ x: 20, y: 300, width: 100, height: 30 }, frame, { width: 1180, height: 900 }))
      .toEqual({ x: 780, y: 60 + 300 + 30 + 12 });
  });

  it('goes above the element when below would run past the frame, rather than covering it', () => {
    const short = { x: 760, y: 64, width: 416, height: 500 };
    expect(placeAnnotationEditor({ x: 20, y: 400, width: 100, height: 36 }, short, { width: 1180, height: 900 }))
      .toEqual({ x: 780, y: 64 + 400 - 12 - 160 });
  });

  it('keeps the editor inside the window and parks it at the frame edge when the element scrolled away', () => {
    expect(placeAnnotationEditor({ x: 20, y: -500, width: 100, height: 30 }, frame, viewport).y).toBe(60);
    expect(placeAnnotationEditor({ x: 20, y: 1800, width: 100, height: 30 }, frame, viewport).y).toBe(60 + 800 - 160);
    expect(placeAnnotationEditor({ x: 1000, y: 300, width: 400, height: 30 }, frame, { width: 1180, height: 900 }).x).toBe(1180 - 292 - 8);
  });
});
