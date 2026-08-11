import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";

/**
 * The subject a flag is being evaluated for: whatever identifiers the caller
 * happens to hold. Every field is optional because most evaluations know a
 * workspace, many also know a work stream, and only a few know a user.
 */
export interface FlagTargetingSubject {
  workspaceId?: string | undefined;
  workstreamId?: string | undefined;
  userId?: string | undefined;
}

/**
 * What a Flagship targeting rule may match on beyond the identifiers. Flagship
 * accepts strings, numbers, and booleans; an attribute whose fact is unknown is
 * omitted rather than sent as a placeholder a rule could accidentally match.
 */
export type FlagTargetingAttributes = Record<string, string | number | boolean>;

/**
 * Attributes are derived from rows that change on a human timescale — a slug, a
 * membership, an origin — so a few minutes of staleness costs nothing and keeps
 * a hot agent path from paying for a read per run. The cache lives in the
 * isolate, so it is already scoped to one region and empties on every eviction.
 */
const ATTRIBUTE_CACHE_TTL_MS = 5 * 60_000;

/**
 * A bound on isolate memory, not on correctness: past it the least recently
 * loaded entries are dropped and reloaded on demand. A busy Worker sees a
 * handful of workspaces, so this is far above the working set.
 */
const ATTRIBUTE_CACHE_MAX_ENTRIES = 512;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface WorkspaceFacts {
  slug: string;
  createdAt: string | null;
  ownerEmailDomain: string | undefined;
  memberCount: number;
}

interface UserFacts {
  emailDomain: string | undefined;
  role: string | undefined;
}

interface WorkstreamFacts {
  origin: string;
  scope: string;
  createdByUserId: string | undefined;
  creatorEmailDomain: string | undefined;
  fromOpportunity: boolean;
  system: boolean;
}

const workspaceCache = new Map<string, CacheEntry<WorkspaceFacts>>();
const userCache = new Map<string, CacheEntry<UserFacts>>();
const workstreamCache = new Map<string, CacheEntry<WorkstreamFacts>>();

/** Drops every cached fact. Exists for tests, which must not inherit each other's rows. */
export function clearFlagTargetingAttributeCache(): void {
  workspaceCache.clear();
  userCache.clear();
  workstreamCache.clear();
}

/**
 * Reads through the cache, and deliberately does **not** cache a miss. A work
 * stream is routinely flagged one statement before its row is inserted — the
 * automation paths resolve the model for an id they are about to write — so
 * remembering "no such row" would keep that work stream unattributed for the
 * whole of its first runs.
 */
