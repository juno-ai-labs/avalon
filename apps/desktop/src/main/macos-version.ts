/**
 * The macOS major version from `process.getSystemVersion()`, or 0 when the
 * string cannot be read, so a version gate falls back to older behaviour.
 *
 * Takes the version string rather than reading it, both so each gate is
 * testable and because `process.getSystemVersion` exists only in Electron's
 * main process.
 */
export function macosMajorVersion(systemVersion: string): number {
  const major = Number.parseInt(systemVersion.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : 0;
}
