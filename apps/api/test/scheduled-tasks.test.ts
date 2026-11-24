import { afterEach, describe, expect, it, vi } from "vitest";
import { runScheduledTasks } from "../src/scheduled-tasks";

const env = { AVALON_REGION: "global", LOG_LEVEL: "info" } as const;
const r2InternalError = () =>
  new Error("list: We encountered an internal error. Please try again. (10001)");

describe("runScheduledTasks", () => {
  afterEach(() => vi.restoreAllMocks());

  it("finishes every task and names the one that failed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const finished: string[] = [];
    const failure = r2InternalError();

    await expect(runScheduledTasks(env, {
      sessions: async () => { finished.push("sessions"); },
      telemetry: async () => { throw failure; },
      billing: async () => { finished.push("billing"); },
    })).rejects.toBe(failure);

    expect(finished).toEqual(["sessions", "billing"]);
    expect(logged.mock.calls.map(([entry]) => {
      const { event, task, error_code } = entry as Record<string, unknown>;
      return { event, task, error_code };
    })).toEqual([{
      event: "scheduled_task_failed",
      task: "telemetry",
      error_code: "scheduled_task_failed:r2_internal_error",
    }]);
  });

  it("settles a task that throws before returning a promise", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ran = vi.fn(async () => undefined);

    await expect(runScheduledTasks(env, {
      synchronous: (() => { throw new Error("thrown_synchronously"); }) as () => Promise<void>,
      other: ran,
    })).rejects.toThrow("thrown_synchronously");
    expect(ran).toHaveBeenCalledOnce();
  });

  it("lists every failed task when more than one fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runScheduledTasks(env, {
      first: async () => { throw new Error("one"); },
      second: async () => { throw new Error("two"); },
    })).rejects.toThrow("scheduled_tasks_failed: first, second");
  });

  it("resolves when every task succeeds", async () => {
    await expect(runScheduledTasks(env, { only: async () => 1 })).resolves.toBeUndefined();
  });
});
