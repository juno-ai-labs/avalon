import { render } from '@testing-library/react';
import { MODE_DRAWS, resolvePreset, ThinkingOrb } from 'thinking-orbs';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('thinking-orbs zero-speed contract', () => {
  it('draws animation time zero without scheduling another frame when paused', () => {
    const context = {
      clearRect: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const requestFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { mode } = resolvePreset('solving', 20);
    const draw = vi.spyOn(MODE_DRAWS, mode).mockImplementation(() => undefined);

    render(
      <ThinkingOrb
        paused
        size={20}
        speed={0}
        state="solving"
        theme="dark"
      />,
    );

    expect(draw).toHaveBeenCalledWith(context, 20, 0, true, expect.any(Object));
    expect(requestFrame).not.toHaveBeenCalled();
  });
});
