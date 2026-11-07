/**
 * The readiness barrier: when a seeded demo is Ready.
 *
 * Seeding writes through the conversation objects, and what a presenter sees —
 * the Canvas list, a Sidekick's row, the run in its shared conversation — is a
 * projection that arrives later, through the effect Queue and the Organization
 * object's own alarms. Ready is therefore not "the seeder finished": it is
 * "every verified viewer's lists and every seeded Canvas and Sidekick match
 * the pack". This module states what should match and reads whether it does.
 *
 * Two rules from the PRD shape it:
 *
 * - **Read as each viewer, through the ordinary reads.** The Canvas list the
 *   workspace socket carries and the Sidekick list the library reads, as that
 *   person. Those reads open nothing. Canonical content — a Canvas's
 *   artifacts and its Chat, a Sidekick's shared conversation — is read as the
 *   one who made it, never as the presenter, whose unopened state is the demo.
 * - **Expect from the pack and the receipts, never from what the workspace
 *   happens to contain.** The pack says which Canvases and Sidekicks exist,
 *   who each is shared with, how each Chat ends and how many versions each
 *   artifact has; the receipts say which ids they got. A mismatch is a named
 *   gap the operator can read while it waits.
 *
 * No wait lives here. `checkDemoReadiness` is one comparison; the preparation
 * operation decides how often to ask and how long, which is the wait policy the
 * PRD hands to the team. `docs/demo-workspaces.md` owns the feature.
 */
import { asWorkstreamId, type DemoReadinessGapSchema } from "@rally/contracts";
import type { CanvasSidebarRow } from "@rally/contracts/canvases";
import type { z } from "zod";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { AutomationService } from "./automation-service";
import { CanvasService } from "./canvas-service";
import {
  packCanvasFacts,
  packSidekickFacts,
  visibleCanvasesFor,
  visibleSidekicksFor,
  type DemoCast,
  type DemoPack,
  type DemoPackSharedWith,
} from "./demo-pack";
import { demoMemberAuth, type DemoSeedReceipt } from "./demo-seeder";
import { WorkstreamObjectClient } from "./workstream-object-client";

/** One Canvas as the pack and the receipts describe it. */
export interface DemoCanvasExpectation {
  /** The pack's name for it, which names it in a gap. */
  canvas: string;
  canvasId: string;
  title: string;
  creatorUserId: string;
  writerSidekickId: string | null;
  /** Each artifact at the version the pack publishes it to. */
  artifacts: { resourceId: string; version: number }[];
  /** Documents attached in its Chat. */
  uploadResourceIds: string[];
  /** How its Chat's loop ends, and the open question when it parks on one. */
  harnessStatus: "idle" | "completed" | "needs_input";
  elicitationId: string | null;
}

/** One Sidekick as the pack and the receipts describe it. */
export interface DemoSidekickExpectation {
  sidekick: string;
  sidekickId: string;
  name: string;
  audience: "personal" | "workspace" | "people";
  authorUserId: string;
  /** The seeded run, whose row must sit in the shared conversation. */
  runId: string | null;
}

/**
 * Everything one verified viewer should find. Canvases are in pack order,
 * newest step first, for reading; the barrier does not compare the list's
 * order, because a Canvas's recency is the moment its Chat's effects land in
 * the Organization object, which no pack can state.
 */
export interface DemoViewExpectation {
  role: string;
  viewerUserId: string;
  /** `unread` is stated only for a Canvas this viewer neither made nor wrote in, which they have never opened. */
  canvases: (DemoCanvasExpectation & { unread: boolean | null })[];
  sidekicks: DemoSidekickExpectation[];
}

export interface DemoReadinessManifest {
  packVersion: string;
  canvases: DemoCanvasExpectation[];
  sidekicks: DemoSidekickExpectation[];
  views: DemoViewExpectation[];
}

function sidekickAudience(sharedWith: DemoPackSharedWith): DemoSidekickExpectation["audience"] {
  return sharedWith === "organization" ? "workspace" : sharedWith.length > 0 ? "people" : "personal";
}

/**
 * What the workspace should look like, from the pack's steps, its verified
 * viewers, and the seeder's receipts. Pure: it reads nothing.
 *
 * Every Canvas, publish, upload, Sidekick and seeded run must have its receipt
 * — the barrier runs after seeding completed, and a manifest for a half-seeded
 * pack would describe a demo nobody asked for.
 */
