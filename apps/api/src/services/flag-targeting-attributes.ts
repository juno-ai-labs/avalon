import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";
import { createIdentityObjectPort } from "../runtime/identity-port";
import type { IdentityRow } from "../durable-objects/workstream-identity-storage";

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
  platformId: string | undefined;
}

interface WorkstreamFacts {
  origin: string;
  scope: string;
  createdByUserId: string | undefined;
  creatorEmailDomain: string | undefined;
  fromOpportunity: boolean;
  system: boolean;
}

/**
 * How long a *failed* read is left alone. A miss is never remembered (see
 * `cached`), but a failure is a different event with a different consequence:
 * while D1 is unhealthy every evaluation on every agent path would otherwise
 * re-issue its reads and warn again, turning an outage into a log flood on top
 * of it. Seconds rather than the attribute TTL, so recovery is still prompt and
 * a row written moments later is still picked up.
 */
const FAILURE_SUPPRESSION_MS = 10_000;

type EntityKind = "workspace" | "user" | "workstream";

/** A read's two distinguishable outcomes: no such row, or the read did not happen. */
interface LoadOutcome<T> {
  value: T | null;
  failed: boolean;
}

const workspaceCache = new Map<string, CacheEntry<WorkspaceFacts>>();
const userCache = new Map<string, CacheEntry<UserFacts>>();
const workstreamCache = new Map<string, CacheEntry<WorkstreamFacts>>();
/** Namespaced `entity:key` → the moment that key may be read again after a failure. */
const failureSuppression = new Map<string, number>();
/** Namespaced `entity:key` → the read already in flight for it, if any. */
const inFlightLoads = new Map<string, Promise<LoadOutcome<unknown>>>();

/** Drops every cached fact. Exists for tests, which must not inherit each other's rows. */
export function clearFlagTargetingAttributeCache(): void {
  workspaceCache.clear();
  userCache.clear();
  workstreamCache.clear();
  failureSuppression.clear();
  inFlightLoads.clear();
}

/**
 * Reads through the cache, and deliberately does **not** cache a miss. A work
 * stream is routinely flagged one statement before its row is inserted — the
 * automation paths resolve the model for an id they are about to write — so
 * remembering "no such row" would keep that work stream unattributed for the
 * whole of its first runs. A *failed* read is held down briefly instead, which
 * is the one case where retrying immediately helps nobody.
 */
