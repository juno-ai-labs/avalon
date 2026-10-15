import { describe, expect, it } from 'vitest';
import { conversationDetailsGeometry } from './conversation-details-geometry';

const area = { x: 0, y: 0, width: 1800, height: 1200 };
const initial = { x: 100, y: 50, width: 900, height: 700 };

describe('conversation details geometry', () => {
  it('adjusts an already-open rail by its width difference', () => {
    const opened = conversationDetailsGeometry(initial, area, 0, 300, 600);
    const resized = conversationDetailsGeometry(opened.bounds, area, opened.addedWidth, 420, 600);
    expect(resized.bounds.width).toBe(1320);
    expect(resized.addedWidth).toBe(420);
  });

  it('closes against current user-moved and resized bounds, not an old snapshot', () => {
    const moved = { x: 200, y: 150, width: 1400, height: 800 };
    expect(conversationDetailsGeometry(moved, area, 300, 0, 600, 1200).bounds).toEqual(moved);
    expect(conversationDetailsGeometry(moved, area, 300, 0, 600, 1400).bounds)
      .toEqual({ ...moved, width: 1100 });
  });

  it('removes only the expansion actually available on the display', () => {
    const opened = conversationDetailsGeometry({ ...initial, width: 1700 }, area, 0, 400, 600);
    expect(opened.addedWidth).toBe(100);
    expect(conversationDetailsGeometry(opened.bounds, area, opened.addedWidth, 0, 600).bounds.width).toBe(1700);
  });

  it('puts the window back where it was when closing undoes the move that made room', () => {
    const right = { x: 1000, y: 50, width: 700, height: 700 };
    const opened = conversationDetailsGeometry(right, area, 0, 600, 600);
    expect(opened.bounds).toEqual({ ...right, x: 500, width: 1300 });
    const closed = conversationDetailsGeometry(
      opened.bounds, area, opened.addedWidth, 0, 600, opened.bounds.width, opened.shiftedLeft, opened.bounds.x,
    );
    expect(closed.bounds).toEqual(right);
  });

  it('leaves a window the person moved while the panel was open where they put it', () => {
    const right = { x: 1000, y: 50, width: 700, height: 700 };
    const opened = conversationDetailsGeometry(right, area, 0, 600, 600);
    const moved = { ...opened.bounds, x: 300 };
    const closed = conversationDetailsGeometry(
      moved, area, opened.addedWidth, 0, 600, opened.bounds.width, opened.shiftedLeft, opened.bounds.x,
    );
    expect(closed.bounds).toEqual({ ...moved, width: 700 });
  });
});