export function demoReadinessManifest(
  pack: DemoPack,
  cast: DemoCast,
  receipts: readonly DemoSeedReceipt[],
): DemoReadinessManifest {
  const byAction = new Map(receipts.map((receipt) => [receipt.actionId, receipt]));
  const required = (actionId: string, code: string, what: string) => {
    const receipt = byAction.get(actionId);
    if (!receipt) throw new ApiError(409, code, `${what} "${actionId}" has no receipt`);
    return receipt;
  };
  const sidekickFacts = packSidekickFacts(pack.steps);
  const sidekicks = new Map(sidekickFacts.map((facts) => {
    const receipt = required(facts.stepId, "demo_readiness_sidekick_unconfirmed", "Sidekick");
    if (facts.hasFirstRun && !receipt.sidekickRunId) {
      throw new ApiError(409, "demo_readiness_sidekick_run_unconfirmed", `Sidekick "${facts.stepId}" has no confirmed run`);
    }
    if (facts.writesCanvas && (!receipt.canvasId || !receipt.resourceId)) {
      throw new ApiError(409, "demo_readiness_sidekick_canvas_unconfirmed", `Sidekick "${facts.stepId}" has no confirmed Canvas`);
    }
    return [facts.sidekick, {
      expectation: {
        sidekick: facts.sidekick,
        sidekickId: receipt.sidekickId!,
        name: facts.name,
        audience: sidekickAudience(facts.sharedWith),
        authorUserId: cast[facts.author]!.userId,
        runId: receipt.sidekickRunId,
      } satisfies DemoSidekickExpectation,
      receipt,
    }];
  }));
  const facts = packCanvasFacts(pack.steps);
  const canvases = new Map<string, DemoCanvasExpectation>();
  for (const canvas of facts.values()) {
    let canvasId: string;
    let artifacts: DemoCanvasExpectation["artifacts"];
    if (canvas.writer !== null) {
      const { receipt } = sidekicks.get(canvas.writer)!;
      canvasId = receipt.canvasId!;
      artifacts = [{ resourceId: receipt.resourceId!, version: 1 }];
    } else {
      const opening = pack.steps.find((step) => step.kind === "create_canvas" && step.canvas === canvas.canvas)!;
      canvasId = required(opening.id, "demo_readiness_canvas_unconfirmed", "Canvas").canvasId!;
      // One artifact per path, at the resource its publishes landed on and the
      // version their count reaches.
      const byPath = new Map<string, { resourceId: string; version: number }>();
      for (const step of pack.steps) {
        if (step.kind !== "canvas_artifact" || step.canvas !== canvas.canvas) continue;
        const receipt = required(step.id, "demo_readiness_artifact_unconfirmed", "Artifact");
        byPath.set(step.path, { resourceId: receipt.resourceId!, version: (byPath.get(step.path)?.version ?? 0) + 1 });
      }
      artifacts = [...byPath.values()];
    }
    const closing = canvas.finalState === "needs_input"
      ? receipts.filter((receipt) => receipt.canvas === canvas.canvas && receipt.runOutcome === "needs_input").at(-1) ?? null
      : null;
    if (canvas.finalState === "needs_input" && !closing?.elicitationId) {
      throw new ApiError(409, "demo_readiness_question_unconfirmed", `Canvas "${canvas.canvas}" has no confirmed question`);
    }
    canvases.set(canvas.canvas, {
      canvas: canvas.canvas,
      canvasId,
      title: canvas.title,
      creatorUserId: cast[canvas.creator]!.userId,
      writerSidekickId: canvas.writer === null ? null : sidekicks.get(canvas.writer)!.expectation.sidekickId,
      artifacts,
      uploadResourceIds: canvas.uploads.map((actionId) =>
        required(actionId, "demo_readiness_upload_unconfirmed", "Upload").resourceId!),
      harnessStatus: canvas.finalState,
      elicitationId: closing?.elicitationId ?? null,
    });
  }
  const newestFirst = [...facts.values()].sort((left, right) => right.lastStepIndex - left.lastStepIndex);
  return {
    packVersion: pack.version,
    canvases: [...canvases.values()],
    sidekicks: [...sidekicks.values()].map((entry) => entry.expectation),
    views: pack.verify.map((viewer) => ({
      role: viewer,
      viewerUserId: cast[viewer]!.userId,
      canvases: visibleCanvasesFor(viewer, newestFirst).map((canvas) => ({
        ...canvases.get(canvas.canvas)!,
        // A Canvas never opened is unread to anyone but its creator; a viewer
        // who wrote in one has opened it, and what they have read since
        // depends on what came after, which nothing here models.
        unread: canvas.creator === viewer || canvas.actors.includes(viewer) ? null : true,
      })),
      sidekicks: visibleSidekicksFor(viewer, sidekickFacts).map((visible) => sidekicks.get(visible.sidekick)!.expectation),
    })),
  };
}

