/**
 * Everything an object owns about one work stream, installed in one place.
 *
 * A run needs several durable authorities — the work stream's messages, its
 * resources, its harness runs, its receipts, its Terminal — and every one of
 * them lives in the `AgentLoopDO` that owns the work stream. When the run
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
import type { WorkspaceId } from "@rally/contracts";

import type { Env } from "../env";
// Type-only, so the value import in the other direction stays a one-way edge:
// the Terminal port reads this registry, and this registry only needs to know
// the shape of what it stores.
import type { TerminalOperationExecutor } from "../services/terminal/object-port";
import type { DesktopActionExecutor } from "../services/desktop-actions/executor";

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
 * The authorities an `AgentLoopDO` can serve without leaving the isolate.
 *
 * One name per object port, and the ports are the eight in this directory plus
 * Terminal, whose port predates them. A caller supplies what it owns; anything
 * absent keeps resolving the way it did, which is what makes adding an
 * authority a change to this file rather than to every caller of one.
 */
export interface LocalWorkstreamAuthorities {
  harnessRun?: LocalAuthorityExecutor;
  identity?: LocalAuthorityExecutor;
  message?: LocalAuthorityExecutor;
  resource?: LocalAuthorityExecutor;
  scheduling?: LocalAuthorityExecutor;
  transcript?: LocalAuthorityExecutor;
  // Terminal's own executor predates this registry and already answers by
  // throwing its typed failure rather than returning one, so it keeps that
  // shape and its port keeps reading it.
  terminal?: TerminalOperationExecutor;
  toolReceipt?: LocalAuthorityExecutor;
  residentContext?: LocalAuthorityExecutor;
  // Has no wire path at all: the desktop answers on this object's own sockets,
  // and the waiting tool must be in the same isolate that receives the answer.
  // A run outside the object finds none and its browser tools refuse.
  desktopAction?: DesktopActionExecutor;
}

export type WorkstreamAuthority = keyof LocalWorkstreamAuthorities;

/**
 * The authorities a generic object port can speak for.
 *
 * Terminal is excluded because its port predates `createObjectPort` and its
 * executor answers by throwing a typed failure rather than returning one. The
 * exclusion is what lets a port read this registry without a cast.
 */
export type ObjectPortAuthority = Exclude<WorkstreamAuthority, "terminal" | "desktopAction">;

/** The work stream a set of authorities belongs to. */
export interface WorkstreamAuthorityScope {
  workspaceId: string;
  workstreamId: string;
  substreamId: string;
}

const LOCAL_AUTHORITIES = Symbol("workstream-local-authorities");

interface InstalledAuthorities {
  /** What this object durably is. */
  substreamId: string;
  authorities: LocalWorkstreamAuthorities;
}

type AuthorityRegistry = ReadonlyMap<string, InstalledAuthorities>;

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
 *
 * `substreamId` has two readings, and the difference is the whole point:
 *
 * - **Absent** means "the conversation this run executes in", which is what
 *   every loop-side port means. Inside a child conversation that resolves to
 *   the child's own authorities, not the main conversation's.
 * - **Present** names one conversation, and it is answered locally only when
 *   this object *is* that conversation. An explicit `"0"` inside a child names
 *   the parent's main conversation and goes over the wire.
 *
 * Before the two were told apart, an explicit `"0"` and no substream at all
 * were the same call, so a Terminal port that a background agent deliberately
 * addressed at its owner's conversation was answered out of the agent's own
 * storage — a second sandbox authority under the same stable name. The
 * distinction is what lets one conversation hold a sandbox that another
 * conversation's run may use.
 */
export function localWorkstreamAuthority<K extends WorkstreamAuthority>(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  authority: K,
  substreamId?: string,
): LocalWorkstreamAuthorities[K] | undefined {
  const installed = carriedAuthorities(env).get(scopeKey(workspaceId, workstreamId));
  if (!installed) return undefined;
  // No substream names the conversation this run executes in, which is the
  // object that installed these: a loop-side port means where it runs.
  if (substreamId === undefined) return installed.authorities[authority];
  // A port that names a substream other than the one this object is must go
  // over the wire: the installed executors answer for this object alone.
  if (installed.substreamId !== substreamId) return undefined;
  return installed.authorities[authority];
}

/**
 * Whether this object is the authority for the conversation being run.
 *
 * This is the *routing* half of `objectPortRefusal` and deliberately not all of
 * it: every endpoint refuses anything but an identity match on the parent and
 * on the substream it durably is, and a local path that answered where an
 * endpoint would refuse would serve a conversation's state out of the wrong
 * object — a far worse failure than the round trip it saves. Exported and pure
 * so the rule is checked rather than reasoned about.
 *
 * The other half — `isAuthoritative()`, which is `authority_mode` and a
 * generation above zero — is deliberately absent here, because this is answered
 * once when the environment is derived and that fence has to hold per call: an
 * object quarantined mid-run would otherwise keep its local authorities for the
 * rest of the run while the wire path had started refusing. It is evaluated
 * where it can be evaluated at call time, in the endpoint body each installed
 * executor runs. Which is the same reason an executor is an endpoint and never a
 * storage instance.
 *
 * Both substream ids are compared, not one: `substreamId` is the run being
 * dispatched and `externalSubstreamId` is what this object durably is. An
 * object running another substream's run is a routing defect that must go
 * over the wire and be refused, not answered locally.
 *
 * The registry is keyed by the parent alone, so inside a child conversation a
 * port built without a substream id means "the conversation I am running in",
 * which is what every loop-side port means. A deliberate read of the parent's
 * main conversation from inside a child names `"0"` explicitly and goes over
 * the wire.
 */
export function objectOwnsWorkstreamAuthorities(
  identity: { workspaceId: WorkspaceId; parentId: string } | null,
  externalSubstreamId: string,
  scope: WorkstreamAuthorityScope,
): boolean {
  return identity !== null
    && identity.workspaceId === scope.workspaceId
    && identity.parentId === scope.workstreamId
    && scope.substreamId === externalSubstreamId;
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
  substreamId: string,
  authorities: LocalWorkstreamAuthorities,
): Env {
  const key = scopeKey(workspaceId, workstreamId);
  const carried: AuthorityRegistry = new Map(carriedAuthorities(env))
    .set(key, {
      substreamId,
      authorities: { ...carriedAuthorities(env).get(key)?.authorities, ...authorities },
    });
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === LOCAL_AUTHORITIES) return carried;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}
