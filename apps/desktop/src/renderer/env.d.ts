/// <reference types="vite/client" />

import type { RallyDesktopBridge } from '../common/desktop';

declare global {
  interface Window {
    rally?: RallyDesktopBridge;
  }

  /**
   * `sinkId` reached `AudioContextOptions` in Chromium 110 and is not yet in
   * TypeScript's DOM library. `{ type: 'none' }` renders a graph without
   * opening an output device, which is what a context that only listens
   * wants. Engines without the member ignore it.
   */
  interface AudioContextOptions {
    sinkId?: string | { type: 'none' };
  }
}

export {};
