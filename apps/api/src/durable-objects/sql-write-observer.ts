/**
 * A Durable Object's state whose SQL handle tells `onWrite` after every
 * statement that is not a plain `SELECT`, so work that follows a write — a
 * ledger a trigger filled — has one place to hang from rather than a call at
 * every writer. `onWrite` runs synchronously, inside whatever transaction the
 * statement ran in, and must only schedule.
 *
 * Every other member of the state, the storage and the SQL handle is the
 * platform's own, bound to it.
 */
export function observeSqlWrites(state: DurableObjectState, onWrite: () => void): DurableObjectState {
  const sql = delegate(state.storage.sql, {
    exec: (query: string, ...bindings: unknown[]) => {
      const cursor = state.storage.sql.exec(query, ...bindings);
      if (!READ_ONLY.test(query)) onWrite();
      return cursor;
    },
  });
  const storage = delegate(state.storage, { sql });
  return delegate(state, { storage });
}

const READ_ONLY = /^\s*SELECT\b/iu;

function delegate<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === "string" && Object.hasOwn(overrides, property)) return overrides[property];
      const value: unknown = Reflect.get(object, property, object);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
    },
  });
}
