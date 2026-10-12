import { describe, expect, it } from 'vitest';
import { mainWindowTrafficLightPosition } from './main-window-chrome';

describe('mainWindowTrafficLightPosition', () => {
  it('centers the larger macOS 26 buttons over the section switcher', () => {
    expect(mainWindowTrafficLightPosition('27.0')).toEqual({ x: 8, y: 17 });
    expect(mainWindowTrafficLightPosition('26.1')).toEqual({ x: 8, y: 17 });
  });

  it('centers the smaller buttons of earlier macOS', () => {
    expect(mainWindowTrafficLightPosition('15.6.1')).toEqual({ x: 12, y: 17 });
    expect(mainWindowTrafficLightPosition('')).toEqual({ x: 12, y: 17 });
  });
});