/** One thing a viewer's projection does not yet show; the shape is the contract's, because the page renders it. */
export type DemoReadinessGap = z.infer<typeof DemoReadinessGapSchema>;

export interface DemoReadinessReport {
  ready: boolean;
  gaps: DemoReadinessGap[];
  checkedAt: string;
}

async function memberAuth(env: Env, operationId: string, workspaceId: string, userId: string): Promise<AuthContext> {
  // The barrier reads as the viewer, and the viewer is whoever membership says
  // they are — the same resolution the seeder uses to write. A viewer the
  // workspace no longer seats is refused here rather than read with an
  // invented role.
  const member = await demoMemberAuth(env, { operationId, workspaceId, userId });
  if (!member) {
    throw new ApiError(409, "demo_readiness_viewer_not_member", `Viewer ${userId} is not an active member of the workspace`);
  }
  return member.auth;
}

type Gap = (subject: string | null, code: string, detail: string) => void;

function compareCanvasRow(expected: DemoViewExpectation["canvases"][number], actual: CanvasSidebarRow, gap: Gap): void {
  const at = (code: string, detail: string) => gap(expected.canvas, code, detail);
  if (actual.title !== expected.title) at("canvas_title", `"${actual.title}" instead of "${expected.title}"`);
  if (actual.writerSidekickId !== expected.writerSidekickId) {
    at("canvas_writer", `written by ${actual.writerSidekickId ?? "a person"} instead of ${expected.writerSidekickId ?? "a person"}`);
  }
  const kind = expected.artifacts.length > 0 ? "file" : null;
  if (actual.artifactKind !== kind) at("canvas_artifact_kind", `${actual.artifactKind ?? "no artifact"} instead of ${kind ?? "no artifact"}`);
  if (expected.unread !== null && actual.unread !== expected.unread) {
    at("canvas_unread", expected.unread ? "not marked unread" : "marked unread");
  }
}

/**
 * Compare one viewer's Sidekick list with what the pack published. The row is
 * a projection, so a Sidekick that was published is not yet one anybody can
 * see. `nextRunAt` proves the schedule was armed rather than merely written
 * down, and the run's history row that its briefing finished.
 */
async function compareSidekicks(env: Env, auth: AuthContext, view: DemoViewExpectation, gap: Gap): Promise<void> {
  const service = new AutomationService(env, auth);
  const { items } = await service.listSidekicks();
  const expectedIds = new Set(view.sidekicks.map((sidekick) => sidekick.sidekickId));
  for (const item of items) {
    if (!expectedIds.has(item.id)) gap(null, "sidekick_unexpected", `"${item.name}" (${item.id}) is listed and not in the pack`);
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const expected of view.sidekicks) {
    const at = (code: string, detail: string) => gap(expected.sidekick, code, detail);
    const actual = byId.get(expected.sidekickId);
    if (!actual) {
      at("sidekick_missing", `"${expected.name}" is not listed`);
      continue;
    }
    if (actual.name !== expected.name) at("sidekick_name", `"${actual.name}" instead of "${expected.name}"`);
    if ((actual.audience ?? actual.scope) !== expected.audience) {
      at("sidekick_audience", `shared ${actual.audience ?? actual.scope} instead of ${expected.audience}`);
    }
    if (actual.status !== "active") at("sidekick_status", `${actual.status} instead of active`);
    if (actual.nextRunAt === null) at("sidekick_schedule", "has no next run");
    if (expected.runId !== null) {
      const run = (await service.runs(expected.sidekickId)).items.find((candidate) => candidate.id === expected.runId) ?? null;
      if (!run) at("sidekick_run_missing", "shows no run");
      else if (run.status !== "completed") at("sidekick_run_state", `its run is ${run.status} instead of completed`);
    }
  }
}

