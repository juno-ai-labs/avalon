/**
 * The one place a Durable Object is allowed to recognize itself.
 *
 * Avalon's shared services address an object by *role* — "the WorkspaceDO for
 * this workspace", "the AgentLoopDO that owns this work stream" — because
 * almost every caller is a Worker, a queue consumer, or a Workflow, for which
 * that is the only way to reach it. The objects then grew inward: a work
 * stream's whole agent loop runs inside its `AgentLoopDO`, and a workspace's
 * schedule runs inside its `WorkspaceDO`. Those same helpers now run *inside*
 * the object they are addressing, and each call left the object over RPC and
 * came straight back in.
 *
 * That is never what the caller meant. It costs a namespace resolution, a
 * placement-affinity read, and a round trip to reach storage the caller is
 * already holding; it competes with the object for its own single thread; the
 * inner call cannot join the outer one's `transactionSync`, so a read-then-write
 * stops being one critical section; and a local invariant violation comes back
 * wearing a foreign object's error. Worst of all it is invisible: every
 * individual call site reads as correct, and only the composition is wrong.
 *
 * So an object registers itself here, and {@link durableObjectStubForWorkspace}
 * hands back that registration instead of a namespace stub when the name being
 * resolved is the caller's own. Nothing else changes: the same methods are
 * called with the same arguments, and a call to any *other* object — a sibling
 * work stream, another workspace — still goes over RPC exactly as before.
 *
 * The registration travels on `env`, which is how it reaches code several
 * layers down that never hears about the object. `env` cannot leave the
 * isolate — a Queue message and a Workflow parameter are both serialized — so a
 * registration cannot outlive the object that made it.
 */
import type { DurableObject as RpcDurableObject } from "cloudflare:workers";

const SELF_REFERENCES = Symbol("avalon-durable-object-self");

export interface DurableObjectSelfReference<T extends RpcDurableObject> {
  /**
   * The binding this object is reached through, compared by identity.
   *
   * Binding, jurisdiction, and name together decide which object a name means,
   * so the binding has to match as well as the name: a logical name is not
   * unique across bindings (the deleted `WorkstreamDO` and a Channel's main
   * `AgentLoopDO` shared one).
   *
   * Identity is also what makes the lookup below type-safe: two references to
   * the same binding object are the same `DurableObjectNamespace<T>`, so a
   * registration that matches it is a registration of that same `T`.
   */
  namespace: DurableObjectNamespace<T>;
  /**
   * This object's own deterministic name, or `null` before it has an identity.
   *
   * A thunk because identity arrives after construction — a fresh object learns
   * which workspace or work stream it is on its first scoped request.
   *
   * **Not a routing input.** Recognition is decided on {@link id} below; this
   * exists so the stand-in stub can answer `name` the way a namespace stub
   * does, and so a diagnostic can say what the object would have called itself.
   * It was the routing input until 2026-08-25, and the window where it answers
   * `null` is what took a work stream down the day before: an object that could
   * not say its own name resolved that name through the namespace, landed back
   * on itself, and did it fifteen times until Cloudflare refused every further
   * subrequest from the invocation.
   */
  name: () => string | null;
  /**
   * This object's id — the routing decision, and the only one.
   *
   * Known from `state.id` at construction, before any durable fact is read, and
   * already jurisdiction-asserted there. A name is only a way to compute one of
   * these: `idFromName` is a pure function of the binding and the name, so a
   * caller can derive the id it is about to reach and compare, with nothing to
   * be missing and no window to fall through.
   */
  id: DurableObjectId;
  instance: T;
}

interface RegisteredSelf {
  namespace: unknown;
  name: () => string | null;
  id: DurableObjectId;
  /**
   * The stand-in stub, kept opaque because the registry is heterogeneous. The
   * namespace identity check in {@link durableObjectSelfForId} is what recovers the
   * type: only the binding this stub was built for can match it.
   */
  stub: unknown;
}

type SelfCarryingEnv = { [SELF_REFERENCES]?: readonly RegisteredSelf[] };

function registrations(env: object): readonly RegisteredSelf[] {
  return (env as SelfCarryingEnv)[SELF_REFERENCES] ?? [];
}

