import {
  IdSchema,
  IanaTimezoneSchema,
  MemberRoleSchema,
  RefreshTokenSchema,
  RegionSchema,
  TimestampSchema,
  type Session,
} from '@avalon/contracts';
import { HttpUrlSchema } from '@avalon/contracts/url-schemas';
import { z } from 'zod';

const PACIFIC_TIMEZONE = 'America/Los_Angeles';
const EU_TIMEZONE = 'Europe/London';

// Persisted authentication is a compatibility boundary, not an API response.
// Keep this schema explicit so unrelated additive wire-contract changes do not
// turn a still-valid refresh credential into a sign-out after an app update.
const storedSessionSchema = z.object({
  accessToken: z.string().min(20),
  refreshToken: RefreshTokenSchema,
  expiresAt: TimestampSchema,
  user: z.object({
    id: IdSchema,
    email: z.string().email(),
    name: z.string().min(1),
    avatarUrl: HttpUrlSchema.nullable(),
    timezone: IanaTimezoneSchema,
    createdAt: TimestampSchema,
  }),
  workspace: z.object({
    id: IdSchema,
    name: z.string().min(1).max(120),
    slug: z.string().min(2).max(80),
    region: RegionSchema,
    role: MemberRoleSchema,
    timezone: IanaTimezoneSchema,
    createdAt: TimestampSchema,
  }).nullable(),
  apiBaseUrl: HttpUrlSchema,
});

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

export function parseLegacyStoredSession(value: unknown): Session | null {
  const parsed = storedSessionSchema.safeParse(normalizeLegacyStoredSession(value));
  return parsed.success ? parsed.data : null;
}
