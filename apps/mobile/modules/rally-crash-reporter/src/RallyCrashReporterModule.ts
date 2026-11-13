import { NativeModule, requireOptionalNativeModule } from 'expo';
import type { MobileCrashScope } from '@rally/contracts/crash-reports';

declare class RallyCrashReporterModule extends NativeModule {
  prepare(scope: MobileCrashScope): void;
  configure(scope: MobileCrashScope | null): void;
  captureJavascript(payload: string): void;
  pending(scope: MobileCrashScope): Promise<string[]>;
  acknowledge(uploadId: string): void;
}
export default requireOptionalNativeModule<RallyCrashReporterModule>('RallyCrashReporter');