/**
 * Stand in for a stub on the object itself.
 *
 * `id` and `name` are answered from the registration rather than refused, so
 * this is a complete stand-in for the namespace stub rather than one that works
 * until a caller reads a property. Methods are bound to the instance so that
 * `this` inside them is the object and not this proxy.
 *
 * `DurableObjectStub<T>` describes T's own methods as they look across an RPC
 * boundary; this is the same object with the boundary removed, which is why the
 * conversion is a narrowing of the instance rather than an erasure of it.
 *
 * Only `get` is trapped, which is what every caller of a stub uses. `in`,
 * `Object.keys`, and property descriptors therefore see the instance rather than
 * the stub, and would not show the `id` and `name` answered here. Nothing reads
 * a stub that way today; a generic wrapper that did would need the other traps.
 */
function selfStub<T extends RpcDurableObject>(
  reference: DurableObjectSelfReference<T>,
): DurableObjectStub<T> {
  const stub = new Proxy(reference.instance, {
    get(target, property, receiver) {
      if (property === "id") return reference.id;
      if (property === "name") return reference.name() ?? undefined;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return stub as DurableObjectStub<T>;
}

/**
 * Carry a self-registration on every environment derived from this one.
 *
 * Called once, in the object's constructor, so that `this.env` and everything
 * built from it — the runtime database proxies, a service handed `this.env`,
 * a helper five layers down — resolves this object's own name locally.
 */
export function withDurableObjectSelf<TEnv extends object, T extends RpcDurableObject>(
  env: TEnv,
  reference: DurableObjectSelfReference<T>,
): TEnv {
  const carried: readonly RegisteredSelf[] = [
    ...registrations(env),
    {
      namespace: reference.namespace,
      name: reference.name,
      id: reference.id,
      stub: selfStub(reference),
    },
  ];
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === SELF_REFERENCES) return carried;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/**
 * The caller's own object, when the id being resolved is its own.
 *
 * `null` for every other id, including a sibling of the same class, which is an
 * ordinary cross-object hop.
 *
 * The caller passes the id rather than the name because deriving one needs the
 * region and environment that decide the jurisdiction, and that lives with the
 * resolver. Deriving it costs a hash and no I/O, which is what lets this stay
 * ahead of the placement-affinity read: an object must never need D1 to reach
 * storage it is already holding.
 *
 * Ids are compared as strings. `DurableObjectId.equals` exists on a real id and
 * on a jurisdictional one, and not on the stand-in a focused unit test builds;
 * `toString` is the one representation all three have.
 */
export function durableObjectSelfForId<T extends RpcDurableObject | undefined = undefined>(
  env: object,
  namespace: DurableObjectNamespace<T>,
  id: DurableObjectId,
): DurableObjectStub<T> | null {
  // A focused unit environment may omit a binding entirely, the same allowance
  // `withWorkspaceRuntimeDatabase` makes. Without this, two omitted bindings are
  // both `undefined` and compare equal, and the match would fall to the id
  // alone — which may not be sufficient, since nothing here promises that two
  // bindings hash a name to different ids.
  if (!namespace) return null;
  const target = id.toString();
  for (const registered of registrations(env)) {
    if (registered.namespace !== namespace) continue;
    if (registered.id.toString() !== target) continue;
    return registered.stub as DurableObjectStub<T>;
  }
  return null;
}

/**
 * The registration a resolved id belongs to, when a caller is about to address
 * its own object through the namespace anyway.
 *
 * Every resolver consults {@link durableObjectSelfForId} first, so nothing they
 * hand back can reach this. It is the backstop for a caller that skipped them,
 * and for any future resolver that forgets to. Reaching it is a defect, which
 * is why the caller treats it as one rather than as a slow path.
 *
 * It answers the registration rather than a boolean so a diagnostic can say what
 * the object would have called itself; `null` there means the object could not
 * name itself, which is worth knowing and no longer changes any routing.
 */
export function selfAddressedOverRpc<T extends RpcDurableObject | undefined = undefined>(
  env: object,
  namespace: DurableObjectNamespace<T>,
  id: DurableObjectId,
): { name: string | null } | null {
  if (!namespace) return null;
  const target = id.toString();
  for (const registered of registrations(env)) {
    if (registered.namespace !== namespace) continue;
    if (registered.id.toString() !== target) continue;
    return { name: registered.name() };
  }
  return null;
}
