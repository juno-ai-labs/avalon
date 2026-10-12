/**
 * The width of the renderer's section switcher, `.navigation-rail` in
 * `packages/ui/src/styles/app.css`, hairline border included. The main window
 * centers its traffic lights over it, so the two move together.
 */
const NAVIGATION_RAIL_WIDTH = 76;

/**
 * Where the main window's traffic lights sit: centered over the section
 * switcher, with the same gap on each side. macOS 26 drew larger buttons, so
 * the group is 60pt wide there (three 14pt buttons, 9pt apart) and 52pt
 * before (three 12pt buttons, 8pt apart).
 *
 * Takes the version string rather than reading it, both so each size is
 * testable and because `process.getSystemVersion` exists only in Electron's
 * main process.
 */
export function mainWindowTrafficLightPosition(systemVersion: string): { x: number; y: number } {
  const major = Number.parseInt(systemVersion.split('.')[0] ?? '', 10);
  const groupWidth = Number.isFinite(major) && major >= 26 ? 60 : 52;
  return { x: Math.round((NAVIGATION_RAIL_WIDTH - groupWidth) / 2), y: 17 };
}
