/**
 * Centralized, typed construction for partial Cloudflare runtime test doubles.
 *
 * Workerd bindings contain members that focused unit tests do not exercise, so
 * a small fake cannot implement the complete ambient interface. These helpers
 * still type-check every member the fake supplies; only the final completeness
 * assertion lives here, where it cannot silently spread through test files.
 */
import type { Env } from "../../src/env";

// Focused fakes may omit the runtime-owned contents of returned workerd
// objects, but they must retain sync/async and object/primitive categories.
type TestDoubleResult<Value> = Value extends Promise<unknown>
  ? Promise<unknown>
  : Value extends object
    ? object
    : Value;

type BivariantMethod<Arguments extends unknown[], Result> = {
  bivarianceHack(...args: Arguments): Result;
}["bivarianceHack"];

type TestDoubleMember<Value> = Value extends {
  (...args: infer FirstArguments): infer FirstResult;
  (...args: infer SecondArguments): infer SecondResult;
}
  ? Value
    | BivariantMethod<FirstArguments, TestDoubleResult<FirstResult>>
    | BivariantMethod<SecondArguments, TestDoubleResult<SecondResult>>
  : Value extends object
    ? Value | TestDouble<Value>
    : Value;

type TestDouble<T> = {
  [Key in keyof T]?: TestDoubleMember<T[Key]> | undefined;
};

type D1ResultDouble<T> = Omit<Partial<D1Result<T>>, "meta" | "results"> & {
  results?: T[] | unknown[];
  meta?: object;
};

type EnvDouble = TestDouble<Env>;

type ExactKeys<Base, Value extends Base> = Value
  & Record<Exclude<keyof Value, keyof Base>, never>;

type CloudflareBinding =
  | BrowserRun
  | Ai
  | DurableObjectNamespace
  | Env["SUBSTREAM_AGENTS"]
  | Env["WORKSPACE_DOS"]
  | Env["CRASH_SYMBOLICATOR"]
  | Env["ARTIFACT_HOSTS"]
  | DurableObjectState
  | DurableObjectStorage
  | Flagship
  | ImagesBinding
  | Env["ANALYTICS_LAKEHOUSE"]
  | Env["INFERENCE_LAKEHOUSE"]
  | KVNamespace
  | Queue
  | R2Bucket
  | ScheduledController
  | SqlStorage;

export function createTestEnv<T extends EnvDouble>(value: ExactKeys<EnvDouble, T>): Env {
  // Legacy focused fixtures share a connection; isolation tests override these bindings.
  return { TELEMETRY_DB: value.DB, AUDIT_DB: value.DB, ...value } as Env;
}

/** Builds an intentionally malformed environment for contract-failure tests. */
export function createInvalidTestEnv(value: { [Key in keyof Env]?: unknown }): Env {
  return value as unknown as Env;
}

/**
 * A partial Durable Object *instance*, for the one place production code is
 * handed the object rather than a stub: the self-reference registry an object
 * writes itself into so a helper addressing its name does not leave the isolate.
 */
export function createTestDurableObjectInstance<T extends object>(value: TestDouble<T>): T {
  return value as unknown as T;
}

export function createTestD1Database<T extends TestDouble<D1Database>>(
  value: T,
): D1Database {
  return value as unknown as D1Database;
}

export function createTestD1PreparedStatement<T extends TestDouble<D1PreparedStatement>>(
  value: T,
): D1PreparedStatement {
  return value as unknown as D1PreparedStatement;
}

export function createTestD1Result<T>(value: D1ResultDouble<T> | D1Result<unknown>): D1Result<T> {
  return value as unknown as D1Result<T>;
}

export function createTestD1Results<T>(
  value: Array<D1ResultDouble<T> | D1Result<unknown>>,
): D1Result<T>[] {
  return value as unknown as D1Result<T>[];
}

export function createCloudflareTestBinding<
  T extends CloudflareBinding,
  Double extends TestDouble<T> = TestDouble<T>,
>(value: Double): T {
  return value as unknown as T;
}

/** The array-buffer overload used by binary KV cache tests. */
export function createTestBinaryKvNamespace(value: {
  getWithMetadata: (
    key: string,
    type: "arrayBuffer",
  ) => Promise<KVNamespaceGetWithMetadataResult<ArrayBuffer, unknown>>;
  put: KVNamespace["put"];
}): KVNamespace {
  return value as unknown as KVNamespace;
}

export function createTestDurableObjectId(value: string): DurableObjectId {
  return value as unknown as DurableObjectId;
}

export function createTestJurisdictionalDurableObjectId(
  value: string,
  jurisdiction: "us" | "eu",
): DurableObjectId {
  return {
    toString: () => value,
    equals: (other) => other.toString() === value,
    jurisdiction,
  } as DurableObjectId;
}
