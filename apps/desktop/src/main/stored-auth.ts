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

const storedAuthSetSchema = z.object({
  version: z.literal(2),
  account: storedAuthSchema.nullable(),
  workspaces: z.array(storedAuthSchema),
  activeWorkspaceId: IdSchema.nullable(),
  /** Newest first; entries absent from this list retain discovery order. */
  workspaceRecency: z.array(IdSchema),
}).superRefine((value, context) => {
  const workspaceIds = value.workspaces.map((auth) => auth.binding.workspaceId);
  if (value.account?.binding.workspaceId !== null && value.account !== null) {
    context.addIssue({ code: 'custom', path: ['account'], message: 'must be identity-scoped' });
  }
  if (value.account?.binding.region === 'eu') {
    context.addIssue({ code: 'custom', path: ['account'], message: 'must use the Global identity route' });
  }
  if (workspaceIds.some((workspaceId) => workspaceId === null)) {
    context.addIssue({ code: 'custom', path: ['workspaces'], message: 'must be workspace-scoped' });
  }
  const ids = workspaceIds.filter((workspaceId): workspaceId is string => workspaceId !== null);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['workspaces'], message: 'must be unique by workspace' });
  }
  if (value.activeWorkspaceId !== null && !ids.includes(value.activeWorkspaceId)) {
    context.addIssue({ code: 'custom', path: ['activeWorkspaceId'], message: 'must name a stored workspace' });
  }
  if (new Set(value.workspaceRecency).size !== value.workspaceRecency.length
    || value.workspaceRecency.some((workspaceId) => !ids.includes(workspaceId))) {
    context.addIssue({ code: 'custom', path: ['workspaceRecency'], message: 'must contain unique stored workspaces' });
  }
  const userIds = [
    ...(value.account ? [value.account.binding.userId] : []),
    ...value.workspaces.map((auth) => auth.binding.userId),
  ];
  if (new Set(userIds).size > 1) {
    context.addIssue({ code: 'custom', path: [], message: 'must belong to one account' });
  }
});

const storedProfileSetSchema = z.object({
  version: z.literal(2),
  account: storedProfileSchema.nullable(),
  workspaces: z.array(storedProfileSchema),
}).superRefine((value, context) => {
  if (value.account?.workspace !== null && value.account !== null) {
    context.addIssue({ code: 'custom', path: ['account'], message: 'must be identity-scoped' });
  }
  const ids = value.workspaces.map((profile) => profile.workspace?.id ?? null);
  if (ids.some((workspaceId) => workspaceId === null) || new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['workspaces'], message: 'must be unique workspace profiles' });
  }
});

export type StoredAuth = z.infer<typeof storedAuthSchema>;
export type StoredProfile = z.infer<typeof storedProfileSchema>;
export type StoredAuthSet = z.infer<typeof storedAuthSetSchema>;
export type StoredProfileSet = z.infer<typeof storedProfileSetSchema>;

