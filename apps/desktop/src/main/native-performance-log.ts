import { join, resolve } from 'node:path';

import type { DesktopTelemetryRendererPerfFlowIntent } from '../common/desktop';

export interface NativeUnifiedLogBinding {
  writePerformance: (encoded: string) => void;
}

export function nativeUnifiedLogAddonPath(input: {
  currentDirectory: string;
  isPackaged: boolean;
  resourcesPath: string;
}): string {
  return input.isPackaged
    ? join(input.resourcesPath, 'native', 'unified-log.node')
    : resolve(input.currentDirectory, '../../.native-build/unified-log.node');
}

/**
 * Writes the already-governed renderer performance projection to macOS Unified
 * Logging. The operating system owns persistence and retention, and Console.app
 * reads it by subsystem `ai.rallywith.desktop` and category `performance`.
 */
export class NativePerformanceLog {
  private binding: NativeUnifiedLogBinding | null = null;
  private unavailable = false;

  constructor(
    private readonly loadBinding: () => NativeUnifiedLogBinding,
    private readonly appVersion: () => string,
    private readonly now: () => Date,
    private readonly onUnavailable: (error: unknown) => void,
  ) {}

  write(intent: DesktopTelemetryRendererPerfFlowIntent): void {
    if (this.unavailable) return;
    try {
      this.binding ??= this.loadBinding();
      this.binding.writePerformance(JSON.stringify({
        timestamp: this.now().toISOString(),
        appVersion: this.appVersion(),
        ...intent,
      }));
    } catch (error) {
      // Logging cannot change the measured operation. Stop retrying a missing
      // or incompatible native component for this process, and leave the
      // governed telemetry upload as the independent durable path.
      this.unavailable = true;
      this.binding = null;
      this.onUnavailable(error);
    }
  }
}
