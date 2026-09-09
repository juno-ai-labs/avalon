import { afterEach, expect, it, vi } from "vitest";
import { MigratableDurableObject } from "../src/durable-objects/migratable-durable-object";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";

// Pure clock arithmetic; runtime acceptance and header emission are covered in
// durable-object-runtime.test.ts. No storage or platform lifecycle is simulated.
class ClockProbe extends MigratableDurableObject {
  protected migrationPlan() {
    return { component: "clock_probe", className: "ClockProbe", migrations: [] };
  }

  protected migrationsReady() { return Promise.resolve(); }

  age() { return this.instanceAgeMs(); }
}

afterEach(() => vi.useRealTimers());

it("measures age from each instance's construction and clamps clock reversal", () => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  const create = () => new ClockProbe(
    createCloudflareTestBinding<DurableObjectState>({}), createTestEnv({}),
  );
  const first = create();
  expect(first.age()).toBe(0);
  vi.advanceTimersByTime(1_234);
  expect(first.age()).toBe(1_234);
  const second = create();
  expect(second.age()).toBe(0);
  vi.advanceTimersByTime(57);
  expect(first.age()).toBe(1_291);
  expect(second.age()).toBe(57);
  vi.setSystemTime(1_699_999_999_999);
  expect(first.age()).toBe(0);
});