export function parseStoredAuth(value: unknown): StoredAuth | null {
  const parsed = storedAuthSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseStoredProfile(value: unknown): StoredProfile | null {
  const parsed = storedProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Read v2 directly or losslessly wrap the one credential an earlier build wrote. */
export function parseStoredAuthSet(value: unknown): StoredAuthSet | null {
  const current = storedAuthSetSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = storedAuthSchema.safeParse(value);
  if (!legacy.success) return null;
  const workspaceId = legacy.data.binding.workspaceId;
  return {
    version: 2,
    account: workspaceId === null ? legacy.data : null,
    workspaces: workspaceId === null ? [] : [legacy.data],
    activeWorkspaceId: workspaceId,
    workspaceRecency: workspaceId === null ? [] : [workspaceId],
  };
}

/** Read v2 directly or losslessly wrap the disposable v1 profile cache. */
export function parseStoredProfileSet(value: unknown): StoredProfileSet | null {
  const current = storedProfileSetSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = storedProfileSchema.safeParse(value);
  if (!legacy.success) return null;
  return {
    version: 2,
    account: legacy.data.workspace === null ? legacy.data : null,
    workspaces: legacy.data.workspace === null ? [] : [legacy.data],
  };
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

export function activeStoredCredential(auth: StoredAuthSet): StoredAuth | null {
  if (auth.activeWorkspaceId !== null) {
    return auth.workspaces.find((candidate) => (
      candidate.binding.workspaceId === auth.activeWorkspaceId
    )) ?? null;
  }
  return auth.account ?? auth.workspaces[0] ?? null;
}

export function storedWorkspaceCredential(
  auth: StoredAuthSet,
  workspaceId: string,
): StoredAuth | null {
  return auth.workspaces.find((candidate) => candidate.binding.workspaceId === workspaceId) ?? null;
}

export function storedProfileForCredential(
  profiles: StoredProfileSet,
  auth: StoredAuth,
): StoredProfile | null {
  if (auth.binding.workspaceId === null) return profiles.account;
  return profiles.workspaces.find((candidate) => (
    candidate.workspace?.id === auth.binding.workspaceId
  )) ?? null;
}

export function selectStoredWorkspace(auth: StoredAuthSet, workspaceId: string): StoredAuthSet {
  if (!auth.workspaces.some((candidate) => candidate.binding.workspaceId === workspaceId)) {
    throw new Error('The selected workspace credential is not stored');
  }
  return {
    ...auth,
    activeWorkspaceId: workspaceId,
    workspaceRecency: [
      workspaceId,
      ...auth.workspaceRecency.filter((candidate) => candidate !== workspaceId),
    ],
  };
}

/** Merge one refreshed or newly activated session without replacing its siblings. */
export function mergeStoredSession(
  currentAuth: StoredAuthSet | null,
  currentProfiles: StoredProfileSet | null,
  session: Session,
  region: Region,
  options: { activate?: boolean } = {},
): { auth: StoredAuthSet; profiles: StoredProfileSet } {
  const credential = storedAuthFromSession(session, region);
  const profile = storedProfileFromSession(session);
  const workspaceId = credential.binding.workspaceId;
  const auth: StoredAuthSet = currentAuth ?? {
    version: 2,
    account: null,
    workspaces: [],
    activeWorkspaceId: null,
    workspaceRecency: [],
  };
  const profiles: StoredProfileSet = currentProfiles ?? {
    version: 2,
    account: null,
    workspaces: [],
  };
  if (workspaceId === null) {
    return {
      auth: { ...auth, account: credential },
      profiles: { ...profiles, account: profile },
    };
  }
  const workspaces = [
    ...auth.workspaces.filter((candidate) => candidate.binding.workspaceId !== workspaceId),
    credential,
  ];
  const workspaceProfiles = [
    ...profiles.workspaces.filter((candidate) => candidate.workspace?.id !== workspaceId),
    profile,
  ];
  const activate = options.activate ?? true;
  return {
    auth: {
      ...auth,
      workspaces,
      activeWorkspaceId: activate ? workspaceId : auth.activeWorkspaceId,
      workspaceRecency: activate
        ? [workspaceId, ...auth.workspaceRecency.filter((candidate) => candidate !== workspaceId)]
        : auth.workspaceRecency,
    },
    profiles: { ...profiles, workspaces: workspaceProfiles },
  };
}

/** Remove one departed membership while preserving every other local credential. */
export function removeStoredWorkspace(
  auth: StoredAuthSet,
  profiles: StoredProfileSet,
  workspaceId: string,
): { auth: StoredAuthSet; profiles: StoredProfileSet } {
  const workspaces = auth.workspaces.filter((candidate) => candidate.binding.workspaceId !== workspaceId);
  const workspaceIds = new Set(workspaces.map((candidate) => candidate.binding.workspaceId));
  const workspaceRecency = auth.workspaceRecency.filter((candidate) => workspaceIds.has(candidate));
  const activeWorkspaceId = auth.activeWorkspaceId === workspaceId
    ? workspaceRecency[0] ?? workspaces[0]?.binding.workspaceId ?? null
    : auth.activeWorkspaceId;
  return {
    auth: { ...auth, workspaces, activeWorkspaceId, workspaceRecency },
    profiles: {
      ...profiles,
      workspaces: profiles.workspaces.filter((candidate) => candidate.workspace?.id !== workspaceId),
    },
  };
}
