/**
 * `SpaceService` against capability doubles for the objects it orders.
 *
 * What is provable here is the *ordering*: which authority is asked first, what
 * is not written when an earlier step refuses, and how a closed refusal code
 * becomes a sentence. The authority behavior itself — the fences, the
 * discoverability test, the membership invariant — is proved against real
 * objects in `test-workers/space-authority.test.ts`, because those are
 * properties of real storage rather than of this file's arithmetic.
 */
import { asSpaceId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { ApiError } from "../src/lib/api-error";
import { SpaceService, spaceRefusal } from "../src/services/space-service";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestEnv,
} from "./helpers/cloudflare-test";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000000d1");
const OWNER = asUserId("00000000-0000-7000-8000-0000000000d2");
const MEMBER = asUserId("00000000-0000-7000-8000-0000000000d3");
const SPACE_ID = asSpaceId("00000000-0000-7000-8000-0000000000d4");
const CHANNEL_ID = asWorkstreamId("00000000-0000-7000-8000-0000000000d5");

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: SPACE_ID,
    name: "Company",
    iconKey: "briefcase",
    colorKey: "blue",
    scope: "workspace",
    status: "active",
    systemRole: null,
    revision: 3,
    participants: [{ userId: OWNER }, { userId: MEMBER }],
    channelCount: 1,
    defaultResourceIds: [],
    defaultSidekickIds: [],
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

interface WorkspaceDouble {
  spaceSummary: ReturnType<typeof vi.fn>;
  listSpaceMembers: ReturnType<typeof vi.fn>;
  noteSpaceAudience: ReturnType<typeof vi.fn>;
  reserveSpace: ReturnType<typeof vi.fn>;
  cancelSpaceReservation: ReturnType<typeof vi.fn>;
  recordSpaceIntentReceipt: ReturnType<typeof vi.fn>;
}

function workspaceDouble(overrides: Partial<WorkspaceDouble> = {}): WorkspaceDouble {
  return {
    spaceSummary: vi.fn(async () => ({ ok: true, space: summary() })),
    listSpaceMembers: vi.fn(async () => ({ ok: true, workstreamIds: [CHANNEL_ID] })),
    noteSpaceAudience: vi.fn(async () => ({ ok: true, space: summary({ revision: 4 }) })),
    reserveSpace: vi.fn(async () => ({ ok: true, space: summary() })),
    cancelSpaceReservation: vi.fn(async () => ({ cancelled: true })),
    recordSpaceIntentReceipt: vi.fn(async () => ({ recorded: true })),
    ...overrides,
  };
}

/**
 * A namespace whose `get` always answers with the same stand-in.
 *
 * The double stands in for the *stub*, never for the namespace: the resolver
 * derives an id from a name and then asks for the object, and both halves have
 * to behave for the service under test to reach anything at all.
 */
function namespaceDouble<
  T extends Env["WORKSPACE_DOS"] | Env["SUBSTREAM_AGENTS"] | Env["SPACE_DOS"]
  | Env["AUTOMATION_DOS"] | Env["WORKSTREAM_DOS"],
>(stub: object): T {
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => stub,
    jurisdiction: () => namespace,
  };
  return createCloudflareTestBinding<T>(namespace as never);
}

function serviceEnv(input: {
  workspace: WorkspaceDouble;
  conversation?: object;
  batch?: () => Promise<unknown>;
}): Env {
  const conversation = input.conversation ?? {
    previewAudienceContainment: vi.fn(async () => true),
  };
  return createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    DB: createTestD1Database({
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
        first: async () => null,
      }),
      batch: input.batch ?? (async () => []),
    }),
    WORKSPACE_DOS: namespaceDouble<Env["WORKSPACE_DOS"]>(input.workspace),
    SUBSTREAM_AGENTS: namespaceDouble<Env["SUBSTREAM_AGENTS"]>(conversation),
    SPACE_DOS: namespaceDouble<Env["SPACE_DOS"]>({}),
    AUTOMATION_DOS: namespaceDouble<Env["AUTOMATION_DOS"]>({}),
    WORKSTREAM_DOS: namespaceDouble<Env["WORKSTREAM_DOS"]>({}),
  });
}

