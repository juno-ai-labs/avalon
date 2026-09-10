/**
 * The readiness barrier: when a seeded demo is Ready.
 *
 * Seeding writes through the room objects, and what a presenter sees — the
 * sidebar, the mention badge, the home screen's "waiting for you" — is a
 * projection that arrives later, through two Queue hops. Ready is therefore not
 * "the seeder finished": it is "every intended viewer's projection matches the
 * pack". This module states what should match and reads whether it does.
 *
 * Two rules from the PRD shape it:
 *
 * - **Read as each viewer, through the ordinary surfaces.** The directory read
 *   the sidebar makes and the attention read the home screen makes, as that
 *   person — following pagination, so a first page is never the barrier. Those
 *   reads open nothing. Canonical content is read as the room's creator, who
 *   opened the room by seeding it, and never as the presenter, whose unopened
 *   state is the demo.
 * - **Expect from the pack and the receipts, never from what the workspace
 *   happens to contain.** The pack says which rooms exist, who is in them, how
 *   each ends, and what each verified viewer should find; the receipts say
 *   which ids those rooms got. What the directory answers is compared against
 *   that, and a mismatch is a named gap the operator can read while it waits.
 *
 * No wait lives here. `checkDemoReadiness` is one comparison; the preparation
 * operation decides how often to ask and how long, which is the wait policy the
 * PRD hands to the team. `docs/demo-workspaces.md` owns the feature.
 */
import type { DemoReadinessGapSchema } from "@rally/contracts";
import type { z } from "zod";
import type { Workstream } from "@rally/contracts";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { AutomationService } from "./automation-service";
import {
  packRoomFacts,
  packSidekickFacts,
  visibleRoomsFor,
  visibleSidekicksFor,
  type DemoCast,
  type DemoPack,
  type DemoPackRoomFacts,
} from "./demo-pack";
import { demoMemberAuth, type DemoSeedReceipt } from "./demo-seeder";
import { workspaceAttention } from "./workspace-attention-service";
import { WorkstreamDirectoryService } from "./workstream-directory-service";
import { WorkstreamObjectClient } from "./workstream-object-client";

/** One room as one viewer should find it. */
export interface DemoRoomExpectation {
  room: string;
  workstreamId: string;
  title: string;
  scope: "workspace" | "personal";
  harnessStatus: "completed" | "needs_input";
  /** Everyone in the room at the end, by user id. */
  participantUserIds: string[];
  /** The creator, by user id: who canonical content is read as. */
  creatorUserId: string;
  unseen: boolean;
  hasUnread: boolean;
  mentioned: boolean;
  /** The resources the room's uploads attached, from their receipts. */
  resourceIds: string[];
  /** Whether a real open elicitation is expected, from the closing run's receipt. */
  elicitationId: string | null;
}

/** One Sidekick as one viewer should find it in the Sidekicks directory. */
export interface DemoSidekickExpectation {
  /** The pack's step id, which names the Sidekick in a gap. */
  stepId: string;
  sidekickId: string;
  name: string;
  scope: "personal" | "workspace";
  /** Whether the pack seeded a run for it, from its receipt. */
  runId: string | null;
}

/** Everything one verified viewer should find, rooms newest first. */
export interface DemoViewExpectation {
  role: string;
  viewerUserId: string;
  rooms: DemoRoomExpectation[];
  sidekicks: DemoSidekickExpectation[];
  attention: { waitingForYou: number; waitingReason: "mentioned" | "needs_input" | "unseen" | null };
}

export interface DemoReadinessManifest {
  packVersion: string;
  views: DemoViewExpectation[];
}

/**
 * What the workspace should look like, from the pack's steps, its verified
 * viewers, and the seeder's receipts. Pure: it reads nothing.
 *
 * Every room the pack creates must have its create receipt, and every upload
 * and closing question its receipt — the barrier runs after seeding completed,
 * and a manifest for a half-seeded pack would describe a demo nobody asked for.
 */
