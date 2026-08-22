/**
 * The one place a Durable Object is allowed to recognize itself.
 *
 * Avalon's shared services address an object by *role* — "the WorkspaceDO for
 * this workspace", "the SubstreamAgent that owns this work stream" — because
 * almost every caller is a Worker, a queue consumer, or a Workflow, for which
 * that is the only way to reach it. The objects then grew inward: a work
 * stream's whole agent loop runs inside its `SubstreamAgent`, and a workspace's
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
   * so the binding has to match as well as the name: `WorkstreamDO` and the
   * main `SubstreamAgent` share a logical name under different bindings.
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
   * which workspace or work stream it is on its first scoped request. Until
   * then nothing can legitimately address it by name, so `null` simply leaves
   * every lookup on the namespace path.
   */
  name: () => string | null;
  id: DurableObjectId;
  instance: T;
}

interface RegisteredSelf {
  namespace: unknown;
  name: () => string | null;
  /**
   * The stand-in stub, kept opaque because the registry is heterogeneous. The
   * namespace identity check in {@link durableObjectSelf} is what recovers the
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
    { namespace: reference.namespace, name: reference.name, stub: selfStub(reference) },
  ];
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === SELF_REFERENCES) return carried;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/**
 * The caller's own object, when the name being resolved is its own.
 *
 * `null` for every other name, including a sibling of the same class, which is
 * an ordinary cross-object hop.
 */
export function durableObjectSelf<T extends RpcDurableObject | undefined = undefined>(
  env: object,
  namespace: DurableObjectNamespace<T>,
  name: string,
): DurableObjectStub<T> | null {
  // A focused unit environment may omit a binding entirely, the same allowance
  // `withWorkspaceRuntimeDatabase` makes. Without this, two omitted bindings are
  // both `undefined` and compare equal, and the match would fall to the name
  // alone — which is exactly the comparison that is not sufficient, since
  // `WorkstreamDO` and the main `SubstreamAgent` share a logical name.
  if (!namespace) return null;
  for (const registered of registrations(env)) {
    if (registered.namespace !== namespace) continue;
    if (registered.name() !== name) continue;
    return registered.stub as DurableObjectStub<T>;
  }
  return null;
}
