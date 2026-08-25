/**
 * Everything an object owns about one work stream, installed in one place.
 *
 * A run needs several durable authorities — the work stream's messages, its
 * resources, its harness runs, its receipts, its Terminal — and every one of
 * them lives in the `SubstreamAgent` that owns the work stream. When the run
 * executes inside that object none of them needs a stub, a name, or a round
 * trip; when it executes anywhere else, all of them do.
 *
 * That is a property of *where the run started*, so it is decided once, here,
 * by the object that owns them, rather than rediscovered per call by every
 * helper that happens to need one. It had been rediscovered three times a few
 * weeks apart — a workspace SQL executor, a work-stream SQL executor, a Terminal
 * executor threaded through three signatures — and the authority that had *not*
 * been given one took a work stream down on 2026-08-24, fifteen self-calls deep,
 * when Cloudflare stopped carrying subrequests for that invocation.
 *
 * `durableObjectSelfForId` is the backstop underneath this, not the mechanism:
 * it recognizes an object addressing itself and answers locally. This layer
 * means a run does not have to be *recognized* to reach storage it is already
 * holding.
 */
import type { WorkspaceId, WorkstreamId } from "@avalon/contracts";

import type { Env } from "../env";
// Type-only, so the value import in the other direction stays a one-way edge:
// the Terminal port reads this registry, and this registry only needs to know
// the shape of what it stores.
import type { TerminalOperationExecutor } from "../services/terminal/object-port";

/**
 * One authority's operations, as the object that owns them runs them.
 *
 * **Not the storage.** An endpoint is not a thin wrapper around its table: it
 * refuses a request addressed to another work stream, to a non-main substream,
 * or to an object whose `authority_mode` is no longer `authoritative`; it runs a
 * mutating operation inside `commitRuntimeMutation` so the row and the directory
 * projection that renders it are one commit; and the scheduling endpoint
 * re-derives the timer index and arms the next alarm before answering. Handing
 * down the storage instead would drop all of that silently for exactly the
 * callers running closest to the data — stale sidebar previews, wake-ups that
 * never fire, and writes accepted against a quarantined object.
 *
 * So an executor is the endpoint's own body, and answers what the wire answers:
 * the same `{ ok, value }` on success and the same `{ ok: false, error }` on a
 * refusal, so `createObjectPort` interprets both the same way and a local caller
 * cannot observe which one it got.
 */
export type LocalAuthorityExecutor = (
  operation: string,
  args: unknown[],
) => Promise<{ ok?: boolean; value?: unknown; error?: string }>;

/**
 * The authorities a `SubstreamAgent` can serve without leaving the isolate.
 *
 * One name per object port, and the ports are the eight in this directory plus
 * Terminal, whose port predates them. A caller supplies what it owns; anything
 * absent keeps resolving the way it did, which is what makes adding an
 * authority a change to this file rather than to every caller of one.
 */
export interface LocalWorkstreamAuthorities {
  blockDashboard?: LocalAuthorityExecutor;
  harnessRun?: LocalAuthorityExecutor;
  identity?: LocalAuthorityExecutor;
  message?: LocalAuthorityExecutor;
  resource?: LocalAuthorityExecutor;
  scheduling?: LocalAuthorityExecutor;
  // Terminal's own executor predates this registry and already answers by
  // throwing its typed failure rather than returning one, so it keeps that
  // shape and its port keeps reading it.
  terminal?: TerminalOperationExecutor;
  toolReceipt?: LocalAuthorityExecutor;
}

export type WorkstreamAuthority = keyof LocalWorkstreamAuthorities;

/**
 * The authorities a generic object port can speak for.
 *
 * Terminal is excluded because its port predates `createObjectPort` and its
 * executor answers by throwing a typed failure rather than returning one. The
 * exclusion is what lets a port read this registry without a cast.
 */
export type ObjectPortAuthority = Exclude<WorkstreamAuthority, "terminal">;

/** The work stream a set of authorities belongs to. */
export interface WorkstreamAuthorityScope {
  workspaceId: string;
  workstreamId: string;
  substreamId: string;
}

const LOCAL_AUTHORITIES = Symbol("workstream-local-authorities");

type AuthorityRegistry = ReadonlyMap<string, LocalWorkstreamAuthorities>;

function scopeKey(workspaceId: string, workstreamId: string): string {
  return `${workspaceId}:${workstreamId}`;
}

function carriedAuthorities(env: Env): AuthorityRegistry {
  return (env as Env & { [LOCAL_AUTHORITIES]?: AuthorityRegistry })[LOCAL_AUTHORITIES]
    ?? new Map();
}

/**
 * The local authority for this work stream, if the caller is holding it.
 *
 * Read by the object ports rather than by product code: a port asks for its own
 * authority by name and either gets storage in this isolate or dispatches, and
 * nothing above it has to know which happened.
 */
export function localWorkstreamAuthority<K extends WorkstreamAuthority>(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  authority: K,
): LocalWorkstreamAuthorities[K] | undefined {
  return carriedAuthorities(env).get(scopeKey(workspaceId, workstreamId))?.[authority];
}

/**
 * Whether this object is the authority for the work stream being run.
 *
 * One rule, because the endpoints enforce one rule: every one of them refuses
 * anything but an identity match on both ids in the main child, and a local
 * path that answered where an endpoint would refuse would serve a work stream's
 * state out of the wrong object — a far worse failure than the round trip it
 * saves. Exported and pure so the rule is checked rather than reasoned about.
 *
 * Both substream ids are compared, not one: `substreamId` is the run being
 * dispatched and `externalSubstreamId` is what this object durably is. A
 * non-main object running a main-child run — or the reverse — is a routing
 * defect that must go over the wire and be refused, not answered locally.
 */
export function objectOwnsWorkstreamAuthorities(
  identity: { workspaceId: WorkspaceId; workstreamId: WorkstreamId } | null,
  externalSubstreamId: string,
  scope: WorkstreamAuthorityScope,
): boolean {
  return identity !== null
    && identity.workspaceId === scope.workspaceId
    && identity.workstreamId === scope.workstreamId
    && scope.substreamId === "0"
    && externalSubstreamId === "0";
}

/**
 * Install the authorities this object owns on every environment derived from
 * the one returned.
 *
 * Keyed by the work stream, so a port for any *other* work stream — a sibling,
 * another workspace — finds nothing installed and dispatches exactly as before.
 * A second call for a different work stream adds to the registry rather than
 * replacing it, which is what lets one environment be derived from another.
 */
export function withLocalWorkstreamAuthorities(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  authorities: LocalWorkstreamAuthorities,
): Env {
  const key = scopeKey(workspaceId, workstreamId);
  const carried: AuthorityRegistry = new Map(carriedAuthorities(env))
    .set(key, { ...carriedAuthorities(env).get(key), ...authorities });
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === LOCAL_AUTHORITIES) return carried;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}