export function demoReadinessManifest(
  pack: DemoPack,
  cast: DemoCast,
  receipts: readonly DemoSeedReceipt[],
): DemoReadinessManifest {
  if (pack.expect.length === 0) {
    // A pack that names no viewer would be Ready on its first check, having
    // proved nothing. That is a pack defect, and it stops preparation here.
    throw new ApiError(409, "demo_pack_expects_nothing", "The pack names no viewer for the readiness check");
  }
  const byAction = new Map(receipts.map((receipt) => [receipt.actionId, receipt]));
  const created = new Map(
    receipts.filter((receipt) => receipt.kind === "create_workstream").map((receipt) => [receipt.room, receipt]),
  );
  const sidekickFacts = packSidekickFacts(pack.steps);
  const sidekicks = new Map(sidekickFacts.map((facts) => {
    const receipt = byAction.get(facts.stepId);
    if (!receipt?.sidekickId) {
      throw new ApiError(409, "demo_readiness_sidekick_unconfirmed", `Sidekick "${facts.stepId}" has no receipt`);
    }
    if (facts.hasFirstRun && !receipt.sidekickRunId) {
      throw new ApiError(409, "demo_readiness_sidekick_run_unconfirmed", `Sidekick "${facts.stepId}" has no confirmed run`);
    }
    return [facts.stepId, {
      stepId: facts.stepId,
      sidekickId: receipt.sidekickId,
      name: facts.name,
      scope: facts.scope,
      runId: receipt.sidekickRunId,
    } satisfies DemoSidekickExpectation];
  }));
  const facts = packRoomFacts(pack.steps);
  const rooms = new Map<string, Omit<DemoRoomExpectation, "unseen" | "hasUnread" | "mentioned">>();
  for (const room of facts.values()) {
    const receipt = created.get(room.room);
    if (!receipt?.workstreamId) throw new ApiError(409, "demo_readiness_room_unconfirmed", `Room "${room.room}" has no receipt`);
    const resourceIds = room.uploads.map((actionId) => {
      const upload = byAction.get(actionId);
      if (!upload?.resourceId) throw new ApiError(409, "demo_readiness_upload_unconfirmed", `Upload "${actionId}" has no receipt`);
      return upload.resourceId;
    });
    const closing = room.finalState === "needs_input"
      ? receipts.find((candidate) => candidate.room === room.room && candidate.runOutcome === "needs_input") ?? null
      : null;
    if (room.finalState === "needs_input" && !closing?.elicitationId) {
      throw new ApiError(409, "demo_readiness_question_unconfirmed", `Room "${room.room}" has no confirmed question`);
    }
    rooms.set(room.room, {
      room: room.room,
      workstreamId: receipt.workstreamId,
      title: room.title,
      scope: room.scope,
      harnessStatus: room.finalState,
      participantUserIds: room.seated.map((role) => cast[role]!.userId),
      creatorUserId: cast[room.creator]!.userId,
      resourceIds,
      elicitationId: closing?.elicitationId ?? null,
    });
  }
  const newestFirst = (left: DemoPackRoomFacts, right: DemoPackRoomFacts) => right.lastStepIndex - left.lastStepIndex;
  return {
    packVersion: pack.version,
    views: pack.expect.map((expectation) => ({
      role: expectation.viewer,
      viewerUserId: cast[expectation.viewer]!.userId,
      rooms: visibleRoomsFor(expectation.viewer, facts.values()).sort(newestFirst).map((room) => ({
        ...rooms.get(room.room)!,
        ...expectation.rooms[room.room]!,
      })),
      // Not part of `expect`: which Sidekicks a viewer is offered follows from
      // scope and authorship alone, with none of the per-viewer opened/unread
      // state a room carries, so there is nothing here for a pack to state that
      // the steps do not already say.
      sidekicks: visibleSidekicksFor(expectation.viewer, sidekickFacts)
        .map((visible) => sidekicks.get(visible.stepId)!),
      attention: expectation.attention,
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

/** Pages of this size, followed until the directory says there are no more. */
const DIRECTORY_PAGE_SIZE = 100;

async function viewerAuth(env: Env, operationId: string, workspaceId: string, userId: string): Promise<AuthContext> {
  // The barrier reads as the viewer, and the viewer is whoever membership says
  // they are — the same resolution the seeder uses to write. A viewer the
  // workspace no longer seats is refused here rather than read with an
  // invented role: the directory and attention reads below do not re-check
  // membership, so an authority fabricated for them would be the one place a
  // non-member's view of the workspace was ever computed.
  const member = await demoMemberAuth(env, { operationId, workspaceId, userId });
  if (!member) {
    throw new ApiError(409, "demo_readiness_viewer_not_member", `Viewer ${userId} is not an active member of the workspace`);
  }
  return member.auth;
}

/** Every directory row the viewer would scroll to, across every page. */
async function wholeDirectory(env: Env, auth: AuthContext): Promise<Workstream[]> {
  const directory = new WorkstreamDirectoryService(env, auth);
  const items: Workstream[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await directory.list(DIRECTORY_PAGE_SIZE, before);
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    before = page.nextCursor;
  }
}

function compareRoom(
  expected: DemoRoomExpectation,
  actual: Workstream,
  viewerUserId: string,
): DemoReadinessGap[] {
  const gaps: DemoReadinessGap[] = [];
  const gap = (code: string, detail: string) => gaps.push({ viewerUserId, room: expected.room, code, detail });
  if (actual.title !== expected.title) gap("title", `"${actual.title}" instead of "${expected.title}"`);
  if (actual.titleStatus !== "settled") gap("title_status", `title is ${actual.titleStatus}`);
  if (actual.scope !== expected.scope) gap("scope", `${actual.scope} instead of ${expected.scope}`);
  if (actual.harnessStatus !== expected.harnessStatus) {
    gap("state", `${actual.harnessStatus} instead of ${expected.harnessStatus}`);
  }
  if (actual.youAreMentioned !== expected.mentioned) {
    gap("mentioned", expected.mentioned ? "the mention has not arrived" : "mentioned when the pack mentions nobody");
  }
  if (actual.unseen !== expected.unseen) gap("unseen", expected.unseen ? "not marked new" : "marked new");
  if (actual.hasUnread !== expected.hasUnread) gap("unread", expected.hasUnread ? "not marked unread" : "marked unread");
  if (expected.scope === "personal") {
    const shown = actual.participantUserIds.length + actual.participantExtraCount;
    const unexpected = actual.participantUserIds.filter((id) => !expected.participantUserIds.includes(id));
    if (shown !== expected.participantUserIds.length || unexpected.length > 0) {
      gap("participants", `${shown} shown, ${expected.participantUserIds.length} expected`);
    }
  }
  return gaps;
}

/**
 * Compare one viewer's Sidekicks directory with what the pack published.
 *
 * The directory row is a projection, delivered by the same effect Queue the
 * sidebar's rooms arrive through, so a Sidekick that was published is not yet a
 * Sidekick anybody can see — which is exactly what this barrier exists to wait
 * for. `nextRunAt` is the part that proves the schedule was armed rather than
 * merely written down: an accepted definition whose apply died before its
 * schedule alarm would still be listed, and would never run.
 *
 * A seeded briefing is checked the same way and for the same reason: the run
 * finished inside its own conversation while seeding, and the row that puts it
 * in the Sidekick's history is a projection of that conversation, delivered
 * afterwards. A demo that shows a Sidekick which has apparently never run is
 * one whose effects have not all landed yet.
 */
async function compareSidekicks(
  env: Env,
  auth: AuthContext,
  view: DemoViewExpectation,
  gap: (room: string | null, code: string, detail: string) => void,
): Promise<void> {
  if (view.sidekicks.length === 0) return;
  const service = new AutomationService(env, auth);
  const { items } = await service.listSidekicks();
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const expected of view.sidekicks) {
    const actual = byId.get(expected.sidekickId);
    if (!actual) {
      gap(null, "sidekick_missing", `"${expected.name}" is not listed`);
      continue;
    }
    if (actual.name !== expected.name) {
      gap(null, "sidekick_name", `"${actual.name}" instead of "${expected.name}"`);
    }
    if (actual.scope !== expected.scope) {
      gap(null, "sidekick_scope", `"${expected.name}" is ${actual.scope} instead of ${expected.scope}`);
    }
    if (actual.status !== "active") {
      gap(null, "sidekick_status", `"${expected.name}" is ${actual.status} instead of active`);
    }
    if (actual.nextRunAt === null) {
      gap(null, "sidekick_schedule", `"${expected.name}" has no next run`);
    }
    if (expected.runId !== null) {
      const runs = await service.runs(expected.sidekickId);
      const run = runs.items.find((candidate) => candidate.id === expected.runId) ?? null;
      if (!run) gap(null, "sidekick_run_missing", `"${expected.name}" shows no briefing`);
      else if (run.status !== "completed") {
        gap(null, "sidekick_run_state", `"${expected.name}"'s briefing is ${run.status} instead of completed`);
      }
    }
  }
}

/**
 * Compare every verified viewer's projection with the manifest, once.
 *
 * Reads the whole directory and the attention summary as each viewer, and the
 * canonical room detail as each room's creator; reports every gap rather than
 * the first, because the operator's "Waiting for workspace" state lists what
 * has not arrived.
 */
export async function checkDemoReadiness(
  env: Env,
  input: { operationId: string; workspaceId: string; manifest: DemoReadinessManifest },
): Promise<DemoReadinessReport> {
  const gaps: DemoReadinessGap[] = [];
  const canonicalChecked = new Set<string>();
  for (const view of input.manifest.views) {
    const auth = await viewerAuth(env, input.operationId, input.workspaceId, view.viewerUserId);
    const gap = (room: string | null, code: string, detail: string) =>
      gaps.push({ viewerUserId: view.viewerUserId, room, code, detail });
    const [items, attention] = await Promise.all([
      wholeDirectory(env, auth),
      workspaceAttention(env, auth),
    ]);
    const byId = new Map(items.map((item) => [item.id, item]));
    const expectedIds = new Set(view.rooms.map((room) => room.workstreamId));
    for (const item of items) {
      if (!expectedIds.has(item.id)) gap(null, "room_unexpected", `"${item.title}" (${item.id}) is listed and not in the pack`);
    }
    for (const room of view.rooms) {
      const actual = byId.get(room.workstreamId);
      if (!actual) {
        gap(room.room, "room_missing", "not listed");
        continue;
      }
      gaps.push(...compareRoom(room, actual, view.viewerUserId));
    }
    const listedOrder = items.filter((item) => expectedIds.has(item.id)).map((item) => item.id);
    const expectedOrder = view.rooms.map((room) => room.workstreamId);
    if (listedOrder.length === expectedOrder.length && listedOrder.some((id, index) => id !== expectedOrder[index])) {
      const byWorkstream = new Map(view.rooms.map((room) => [room.workstreamId, room.room]));
      gap(null, "order", `listed ${listedOrder.map((id) => byWorkstream.get(id)).join(", ")}; expected ${view.rooms.map((room) => room.room).join(", ")}`);
    }
    await compareSidekicks(env, auth, view, gap);
    if (attention.waitingForYou !== view.attention.waitingForYou
      || attention.waitingReason !== view.attention.waitingReason) {
      gap(null, "attention", `${attention.waitingForYou} waiting (${attention.waitingReason ?? "none"}); expected ${view.attention.waitingForYou} (${view.attention.waitingReason ?? "none"})`);
    }
    // Canonical content, as the creator, once per room across viewers.
    for (const room of view.rooms) {
      if (canonicalChecked.has(room.workstreamId)) continue;
      canonicalChecked.add(room.workstreamId);
      const creator = await viewerAuth(env, input.operationId, input.workspaceId, room.creatorUserId);
      const detail = await new WorkstreamObjectClient(env, creator, room.workstreamId, "0").get();
      if (detail.harnessStatus !== room.harnessStatus) {
        gap(room.room, "canonical_state", `${detail.harnessStatus} instead of ${room.harnessStatus}`);
      }
      if (room.elicitationId && !detail.openElicitations.some((open) => open.id === room.elicitationId)) {
        gap(room.room, "elicitation_missing", "the question is not open");
      }
      const attached = new Set(detail.resources.map((resource) => resource.id));
      for (const resourceId of room.resourceIds) {
        if (!attached.has(resourceId)) gap(room.room, "resource_missing", `${resourceId} is not attached`);
      }
      const seated = new Set(detail.participants.map((participant) => participant.user.id));
      for (const userId of room.participantUserIds) {
        if (!seated.has(userId)) gap(room.room, "participant_missing", `${userId} is not in the room`);
      }
    }
  }
  return { ready: gaps.length === 0, gaps, checkedAt: new Date().toISOString() };
}