/**
 * Compare every verified viewer's lists, and every seeded Canvas's and
 * Sidekick's canonical content, with the manifest, once.
 *
 * Reports every gap rather than the first, because the operator's "Waiting
 * for workspace" state lists what has not arrived.
 */
export async function checkDemoReadiness(
  env: Env,
  input: { operationId: string; workspaceId: string; manifest: DemoReadinessManifest },
): Promise<DemoReadinessReport> {
  const gaps: DemoReadinessGap[] = [];
  const auth = (userId: string) => memberAuth(env, input.operationId, input.workspaceId, userId);
  for (const view of input.manifest.views) {
    const viewer = await auth(view.viewerUserId);
    const gap: Gap = (subject, code, detail) => gaps.push({ viewerUserId: view.viewerUserId, room: subject, code, detail });
    const rows = await new CanvasService(env, viewer).list();
    const expectedIds = new Set(view.canvases.map((canvas) => canvas.canvasId));
    for (const row of rows) {
      if (!expectedIds.has(row.id)) gap(null, "canvas_unexpected", `"${row.title}" (${row.id}) is listed and not in the pack`);
    }
    const byId = new Map<string, CanvasSidebarRow>(rows.map((row) => [row.id, row]));
    for (const canvas of view.canvases) {
      const actual = byId.get(canvas.canvasId);
      if (!actual) gap(canvas.canvas, "canvas_missing", "not listed");
      else compareCanvasRow(canvas, actual, gap);
    }
    await compareSidekicks(env, viewer, view, gap);
  }
  // Canonical content, once each, as whoever made it. The first viewer names
  // the gap, because the gap's shape is per viewer and these are everyone's.
  const subjectViewer = input.manifest.views[0]?.viewerUserId;
  if (subjectViewer === undefined) return { ready: gaps.length === 0, gaps, checkedAt: new Date().toISOString() };
  const gap: Gap = (subject, code, detail) => gaps.push({ viewerUserId: subjectViewer, room: subject, code, detail });
  for (const canvas of input.manifest.canvases) {
    const creator = await auth(canvas.creatorUserId);
    const at = (code: string, detail: string) => gap(canvas.canvas, code, detail);
    const detail = await new CanvasService(env, creator).detail(asWorkstreamId(canvas.canvasId));
    for (const expected of canvas.artifacts) {
      const actual = detail.artifacts.find((artifact) => artifact.resourceId === expected.resourceId);
      if (!actual) at("artifact_missing", `${expected.resourceId} is not one of its artifacts`);
      else if (actual.version !== expected.version) at("artifact_version", `${expected.resourceId} is at version ${actual.version} instead of ${expected.version}`);
    }
    if (detail.artifacts.length !== canvas.artifacts.length) {
      at("artifact_count", `${detail.artifacts.length} artifacts instead of ${canvas.artifacts.length}`);
    }
    const chat = await WorkstreamObjectClient.forParent(env, creator, "canvas", canvas.canvasId, "0").get();
    if (chat.harnessStatus !== canvas.harnessStatus) at("canvas_state", `${chat.harnessStatus} instead of ${canvas.harnessStatus}`);
    if (canvas.elicitationId && !chat.openElicitations.some((open) => open.id === canvas.elicitationId)) {
      at("elicitation_missing", "the question is not open");
    }
    const attached = new Set(chat.resources.map((resource) => resource.id));
    for (const resourceId of canvas.uploadResourceIds) {
      if (!attached.has(resourceId)) at("upload_missing", `${resourceId} is not attached`);
    }
  }
  for (const sidekick of input.manifest.sidekicks) {
    if (sidekick.runId === null) continue;
    // A run's row in the shared conversation is a projection of its run row,
    // delivered on the Organization object's alarm.
    const author = await auth(sidekick.authorUserId);
    const boot = await WorkstreamObjectClient.forParent(env, author, "automation", sidekick.sidekickId, "0").boot();
    const key = `sidekick-run:${sidekick.runId}`;
    if (!boot.transcript.ranges.some((range) => range.turns.some((turn) => turn.clientMessageId === key))) {
      gap(sidekick.sidekick, "sidekick_run_row_missing", "its run has no row in its conversation");
    }
  }
  return { ready: gaps.length === 0, gaps, checkedAt: new Date().toISOString() };
}
