import { isConfiguredRegion } from "@rally/contracts/regions";
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
import { desktopWorkspaceIdentityKey } from '../common/desktop';

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

const storedWorkspaceReferenceSchema = z.object({
  workspaceId: IdSchema,
  region: RegionSchema,
});

const storedAuthSetSchema = z.object({
  version: z.literal(2),
  account: storedAuthSchema.nullable(),
  workspaces: z.array(storedAuthSchema),
  activeWorkspace: storedWorkspaceReferenceSchema.nullable(),
  /** Newest first; entries absent from this list retain discovery order. */
  workspaceRecency: z.array(storedWorkspaceReferenceSchema),
}).superRefine((value, context) => {
  const workspaceReferences = value.workspaces.map((auth) => ({
    workspaceId: auth.binding.workspaceId,
    region: auth.binding.region,
  }));
  if (value.account?.binding.workspaceId !== null && value.account !== null) {
    context.addIssue({ code: 'custom', path: ['account'], message: 'must be identity-scoped' });
  }
  if (value.account !== null && value.account.binding.region !== 'global') {
    context.addIssue({ code: 'custom', path: ['account'], message: 'must use the Global identity route' });
  }
  if (workspaceReferences.some(({ workspaceId }) => workspaceId === null)) {
    context.addIssue({ code: 'custom', path: ['workspaces'], message: 'must be workspace-scoped' });
  }
  const keys = workspaceReferences
    .filter((reference): reference is { workspaceId: string; region: Region } => reference.workspaceId !== null)
    .map((reference) => workspaceReferenceKey(reference));
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', path: ['workspaces'], message: 'must be unique by region and workspace' });
  }
  if (value.activeWorkspace !== null && !keys.includes(workspaceReferenceKey(value.activeWorkspace))) {
    context.addIssue({ code: 'custom', path: ['activeWorkspace'], message: 'must name a stored workspace' });
  }
  const recencyKeys = value.workspaceRecency.map((reference) => workspaceReferenceKey(reference));
  if (new Set(recencyKeys).size !== value.workspaceRecency.length
    || recencyKeys.some((key) => !keys.includes(key))) {
    context.addIssue({ code: 'custom', path: ['workspaceRecency'], message: 'must contain unique stored workspaces' });
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
  const keys = value.workspaces.map((profile) => profile.workspace
    ? workspaceReferenceKey({ workspaceId: profile.workspace.id, region: profile.workspace.region })
    : null);
  if (keys.some((key) => key === null) || new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', path: ['workspaces'], message: 'must be unique workspace profiles' });
  }
});

export type StoredAuth = z.infer<typeof storedAuthSchema>;
export type StoredProfile = z.infer<typeof storedProfileSchema>;
export type StoredWorkspaceReference = z.infer<typeof storedWorkspaceReferenceSchema>;
export type StoredAuthSet = z.infer<typeof storedAuthSetSchema>;
export type StoredProfileSet = z.infer<typeof storedProfileSetSchema>;

