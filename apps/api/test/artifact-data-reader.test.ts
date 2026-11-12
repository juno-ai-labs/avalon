import { describe, expect, it } from "vitest";

import { artifactDataReader, artifactDataWriteAccess } from "../src/services/workstream-artifact-data-wiring";

const run = { automationId: "a", runId: "r" };
const member = { type: "user", userId: "member" };
const coordinator = { type: "user", userId: "coordinator" };

describe("who a run reads a site's data as", () => {
  it("reads as the member a run runs as", () => {
    expect(artifactDataReader({ executionPrincipal: member })).toBe("member");
  });

  it("reads every row in an unattended Sidekick run and the agents it starts", () => {
    expect(artifactDataReader({ executionPrincipal: coordinator, automationRun: run })).toBeNull();
    expect(artifactDataReader({
      executionPrincipal: coordinator,
      automationDelegation: { runId: "r", stopGeneration: 0 },
    })).toBeNull();
  });

  it("reads as the member typing into a Sidekick run, not as the run's coordinator", () => {
    expect(artifactDataReader({
      executionPrincipal: coordinator,
      automationRun: run,
      automationContinuation: { senderUserId: "member" },
    })).toBe("member");
  });

  it("reads every row for an Organization principal", () => {
    expect(artifactDataReader({ executionPrincipal: { type: "workspace" } })).toBeNull();
  });
});

describe("which runs are offered write_artifact_data", () => {
  it("offers it to a Canvas's Chat run by a person", () => {
    expect(artifactDataWriteAccess({ executionPrincipal: member, parentKind: "canvas" })).toEqual({ kind: "canvas_chat" });
    expect(artifactDataWriteAccess({ executionPrincipal: member, parentKind: "canvas", substreamId: "0" }))
      .toEqual({ kind: "canvas_chat" });
  });

  it("offers it to a Sidekick run, naming the Sidekick from the run and not from the parent", () => {
    expect(artifactDataWriteAccess({
      executionPrincipal: coordinator, parentKind: "automation", substreamId: "run-child", automationRun: run,
    })).toEqual({ kind: "sidekick_run", sidekickId: "a", runId: "r" });
  });

  it("offers it to a run that acts as the Sidekick itself, with no person behind it", () => {
    expect(artifactDataWriteAccess({ executionPrincipal: { type: "workspace" }, parentKind: "automation", automationRun: run }))
      .toEqual({ kind: "sidekick_run", sidekickId: "a", runId: "r" });
  });

  it("offers it to a Sidekick's wizard run by a person, naming the Sidekick from the parent", () => {
    expect(artifactDataWriteAccess({ executionPrincipal: member, parentKind: "automation", parentId: "s", substreamId: "0" }))
      .toEqual({ kind: "sidekick_wizard", sidekickId: "s" });
    expect(artifactDataWriteAccess({ executionPrincipal: member, parentKind: "automation", parentId: "s" }))
      .toEqual({ kind: "sidekick_wizard", sidekickId: "s" });
  });

  it("offers it to nobody else", () => {
    // A wizard under Organization authority, a wizard's background agent, and
    // a run child woken without its run.
    expect(artifactDataWriteAccess({ executionPrincipal: { type: "workspace" }, parentKind: "automation", parentId: "s" }))
      .toBeNull();
    expect(artifactDataWriteAccess({
      executionPrincipal: member, parentKind: "automation", parentId: "s", substreamId: "helper", backgroundAgent: true,
    })).toBeNull();
    expect(artifactDataWriteAccess({ executionPrincipal: member, parentKind: "automation", parentId: "s", substreamId: "run-child" }))
      .toBeNull();
    // A background agent, whether a Canvas's or one a Sidekick run started.
    expect(artifactDataWriteAccess({ executionPrincipal: member, parentKind: "canvas", substreamId: "0", backgroundAgent: true }))
      .toBeNull();
    expect(artifactDataWriteAccess({
      executionPrincipal: coordinator, parentKind: "automation", substreamId: "worker",
      automationDelegation: { runId: "r", stopGeneration: 0 },
    })).toBeNull();
    expect(artifactDataWriteAccess({
      executionPrincipal: coordinator, parentKind: "automation", substreamId: "worker", automationRun: run, backgroundAgent: true,
    })).toBeNull();
    // A Chat under Organization authority has no person to write as.
    expect(artifactDataWriteAccess({ executionPrincipal: { type: "workspace" }, parentKind: "canvas" })).toBeNull();
    // Any other conversation under a Canvas, and any other parent kind.
    expect(artifactDataWriteAccess({ executionPrincipal: member, parentKind: "canvas", substreamId: "side" })).toBeNull();
    expect(artifactDataWriteAccess({ executionPrincipal: member, parentKind: "workstream" })).toBeNull();
    expect(artifactDataWriteAccess({ executionPrincipal: member, parentKind: "canvas", automationRun: run })).toBeNull();
  });
});
