import {
  IdSchema,
  RefreshTokenSchema,
  RegionSchema,
  TimestampSchema,
  UserSchema,
  WorkspaceSchema,
  type Region,
  type Session,
} from '@rally/contracts';
import { z } from 'zod';

const storedAuthSchema = z.object({
  version: z.literal(1),
  accessToken: z.string().min(20),
  refreshToken: RefreshTokenSchema,
  expiresAt: TimestampSchema,
  binding: z.object({
    userId: IdSchema,
    workspaceId: IdSchema.nullable(),
    region: RegionSchema,
  }),
});

const storedProfileSchema = z.object({
  version: z.literal(1),
  cachedAt: TimestampSchema,
  user: UserSchema,
  workspace: WorkspaceSchema.nullable(),
});

export type StoredAuth = z.infer<typeof storedAuthSchema>;
export type StoredProfile = z.infer<typeof storedProfileSchema>;

export function parseStoredAuth(value: unknown): StoredAuth | null {
  const parsed = storedAuthSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseStoredProfile(value: unknown): StoredProfile | null {
  const parsed = storedProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function storedAuthFromSession(session: Session, region: Region): StoredAuth {
  return {
    version: 1,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
    binding: {
      userId: session.user.id,
      workspaceId: session.workspace?.id ?? null,
      region,
    },
  };
}

export function storedProfileFromSession(
  session: Session,
  cachedAt = new Date().toISOString(),
): StoredProfile {
  return {
    version: 1,
    cachedAt,
    user: session.user,
    workspace: session.workspace,
  };
}

export function sessionFromStoredState(
  auth: StoredAuth,
  profile: StoredProfile,
  apiBaseUrl: string,
): Session | null {
  const workspaceId = profile.workspace?.id ?? null;
  if (
    profile.user.id !== auth.binding.userId
    || workspaceId !== auth.binding.workspaceId
    || (profile.workspace !== null && profile.workspace.region !== auth.binding.region)
    || (profile.workspace === null && auth.binding.region !== 'global')
  ) {
    return null;
  }
  return {
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    expiresAt: auth.expiresAt,
    user: profile.user,
    workspace: profile.workspace,
    apiBaseUrl,
  };
}

export function sessionsShareBinding(session: Session, auth: StoredAuth): boolean {
  return session.user.id === auth.binding.userId
    && (session.workspace?.id ?? null) === auth.binding.workspaceId
    && (session.workspace?.region ?? 'global') === auth.binding.region;
}
