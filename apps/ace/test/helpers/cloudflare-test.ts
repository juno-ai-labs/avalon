import type { Env } from '../../src/env';

type TestDoubleResult<Value> = Value extends Promise<unknown>
  ? Promise<unknown>
  : Value extends object ? object : Value;

type BivariantMethod<Arguments extends unknown[], Result> = {
  bivarianceHack(...args: Arguments): Result;
}['bivarianceHack'];

type TestDoubleMember<Value> = Value extends (...args: infer Arguments) => infer Result
  ? Value | BivariantMethod<Arguments, TestDoubleResult<Result>>
  : Value extends object ? Value | TestDouble<Value> : Value;

type TestDouble<T> = { [Key in keyof T]?: TestDoubleMember<T[Key]> | undefined };

export function createTestEnv(value: TestDouble<Env>): Env {
  return value as Env;
}

export function createTestD1Database(value: TestDouble<D1Database>): D1Database {
  return value as D1Database;
}

export function createTestQueue(value: TestDouble<Queue>): Queue {
  return value as Queue;
}

export function createTestBatch(value: TestDouble<MessageBatch<unknown>>): MessageBatch<unknown> {
  return value as MessageBatch<unknown>;
}
