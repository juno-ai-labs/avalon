import { describe, expect, it } from "vitest";
import { z } from "zod";

import { recordWorkspaceScheduleFailure } from "../src/services/workspace-schedule-execution";
import { createTestD1Database, createTestEnv } from "./helpers/cloudflare-test";

/**
 * The audit rows a schedule or a watch writes when its target fails. Both
 * targets build their Workflow input from a stored row, so a row that no
 * longer parses is the failure an operator most needs the field for — and
 * both used to write the generic constant with the issue list as JSON in
 * `message`.
 */
function recordingEnv() {
  const binds: unknown[][] = [];
  const env = createTestEnv({
    DB: createTestD1Database({
      prepare: () => ({
        bind: (...values: unknown[]) => {
          binds.push(values);
          return { async run() { return { success: true, meta: { changes: 1 } }; } };
        },
      }),
    }),
  });
  return { env, binds };
}

function metadataOf(binds: unknown[][]): { code: string; message: string } {
  return JSON.parse(String(binds[0]![3])) as { code: string; message: string };
}

const rejection = (() => {
  const result = z.strictObject({ connection: z.strictObject({ connectorType: z.enum(["slack", "linear"]) }) })
    .safeParse({ connection: { connectorType: "member content must remain absent" } });
  if (result.success) throw new Error("expected a rejection");
  return result.error;
})();

describe("the operator-visible record of a schedule target that failed", () => {
  it("names the field a stored schedule row failed, behind the row's own constant", async () => {
    const { env, binds } = recordingEnv();
    await recordWorkspaceScheduleFailure(
      { env, workspaceEnv: env, workspaceId: "workspace", directory: {} as never, notificationIntents: {} as never },
      { kind: "schedule", id: "schedule-1" } as never,
      rejection,
    );
    const metadata = metadataOf(binds);
    expect(metadata.code).toBe("schedule_execution_failed:connection.connectorType:invalid_value");
    expect(metadata.message).not.toContain("member content must remain absent");
  });

  it("names the field a stored watch row failed the same way", async () => {
    const { env, binds } = recordingEnv();
    await recordWorkspaceScheduleFailure(
      { env, workspaceEnv: env, workspaceId: "workspace", directory: {} as never, notificationIntents: {} as never },
      { kind: "watch", id: "watch-1" } as never,
      rejection,
    );
    expect(metadataOf(binds).code).toBe("resource_watch_poll_failed:connection.connectorType:invalid_value");
  });

  it("keeps the constant for a target that threw a code, and the code in the message", async () => {
    const { env, binds } = recordingEnv();
    await recordWorkspaceScheduleFailure(
      { env, workspaceEnv: env, workspaceId: "workspace", directory: {} as never, notificationIntents: {} as never },
      { kind: "schedule", id: "schedule-1" } as never,
      new Error("connector_poll_timeout"),
    );
    expect(metadataOf(binds)).toEqual({ code: "schedule_execution_failed", message: "connector_poll_timeout" });
  });
});
