import "../../../tests/isolated-region";
import { describe, expect, it } from "vitest";
import {
  AcceptWorkspaceInvitationRequestSchema,
  CreateWorkspaceInvitationRequestSchema,
  SessionSchema,
  WorkspaceSchema,
  WorkspaceInvitationPreviewSchema,
  WorkspaceOnboardingStateSchema,
} from "./index";

const workspaceId = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0";

describe("organization invitation contracts", () => {
  it("separates guest access class from workspace roles", () => {
    const workspace = { id:workspaceId,name:"Shared",slug:"shared",region:"global",timezone:"UTC",
      createdAt:"2026-09-16T00:00:00.000Z",accessClass:"guest",role:null };
    expect(WorkspaceSchema.parse(workspace)).toEqual(workspace);
    expect(WorkspaceSchema.safeParse({ ...workspace,role:"owner" }).success).toBe(false);
    expect(WorkspaceSchema.safeParse({ ...workspace,accessClass:"member" }).success).toBe(false);
    expect(WorkspaceSchema.safeParse({ ...workspace,accessClass:undefined }).success).toBe(false);
    expect(WorkspaceSchema.safeParse({ ...workspace,accessClass:undefined,role:"member" }).success).toBe(true);
  });

  it("defaults invitations to member and accepts an explicit administrator role", () => {
    expect(CreateWorkspaceInvitationRequestSchema.parse({
      email: "  member@example.com  ",
    })).toEqual({ email: "member@example.com", role: "member" });

    expect(CreateWorkspaceInvitationRequestSchema.parse({
      email: "admin@example.com",
      role: "admin",
    })).toEqual({ email: "admin@example.com", role: "admin" });
  });

  it("does not permit owner escalation through an invitation payload", () => {
    expect(CreateWorkspaceInvitationRequestSchema.safeParse({
      email: "owner@example.com",
      role: "owner",
    }).success).toBe(false);
  });

  it("carries the immutable Global or enterprise region in invitation previews", () => {
    const preview = {
      workspaceId,
      workspaceName: "Europe Research",
      region: "enterprise",
      email: "invitee@example.com",
      role: "member",
      expiresAt: "2026-08-08T01:00:00.000Z",
    };
    expect(WorkspaceInvitationPreviewSchema.parse(preview)).toEqual(preview);
    expect(WorkspaceInvitationPreviewSchema.safeParse({
      ...preview,
      region: "not a region",
    }).success).toBe(false);
  });

  it("rejects short invitation secrets before they reach the API service", () => {
    expect(AcceptWorkspaceInvitationRequestSchema.safeParse({ token: "too-short" }).success).toBe(false);
    expect(AcceptWorkspaceInvitationRequestSchema.parse({
      token: "invite-token-longer-than-twenty-characters",
    })).toEqual({ token: "invite-token-longer-than-twenty-characters" });
  });

  it("supports an authenticated identity before it is bound to a workspace", () => {
    const session = {
      accessToken: "access-token-longer-than-twenty-characters",
      refreshToken: "refresh-token-longer-than-twenty-characters",
      expiresAt: "2026-08-01T01:00:00.000Z",
      user: {
        id: workspaceId,
        email: "adam@example.com",
        name: "Adam",
        avatarUrl: null,
        timezone: "America/Los_Angeles",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      workspace: null,
      apiBaseUrl: "https://api.with-avalon.com",
    };
    expect(SessionSchema.parse(session)).toEqual(session);
    expect(WorkspaceOnboardingStateSchema.parse({ invitations: [] })).toEqual({
      workspace: null,
      workspaces: [],
      invitations: [],
    });
  });

  it("keeps the singular onboarding workspace while exposing every membership", () => {
    const globalWorkspace = {
      id: workspaceId,
      name: "Global Research",
      slug: "global-research",
      region: "global" as const,
      role: "owner" as const,
      timezone: "America/Los_Angeles",
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const enterpriseWorkspace = {
      ...globalWorkspace,
      id: "00000000-0000-7000-8000-000000000099",
      name: "Europe Research",
      slug: "europe-research",
      region: "enterprise" as const,
      role: "member" as const,
      timezone: "Europe/London",
    };

    expect(WorkspaceOnboardingStateSchema.parse({
      workspace: globalWorkspace,
      workspaces: [globalWorkspace, enterpriseWorkspace],
      invitations: [],
    })).toEqual({
      workspace: globalWorkspace,
      workspaces: [globalWorkspace, enterpriseWorkspace],
      invitations: [],
    });

    expect(WorkspaceOnboardingStateSchema.parse({
      workspace: globalWorkspace,
      invitations: [],
    }).workspaces).toEqual([globalWorkspace]);
  });
});
