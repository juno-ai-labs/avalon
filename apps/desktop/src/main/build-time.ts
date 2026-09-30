declare const __RALLY_BUILD_TIME__: string | undefined;

/**
 * When electron-vite built the main process, in epoch milliseconds, or
 * undefined where no build stamped it (unit tests). The updater uses it to
 * tell how long this copy has gone without updating.
 */
export function rallyBuildTime(): number | undefined {
  if (typeof __RALLY_BUILD_TIME__ !== 'string') return undefined;
  const parsed = Date.parse(__RALLY_BUILD_TIME__);
  return Number.isNaN(parsed) ? undefined : parsed;
}