export function parseStoredAuth(value: unknown): StoredAuth | null {
  const parsed = storedAuthSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function workspaceReferenceKey(reference: StoredWorkspaceReference): string {
  return desktopWorkspaceIdentityKey(reference.region, reference.workspaceId);
}

function workspaceReferenceMatches(
  reference: StoredWorkspaceReference | null,
  workspaceId: string,
  region: Region,
): boolean {
  return reference?.workspaceId === workspaceId && reference.region === region;
}

export function parseStoredProfile(value: unknown): StoredProfile | null {
  const parsed = storedProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Read v2 directly or losslessly wrap the one credential an earlier build wrote. */
export function parseStoredAuthSet(value: unknown): StoredAuthSet | null {
  const current = storedAuthSetSchema.safeParse(value);
  if (current.success) {
    const auth = current.data;
    return {
      ...auth,
      workspaces: auth.workspaces.filter((entry) => isConfiguredRegion(entry.binding.region)),
      workspaceRecency: auth.workspaceRecency.filter((entry) => isConfiguredRegion(entry.region)),
      activeWorkspace: auth.activeWorkspace && isConfiguredRegion(auth.activeWorkspace.region) ? auth.activeWorkspace : null,
    };
  }
  const legacy = storedAuthSchema.safeParse(value);
  if (!legacy.success || !isConfiguredRegion(legacy.data.binding.region)) return null;
  const workspaceId = legacy.data.binding.workspaceId;
  return {
    version: 2,
    account: workspaceId === null ? legacy.data : null,
    workspaces: workspaceId === null ? [] : [legacy.data],
    activeWorkspace: workspaceId === null ? null : { workspaceId, region: legacy.data.binding.region },
    workspaceRecency: workspaceId === null ? [] : [{ workspaceId, region: legacy.data.binding.region }],
  };
}

/** Read v2 directly or losslessly wrap the disposable v1 profile cache. */
export function parseStoredProfileSet(value: unknown): StoredProfileSet | null {
  const current = storedProfileSetSchema.safeParse(value);
  if (current.success) return {
    ...current.data,
    workspaces: current.data.workspaces.filter((profile) => profile.workspace && isConfiguredRegion(profile.workspace.region)),
  };
  const legacy = storedProfileSchema.safeParse(value);
  if (!legacy.success || (legacy.data.workspace && !isConfiguredRegion(legacy.data.workspace.region))) return null;
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
  if (auth.activeWorkspace !== null) {
    return auth.workspaces.find((candidate) => (
      candidate.binding.workspaceId === auth.activeWorkspace?.workspaceId
      && candidate.binding.region === auth.activeWorkspace.region
    )) ?? null;
  }
  return auth.account ?? auth.workspaces[0] ?? null;
}

export function activeStoredWorkspaceCredential(
  auth: StoredAuthSet,
  workspaceId: string,
  region: Region,
): StoredAuth | null {
  if (!workspaceReferenceMatches(auth.activeWorkspace, workspaceId, region)) return null;
  const active = activeStoredCredential(auth);
  return active?.binding.workspaceId === workspaceId && active.binding.region === region ? active : null;
}

export function storedWorkspaceCredential(
  auth: StoredAuthSet,
  workspaceId: string,
  region: Region,
): StoredAuth | null {
  return auth.workspaces.find((candidate) => (
    candidate.binding.workspaceId === workspaceId && candidate.binding.region === region
  )) ?? null;
}

export function storedProfileForCredential(
  profiles: StoredProfileSet,
  auth: StoredAuth,
): StoredProfile | null {
  if (auth.binding.workspaceId === null) return profiles.account;
  return profiles.workspaces.find((candidate) => (
    candidate.workspace?.id === auth.binding.workspaceId
    && candidate.workspace.region === auth.binding.region
  )) ?? null;
}

export function selectStoredWorkspace(auth: StoredAuthSet, workspaceId: string, region: Region): StoredAuthSet {
  if (!storedWorkspaceCredential(auth, workspaceId, region)) {
    throw new Error('The selected workspace credential is not stored');
  }
  const selected = { workspaceId, region };
  return {
    ...auth,
    activeWorkspace: selected,
    workspaceRecency: [
      selected,
      ...auth.workspaceRecency.filter((candidate) => !workspaceReferenceMatches(candidate, workspaceId, region)),
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
    activeWorkspace: null,
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
    ...auth.workspaces.filter((candidate) => (
      candidate.binding.workspaceId !== workspaceId || candidate.binding.region !== region
    )),
    credential,
  ];
  const workspaceProfiles = [
    ...profiles.workspaces.filter((candidate) => (
      candidate.workspace?.id !== workspaceId || candidate.workspace.region !== region
    )),
    profile,
  ];
  const activate = options.activate ?? true;
  const reference = { workspaceId, region };
  return {
    auth: {
      ...auth,
      workspaces,
      activeWorkspace: activate ? reference : auth.activeWorkspace,
      workspaceRecency: activate
        ? [reference, ...auth.workspaceRecency.filter((candidate) => (
          !workspaceReferenceMatches(candidate, workspaceId, region)
        ))]
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
  region: Region,
): { auth: StoredAuthSet; profiles: StoredProfileSet } {
  const workspaces = auth.workspaces.filter((candidate) => (
    candidate.binding.workspaceId !== workspaceId || candidate.binding.region !== region
  ));
  const workspaceKeys = new Set(workspaces.map((candidate) => workspaceReferenceKey({
    workspaceId: candidate.binding.workspaceId!,
    region: candidate.binding.region,
  })));
  const workspaceRecency = auth.workspaceRecency.filter((candidate) => workspaceKeys.has(workspaceReferenceKey(candidate)));
  const activeWorkspace = workspaceReferenceMatches(auth.activeWorkspace, workspaceId, region)
    ? workspaceRecency[0] ?? (workspaces[0]
      ? { workspaceId: workspaces[0].binding.workspaceId!, region: workspaces[0].binding.region }
      : null)
    : auth.activeWorkspace;
  return {
    auth: { ...auth, workspaces, activeWorkspace, workspaceRecency },
    profiles: {
      ...profiles,
      workspaces: profiles.workspaces.filter((candidate) => (
        candidate.workspace?.id !== workspaceId || candidate.workspace.region !== region
      )),
    },
  };
}
