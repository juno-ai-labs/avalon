import { MobileCrashPayloadSchema } from '@rally/contracts/crash-reports';

/** Deliberately unsymbolicated until the matching private dSYM/source map is
 * available. No raw exception text, source URL or customer data leaves R2. */
export function mobileCrashSummary(value: unknown) {
  const payload = MobileCrashPayloadSchema.parse(value);
  if (payload.kind === 'ios-native') return {
    crash_type: payload.signal,
    mechanism: 'ios_plcrashreporter',
    threads: payload.threads.map((thread) => ({
      crashed: thread.crashed,
      frames: thread.frames.map((frame) => ({
        module: frame.imageUUID.toLowerCase(), function: `offset_${frame.offset.toLowerCase()}`,
      })),
    })),
  };
  // Hermes release stacks use address at function (address at …:line:column).
  // Keep numeric coordinates only. Debug URLs and error messages are raw data.
  const frames = [...payload.report.matchAll(/(?:^|\n).*?:(\d+):(\d+)\)?\s*(?=\n|$)/gu)]
    .map((match) => ({ module: payload.updateId ?? 'embedded', function: `hermes_${match[1]}_${match[2]}` }));
  return {
    crash_type: payload.fatal ? 'javascript_fatal' : 'react_render_failed',
    mechanism: 'hermes', handled: !payload.fatal, threads: [{ crashed: true, frames }],
  };
}
