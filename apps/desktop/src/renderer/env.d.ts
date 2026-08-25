/// <reference types="vite/client" />

import type { RallyDesktopBridge } from '../common/desktop';

declare global {
  interface Window {
    rally?: RallyDesktopBridge;
  }
}

export {};
