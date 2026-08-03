const PACIFIC_TIMEZONE = 'America/Los_Angeles';
const EU_TIMEZONE = 'Europe/London';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Adds only the timezone fields absent from pre-timezone encrypted sessions.
 * The server remains authoritative after the next refresh. */
export function normalizeLegacyStoredSession(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.user)) return value;
  const user = value.user;
  const workspace = isRecord(value.workspace) ? value.workspace : value.workspace;
  const userNeedsTimezone = typeof user.timezone !== 'string';
  const workspaceNeedsTimezone = isRecord(workspace) && typeof workspace.timezone !== 'string';

  if (!userNeedsTimezone && !workspaceNeedsTimezone) return value;

  return {
    ...value,
    user: {
      ...user,
      timezone: typeof user.timezone === 'string' ? user.timezone : PACIFIC_TIMEZONE,
    },
    workspace: isRecord(workspace)
      ? {
          ...workspace,
          timezone: typeof workspace.timezone === 'string'
            ? workspace.timezone
            : workspace.region === 'eu' ? EU_TIMEZONE : PACIFIC_TIMEZONE,
        }
      : workspace,
  };
}