function auth(role: AuthContext["role"] = "owner"): AuthContext {
  return {
    sessionId: "space-service-test",
    userId: OWNER,
    workspaceId: WORKSPACE_ID,
    region: "global",
    role,
    analyticsWorkspaceId: null,
  } satisfies AuthContext;
}

describe("SpaceService audience changes", () => {
  it("given a member Channel with a content fence, when the audience widens, then nothing is written", async () => {
    const workspace = workspaceDouble();
    const env = serviceEnv({
      workspace,
      conversation: { previewAudienceContainment: vi.fn(async () => false) },
    });

    await expect(new SpaceService(env, auth()).updateAudience(SPACE_ID, {
      scope: "workspace",
      participantUserIds: [OWNER, MEMBER],
    })).rejects.toMatchObject({ code: "space_membership_content_fence", status: 409 });

    // The whole point of preflighting every member before changing any of them:
    // widening cannot be taken back, so a fence found on one Channel must stop
    // the Space's own authority from accepting the change at all.
    expect(workspace.noteSpaceAudience).not.toHaveBeenCalled();
  });

  it("given General, when its audience is made personal, then the authority's refusal is surfaced", async () => {
    const workspace = workspaceDouble({
      spaceSummary: vi.fn(async () => ({ ok: true, space: summary({ systemRole: "general" }) })),
      noteSpaceAudience: vi.fn(async () => ({
        ok: false, code: "space_protected", unreachableUserIds: [],
      })),
    });

    await expect(new SpaceService(serviceEnv({ workspace }), auth()).updateAudience(SPACE_ID, {
      scope: "personal",
      participantUserIds: [OWNER],
    })).rejects.toMatchObject({ code: "space_protected", status: 409 });
  });

  it("given an ordinary member, when they remove somebody else, then the role gate refuses it", async () => {
    const workspace = workspaceDouble();

    await expect(new SpaceService(serviceEnv({ workspace }), auth("member")).updateAudience(SPACE_ID, {
      scope: "personal",
      participantUserIds: [OWNER],
    })).rejects.toMatchObject({ code: "participant_removal_denied", status: 403 });
    expect(workspace.noteSpaceAudience).not.toHaveBeenCalled();
  });
});

describe("SpaceService creation", () => {
  it("given a Space whose object cannot be opened, when creation fails, then the reservation is cancelled", async () => {
    const workspace = workspaceDouble();
    const env = serviceEnv({
      workspace,
      batch: async () => { throw new Error("d1_unavailable"); },
    });

    await expect(new SpaceService(env, auth()).create({
      name: "Company", iconKey: "briefcase", colorKey: "blue", scope: "workspace",
    })).rejects.toThrow(/d1_unavailable/u);

    // A reservation left behind would be a Space in every member's sidebar that
    // answers nothing, because the object it names was never opened.
    expect(workspace.cancelSpaceReservation).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: SPACE_ID }),
    );
  });
});

describe("Space refusals", () => {
  it("given each closed code, when it is rendered, then it names the Space and its status", () => {
    expect(spaceRefusal("space_membership_final", "Company")).toMatchObject({
      status: 409,
      code: "space_membership_final",
      message: expect.stringContaining("Company"),
    });
    expect(spaceRefusal("space_audience_incompatible", "Company", [MEMBER])).toMatchObject({
      status: 409,
      message: expect.stringContaining("1 of its readers"),
    });
    // Without a name in hand the sentence says "this Space" rather than
    // rendering an empty pair of quotation marks.
    expect(spaceRefusal("space_membership_final", "").message).toContain("this Space");
    expect(spaceRefusal("space_access_denied", "Company")).toBeInstanceOf(ApiError);
    expect(spaceRefusal("space_access_denied", "Company").status).toBe(403);
    expect(spaceRefusal("space_not_found", "Company").status).toBe(404);
  });
});
