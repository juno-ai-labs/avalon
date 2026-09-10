import { IdSchema } from '@rally/contracts';

/**
 * The composer, as a Sidekicks-window target.
 *
 * Every other target is a stored Sidekick's id, and this one deliberately is
 * not: no Sidekick exists until the screen this route opens creates one. The
 * value is the route segment the renderer already matches — `/sidekicks/new` —
 * so all three processes name the composer the same way and main has no second
 * spelling to translate into a route.
 */
export const NEW_SIDEKICK_TARGET = 'new';

/**
 * One target the Sidekicks window may open on, or `null` for anything else.
 *
 * A target becomes that window's route, so main parses what a renderer asked
 * for through this rather than trusting it — the boundary
 * `parseDesktopSettingsSection` holds for the settings window, for the same
 * reason. Accepting the composer here is what keeps `IdSchema` strict
 * everywhere else: the alternative, loosening the id check to let `new`
 * through, would let any string reach the window's hash.
 */
export function parseSidekicksWindowTarget(value: unknown): string | null {
  if (value === NEW_SIDEKICK_TARGET) return NEW_SIDEKICK_TARGET;
  const sidekickId = IdSchema.safeParse(value);
  return sidekickId.success ? sidekickId.data : null;
}
