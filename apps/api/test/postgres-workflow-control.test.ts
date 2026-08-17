import { describe, expect, it, vi } from "vitest";

import { signalPostgresAgentLoop, startPostgresAgentLoop } from "../src/postgres/workflow-control";
import { createTestEnv } from "./helpers/cloudflare-test";

describe("Postgres Workflow control", () => {
  it("starts the deterministic regional Workflow with identifier-only input", async () => {
    const create = vi.fn(async () => ({ id: "instance" }));
    const env = createTestEnv({
      AVALON_REGION: "eu",
      POSTGRES_AGENT_LOOP_WORKFLOW: { create },
    });

    await startPostgresAgentLoop(env, {
      runId: "018f4000-0000-7000-8000-000000000001",
      workflowInstanceId: "workstream/one/run/one",
      expectedRunRevision: 1,
    });

    expect(create).toHaveBeenCalledWith({
      id: "workstream/one/run/one",
      params: {
        version: 1,
        region: "eu",
        runId: "018f4000-0000-7000-8000-000000000001",
        workflowInstanceId: "workstream/one/run/one",
        expectedRunRevision: 1,
      },
    });
  });

  it("treats a duplicate deterministic start as successful reconciliation", async () => {
    const env = createTestEnv({
      AVALON_REGION: "global",
      POSTGRES_AGENT_LOOP_WORKFLOW: {
        create: vi.fn(async () => { throw new Error("instance already exists"); }),
      },
    });

    await expect(startPostgresAgentLoop(env, {
      runId: "018f4000-0000-7000-8000-000000000001",
      workflowInstanceId: "workstream/one/run/one",
      expectedRunRevision: 1,
    })).resolves.toBeUndefined();
  });

  it("sends only an opaque durable signal reference to the Workflow", async () => {
    const sendEvent = vi.fn(async () => undefined);
    const get = vi.fn(async () => ({ sendEvent }));
    const env = createTestEnv({
      POSTGRES_AGENT_LOOP_WORKFLOW: { get },
    });

    await signalPostgresAgentLoop(env, "workstream/one/run/one", {
      signalId: "018f4000-0000-7000-8000-000000000002",
      runId: "018f4000-0000-7000-8000-000000000001",
      controlRevision: 2,
      signalKind: "steer",
    });

    expect(get).toHaveBeenCalledWith("workstream/one/run/one");
    expect(sendEvent).toHaveBeenCalledWith({
      type: "run-signal",
      payload: {
        signalId: "018f4000-0000-7000-8000-000000000002",
        runId: "018f4000-0000-7000-8000-000000000001",
        controlRevision: 2,
        signalKind: "steer",
      },
    });
  });
});