async function cached<T>(
  cache: Map<string, CacheEntry<T>>,
  entity: EntityKind,
  key: string,
  load: () => Promise<LoadOutcome<T>>,
): Promise<T | null> {
  const hit = cache.get(key);
  if (hit) {
    if (hit.expiresAt > Date.now()) return hit.value;
    cache.delete(key);
  }
  const suppressionKey = `${entity}:${key}`;
  const suppressedUntil = failureSuppression.get(suppressionKey);
  if (suppressedUntil !== undefined) {
    if (suppressedUntil > Date.now()) return null;
    failureSuppression.delete(suppressionKey);
  }
  // The cache is written when a read *resolves*, so two evaluations starting in
  // the same tick would both miss and both read. That is not hypothetical: one
  // request resolves several flags at once, and each resolver describes the same
  // subject. Sharing the pending read means a cold isolate pays for one, and the
  // entry is dropped as soon as it settles so nothing here outlives a request —
  // this is a de-duplicator, not a second cache with its own staleness.
  const inFlightKey = `${entity}:${key}`;
  const pending = inFlightLoads.get(inFlightKey) as Promise<LoadOutcome<T>> | undefined;
  const read = pending ?? load().finally(() => {
    inFlightLoads.delete(inFlightKey);
  });
  if (!pending) inFlightLoads.set(inFlightKey, read as Promise<LoadOutcome<unknown>>);
  const outcome = await read;
  if (outcome.failed) {
    failureSuppression.set(suppressionKey, Date.now() + FAILURE_SUPPRESSION_MS);
    return null;
  }
  if (!outcome.value) return null;
  // Stamped when the value is stored rather than when the lookup began, so a
  // slow read spends its own latency instead of the entry's life.
  cache.set(key, { value: outcome.value, expiresAt: Date.now() + ATTRIBUTE_CACHE_TTL_MS });
  if (cache.size > ATTRIBUTE_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return outcome.value;
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
  entity: EntityKind,
  sql: string,
  bindings: (string | null)[],
): Promise<LoadOutcome<T>> {
  try {
    return { value: await env.DB.prepare(sql).bind(...bindings).first<T>(), failed: false };
  } catch (error) {
    logStructuredEvent(env, "warn", "flag_targeting_attributes_unavailable", {
      entity,
      workspace_id: subject.workspaceId,
      workstream_id: subject.workstreamId,
      user_id: subject.userId,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return { value: null, failed: true };
  }
}

/**
 * The work stream's identity, through its authority, with `loadRow`'s contract.
 *
 * The five columns this needs used to be a `SELECT` handed to `loadRow`, which
 * exists to keep "no such row" and "the read failed" apart — a targeting fact
 * that cannot be read must not read as absent, because a flag would then
 * evaluate against a subject Avalon never described. The port throws where the
 * statement threw, so the distinction survives the move; only the statement is
 * gone.
 *
 * The workspace arrives as an argument rather than being read off the subject.
 * It was a binding on the retired statement, where a missing one simply matched
 * nothing; addressing an object needs it before the question can be asked at
 * all. Its caller already refuses a subject without one, and a second guard
 * here would be unreachable — and disagreed with the reachable one about
 * whether an under-described subject is an absent fact or a failed read, which
 * is the one distinction `LoadOutcome` exists to keep.
 */
async function loadIdentity(
  env: Env,
  subject: FlagTargetingSubject,
  workspaceId: string,
  workstreamId: string,
): Promise<LoadOutcome<IdentityRow>> {
  try {
    const value = await createIdentityObjectPort(env, workspaceId, workstreamId)
      .identity();
    return { value: value ?? null, failed: false };
  } catch (error) {
    logStructuredEvent(env, "warn", "flag_targeting_attributes_unavailable", {
      entity: "workstream",
      workspace_id: subject.workspaceId,
      workstream_id: subject.workstreamId,
      user_id: subject.userId,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return { value: null, failed: true };
  }
}

/** Maps a read's outcome onto facts, keeping "no such row" and "no read" apart. */
function mapped<Row, Facts>(
  outcome: LoadOutcome<Row>,
  toFacts: (row: Row) => Facts,
): LoadOutcome<Facts> {
  return outcome.value
    ? { value: toFacts(outcome.value), failed: false }
    : { value: null, failed: outcome.failed };
}

async function workspaceFacts(env: Env, subject: FlagTargetingSubject, workspaceId: string) {
  return cached(workspaceCache, "workspace", workspaceId, async () => {
    const outcome = await loadRow<{
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
    return mapped(outcome, (row) => ({
      slug: row.slug,
      createdAt: text(row.created_at) ?? null,
      ownerEmailDomain: emailDomain(row.owner_email),
      memberCount: Number(row.member_count ?? 0),
    } satisfies WorkspaceFacts));
  });
}

async function userFacts(env: Env, subject: FlagTargetingSubject, userId: string) {
  // The role is a property of the pair, not of the user, so a user evaluated in
  // two workspaces must not read one workspace's role from the other's entry.
  const key = `${userId}:${subject.workspaceId ?? ""}`;
  return cached(userCache, "user", key, async () => {
    const outcome = await loadRow<{
      email: string;
      role: string | null;
      platform_user_id: string | null;
    }>(
      env,
      subject,
      "user",
      `SELECT u.email, u.platform_user_id, m.role
         FROM users u
         LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = ?2
        WHERE u.id = ?1`,
      [userId, subject.workspaceId ?? null],
    );
    return mapped(outcome, (row) => ({
      emailDomain: emailDomain(row.email),
      role: text(row.role),
      platformId: text(row.platform_user_id),
    } satisfies UserFacts));
  });
}

async function workstreamFacts(env: Env, subject: FlagTargetingSubject, workstreamId: string) {
  return cached(workstreamCache, "workstream", workstreamId, async () => {
    if (!subject.workspaceId) return { value: null, failed: false };
    // Opening the runtime environment was a step of its own, because the read
    // that followed was a statement that had to be routed. The port addresses
    // the object itself, so a failure to reach it is `loadIdentity`'s to report
    // rather than a second try/catch logging the same event above it.
    const outcome = await loadIdentity(env, subject, subject.workspaceId, workstreamId);
    if (!outcome.value) return { value: null, failed: outcome.failed };
    const creator = outcome.value.created_by_user_id
      ? await loadRow<{ email: string }>(
        env,
        subject,
        "user",
        "SELECT email FROM users WHERE id = ?1",
        [outcome.value.created_by_user_id],
      )
      : { value: null, failed: false };
    if (creator.failed) return { value: null, failed: true };
    return {
      value: {
        origin: outcome.value.origin_type,
        scope: outcome.value.scope,
        createdByUserId: text(outcome.value.created_by_user_id),
        creatorEmailDomain: emailDomain(creator.value?.email),
        fromOpportunity: Boolean(outcome.value.created_from_opportunity_id),
        system: Boolean(outcome.value.system_kind),
      } satisfies WorkstreamFacts,
      failed: outcome.failed,
    };
  });
}

/**
 * The attributes a Flagship targeting rule may match on for one subject, on top
 * of the identifiers the caller already sends. Everything here is a fact about
 * a workspace, a work stream, or a person's relationship to them — a count, an
 * age, a role, an origin, an email *domain* — with `workspaceSlug` as the one
 * deliberate exception: it is user-authored text, and it crosses anyway because
 * a uuid is unreadable in a rule six weeks later. No name, no address, no
 * title, and nothing else a person wrote ever becomes an attribute;
 * `docs/feature-flags.md` owns that boundary and the slug's carve-out.
 *
 * Never throws: independent entity reads are cached in the isolate, and each
 * failure degrades to "no attributes from that entity". Work-stream facts are
 * the deliberate multi-hop exception: product fields come from the Channel's
 * main conversation (`AgentLoopDO`), then creator email domain is enriched from regional identity D1. The outer
 * guard is what lets callers await this outside their own error handling — the
 * contract is structural, not a property of the current body.
 */
export async function loadFlagTargetingAttributes(
  env: Env,
  subject: FlagTargetingSubject,
): Promise<FlagTargetingAttributes> {
  try {
    return await collectAttributes(env, subject);
  } catch (error) {
    logStructuredEvent(env, "warn", "flag_targeting_attributes_unavailable", {
      entity: "subject",
      workspace_id: subject.workspaceId,
      workstream_id: subject.workstreamId,
      user_id: subject.userId,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return {};
  }
}

async function collectAttributes(
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
    // `userId` is regional: one person with workspaces in both regions has a
    // `users` row in each, so bucketing a percentage rollout on it would put
    // them in a different bucket per region and hand them the feature on one.
    // The platform id is the identity the Global control plane establishes once
    // and neither region may change, so it is the one to bucket a *person* by.
    if (user.platformId) attributes.userPlatformId = user.platformId;
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
