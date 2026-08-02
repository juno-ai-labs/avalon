/// <reference types="vite/client" />

import type { AvalonDesktopBridge } from '../common/desktop';

declare global {
  interface Window {
    avalon?: AvalonDesktopBridge;
  }
}

export {};
