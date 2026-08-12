/**
 * Centralized, typed construction for partial Cloudflare runtime test doubles.
 *
 * Workerd bindings contain members that focused unit tests do not exercise, so
 * a small fake cannot implement the complete ambient interface. These helpers
 * still type-check every member the fake supplies; only the final completeness
 * assertion lives here, where it cannot silently spread through test files.
 */
import type { Env } from "../../src/env";

type TestDoubleMember<Value> = Value extends object
  ? Value | TestDouble<Value> | ((...args: any[]) => unknown)
  : Value;

type TestDouble<T> = {
  [Key in keyof T]?: TestDoubleMember<T[Key]> | undefined;
};

type D1ResultDouble<T> = Omit<Partial<D1Result<T>>, "meta" | "results"> & {
  results?: T[] | unknown[];
  meta?: object;
};

type EnvDouble = TestDouble<Env>;

type CloudflareBinding =
  | Ai
  | DurableObjectNamespace
  | DurableObjectState
  | DurableObjectStorage
  | Flagship
  | ImagesBinding
  | Queue
  | R2Bucket
  | VectorizeIndex;

export function createTestEnv<T extends EnvDouble>(value: T): Env {
  return value as Env;
}

/** Builds an intentionally malformed environment for contract-failure tests. */
export function createInvalidTestEnv(value: { [Key in keyof Env]?: unknown }): Env {
  return value as unknown as Env;
}

export function createTestD1Database<T extends TestDouble<D1Database>>(value: T): D1Database {
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