async function cached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  load: () => Promise<T | null>,
): Promise<T | null> {
  const hit = cache.get(key);
  if (hit) {
    if (hit.expiresAt > Date.now()) return hit.value;
    cache.delete(key);
  }
  const value = await load();
  if (!value) return null;
  // Stamped when the value is stored rather than when the lookup began, so a
  // slow read spends its own latency instead of the entry's life.
  cache.set(key, { value, expiresAt: Date.now() + ATTRIBUTE_CACHE_TTL_MS });
  if (cache.size > ATTRIBUTE_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

/**
 * The domain half of an address, never the local part. The domain is what makes
 * a rule expressible — "everyone at this customer", "the people dogfooding" —
 * while the local part is the half that names a person, so it stays in the
 * Worker. A malformed or empty address yields no attribute at all.
 */
function emailDomain(email: unknown): string | undefined {
  if (typeof email !== "string") return undefined;
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = email.slice(at + 1).trim().toLowerCase();
  // 253 is the maximum length of a DNS name; anything longer is not a domain.
  return domain.length > 0 && domain.length <= 253 ? domain : undefined;
}

function ageDays(createdAt: string | null, now: number): number | undefined {
  const parsed = Date.parse(createdAt ?? "");
  if (!Number.isFinite(parsed)) return undefined;
  // Clamped at zero so a row written by a clock running slightly ahead reads as
  // new rather than as a negative age no rule would be written against.
  return Math.max(0, Math.floor((now - parsed) / 86_400_000));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Attributes are an enrichment, never a precondition: a failed read leaves the
 * evaluation with its identifiers rather than failing the agent run that asked
 * for a model. A D1 error is genuinely abnormal — unlike the Flagship binding,
 * D1 works locally — so it warns rather than staying quiet in development.
 */
async function loadRow<T>(
  env: Env,
  subject: FlagTargetingSubject,
  entity: "workspace" | "user" | "workstream",
  sql: string,
  bindings: (string | null)[],
): Promise<T | null> {
  try {
    return await env.DB.prepare(sql).bind(...bindings).first<T>();
  } catch (error) {
    logStructuredEvent(env, "warn", "flag_targeting_attributes_unavailable", {
      entity,
      workspace_id: subject.workspaceId,
      workstream_id: subject.workstreamId,
      user_id: subject.userId,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

async function workspaceFacts(env: Env, subject: FlagTargetingSubject, workspaceId: string) {
  return cached(workspaceCache, workspaceId, async () => {
    const row = await loadRow<{
      slug: string;
      created_at: string;
      owner_email: string | null;
      member_count: number;
    }>(
      env,
      subject,
      "workspace",
      `SELECT w.slug, w.created_at, owner.email AS owner_email,
              (SELECT COUNT(*) FROM workspace_members m
                WHERE m.workspace_id = w.id AND m.status = 'active') AS member_count
         FROM workspaces w
         LEFT JOIN users owner ON owner.id = w.created_by_user_id
        WHERE w.id = ?1`,
      [workspaceId],
    );
    if (!row) return null;
    return {
      slug: row.slug,
      createdAt: text(row.created_at) ?? null,
      ownerEmailDomain: emailDomain(row.owner_email),
      memberCount: Number(row.member_count ?? 0),
    } satisfies WorkspaceFacts;
  });
}

async function userFacts(env: Env, subject: FlagTargetingSubject, userId: string) {
  // The role is a property of the pair, not of the user, so a user evaluated in
  // two workspaces must not read one workspace's role from the other's entry.
  const key = `${userId}:${subject.workspaceId ?? ""}`;
  return cached(userCache, key, async () => {
    const row = await loadRow<{ email: string; role: string | null }>(
      env,
      subject,
      "user",
      `SELECT u.email, m.role
         FROM users u
         LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = ?2
        WHERE u.id = ?1`,
      [userId, subject.workspaceId ?? null],
    );
    if (!row) return null;
    return {
      emailDomain: emailDomain(row.email),
      role: text(row.role),
    } satisfies UserFacts;
  });
}

async function workstreamFacts(env: Env, subject: FlagTargetingSubject, workstreamId: string) {
  return cached(workstreamCache, workstreamId, async () => {
    const row = await loadRow<{
      origin_type: string;
      scope: string;
      system_kind: string | null;
      created_by_user_id: string | null;
      created_from_opportunity_id: string | null;
      creator_email: string | null;
    }>(
      env,
      subject,
      "workstream",
      `SELECT s.origin_type, s.scope, s.system_kind, s.created_by_user_id,
              s.created_from_opportunity_id, creator.email AS creator_email
         FROM workstreams s
         LEFT JOIN users creator ON creator.id = s.created_by_user_id
        WHERE s.id = ?1`,
      [workstreamId],
    );
    if (!row) return null;
    return {
      origin: row.origin_type,
      scope: row.scope,
      createdByUserId: text(row.created_by_user_id),
      creatorEmailDomain: emailDomain(row.creator_email),
      fromOpportunity: Boolean(row.created_from_opportunity_id),
      system: Boolean(row.system_kind),
    } satisfies WorkstreamFacts;
  });
}

/**
 * The attributes a Flagship targeting rule may match on for one subject, on top
 * of the identifiers the caller already sends. Everything here is a fact about
 * a workspace, a work stream, or a person's relationship to them — a slug, a
 * count, an age, a role, an origin, an email *domain*. No name, no address, no
 * title, and nothing a person wrote ever becomes an attribute; see
 * `docs/FEATURE_FLAGS.md` for why that line is where it is.
 *
 * Never throws and never blocks on more than one round trip: the three reads
 * are independent, each is cached in the isolate, and each failure degrades to
 * "no attributes from that entity".
 */
export async function loadFlagTargetingAttributes(
  env: Env,
  subject: FlagTargetingSubject,
): Promise<FlagTargetingAttributes> {
  if (!env.DB) return {};
  const [workspace, user, workstream] = await Promise.all([
    subject.workspaceId ? workspaceFacts(env, subject, subject.workspaceId) : null,
    subject.userId ? userFacts(env, subject, subject.userId) : null,
    subject.workstreamId ? workstreamFacts(env, subject, subject.workstreamId) : null,
  ]);
  const now = Date.now();
  const attributes: FlagTargetingAttributes = {};
  if (workspace) {
    attributes.workspaceSlug = workspace.slug;
    attributes.workspaceMemberCount = workspace.memberCount;
    const age = ageDays(workspace.createdAt, now);
    if (age !== undefined) attributes.workspaceAgeDays = age;
    // The owner's domain is the only domain most evaluations can have: a
    // work-stream run carries no user, so without it a rule could not reach the
    // dogfooding workspaces or one customer's tenancy at all.
    if (workspace.ownerEmailDomain) attributes.workspaceOwnerEmailDomain = workspace.ownerEmailDomain;
  }
  if (user) {
    if (user.emailDomain) attributes.userEmailDomain = user.emailDomain;
    if (user.role) attributes.userRole = user.role;
  }
  if (workstream) {
    attributes.workstreamOrigin = workstream.origin;
    attributes.workstreamScope = workstream.scope;
    attributes.workstreamFromOpportunity = workstream.fromOpportunity;
    attributes.workstreamIsSystem = workstream.system;
    if (workstream.createdByUserId) attributes.workstreamCreatedByUserId = workstream.createdByUserId;
    if (workstream.creatorEmailDomain) {
      attributes.workstreamCreatorEmailDomain = workstream.creatorEmailDomain;
    }
  }
  return attributes;
}
