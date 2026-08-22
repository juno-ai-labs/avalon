import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { createTerminalObjectPort } from "../src/services/terminal/object-port";
import type { TerminalObjectPortError } from "../src/services/terminal/object-port";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000004a1";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000004a2";

function portReturning(status: number, body: unknown) {
  const executeTerminalOperation = vi.fn(async () => ({
    status,
    bodyJson: JSON.stringify(body),
  }));
  const stub = { executeTerminalOperation };
  const namespace = createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>({
    idFromName: () => createTestDurableObjectId("terminal-object"),
    get: () => stub,
  });
  const env = createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    SUBSTREAM_AGENTS: namespace,
  });
  return createTerminalObjectPort(env, WORKSPACE_ID, WORKSTREAM_ID);
}

describe("Terminal object port failures", () => {
  it.each([
    ["invalid_terminal_operation", 400, "invalid_terminal_operation"],
    ["workstream_terminal_identity_mismatch", 409, "workstream_terminal_identity_mismatch"],
  ] as const)("preserves the non-retryable %s rejection", async (_name, status, error) => {
    const port = portReturning(status, { error });

    await expect(port.sandbox()).rejects.toMatchObject({
      name: "TerminalObjectPortError",
      code: error,
      details: { operation: "sandbox", outcome: "rejected", retryable: false },
    } satisfies Partial<TerminalObjectPortError>);
  });

  it("preserves a validated not-committed contract", async () => {
    const port = portReturning(409, {
      error: "terminal_operation_not_committed",
      failure: {
        code: "terminal_operation_not_committed",
        message: "The transaction rolled back.",
        outcome: "not_committed",
        retryable: true,
      },
    });

    await expect(port.sandbox()).rejects.toMatchObject({
      code: "terminal_operation_not_committed",
      details: { operation: "sandbox", outcome: "not_committed", retryable: true },
    } satisfies Partial<TerminalObjectPortError>);
  });

  it("does not manufacture rollback safety from a malformed envelope", async () => {
    const port = portReturning(409, { error: "terminal_operation_not_committed" });

    await expect(port.sandbox()).rejects.toMatchObject({
      code: "terminal_operation_protocol_error",
      details: { operation: "sandbox", outcome: "unknown", retryable: false },
    } satisfies Partial<TerminalObjectPortError>);
  });
});
