import { beforeEach, describe, expect, it, vi } from "vitest";

import { asUserId, asWorkspaceId, SidelineSendRequestSchema } from "@rally/contracts";
import type { AuthContext, Env } from "../src/env";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestD1Result,
  createTestEnv,
} from "./helpers/cloudflare-test";

const harness = vi.hoisted(() => ({
  audit: [] as Array<{ sql: string; values: unknown[] }>,
  order: [] as string[],
  relationship: { authorityBasis: "support:approved" } as { authorityBasis: string } | null,
  representedAuth: null as AuthContext | null,
  parentKind: "workstream" as "workstream" | "space",
  operatorEmail: "operator@rallywith.ai",
  inactiveUserIds: new Set<string>(),
  auditFails: false,
  createMessage: vi.fn(),
}));

vi.mock("../src/lib/durable-object-namespace", () => ({
  durableObjectStubForWorkspace: async () => ({
    authorizeImpersonation: async () => ({ relationship: harness.relationship }),
  }),
}));

vi.mock("../src/services/conversation-service", () => ({
  ConversationService: class {
    constructor(_env: Env, auth: AuthContext) { harness.representedAuth = auth; }
    async resolveParent() { return { kind: harness.parentKind }; }
    async writableClient() { return { createMessage: harness.createMessage }; }
  },
}));

import { ImpersonationService } from "../src/services/impersonation-service";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000b001");
const operatorId = asUserId("00000000-0000-7000-8000-00000000b002");
const representedId = asUserId("00000000-0000-7000-8000-00000000b003");
const auth: AuthContext = {
  sessionId: "operator-session",
  userId: operatorId,
  workspaceId,
  region: "global",
  role: "member",
};

function environment(): Env {
  const members = new Map([
    [operatorId, { user_id: operatorId, role: "member", name: "Operator", avatar_url: null, email: harness.operatorEmail }],
    [representedId, { user_id: representedId, role: "member", name: "Participant", avatar_url: null, email: "participant@example.com" }],
  ]);
  for (const userId of harness.inactiveUserIds) members.delete(asUserId(userId));
  const DB = createTestD1Database({
    prepare: () => {
      let values: unknown[] = [];
      const statement: D1PreparedStatement = createTestD1PreparedStatement({
        bind: (...next): D1PreparedStatement => { values = next; return statement; },
        first: async <T>() => (members.get(asUserId(String(values[1]))) as T | undefined) ?? null,
      });
      return statement;
    },
  });
  const AUDIT_DB = createTestD1Database({
    prepare: (sql) => {
      let values: unknown[] = [];
      const statement: D1PreparedStatement = createTestD1PreparedStatement({
        bind: (...next): D1PreparedStatement => { values = next; return statement; },
        run: async () => {
          if (harness.auditFails) throw new Error("audit unavailable");
          harness.audit.push({ sql, values });
          harness.order.push(sql.includes("impersonation.message.attempt") ? "audit-attempt" : "audit-result");
          return createTestD1Result({ success: true, results: [], meta: { changes: 1 } });
        },
      });
      return statement;
    },
  });
  return createTestEnv({
    DB,
    AUDIT_DB,
    AVALON_REGION: "global",
    WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({}),
  });
}

const request = SidelineSendRequestSchema.parse({
  representedUserId: representedId,
  workstreamId: "00000000-0000-7000-8000-00000000b004",
  substreamId: "0",
  message: "Could we see the current launch risks?",
  idempotencyKey: "00000000-0000-7000-8000-00000000b005",
  app: { name: "Sideline", version: "0.1.0", authMechanism: "rally_session" },
});

beforeEach(() => {
  harness.audit.length = 0;
  harness.order.length = 0;
  harness.relationship = { authorityBasis: "support:approved" };
  harness.representedAuth = null;
  harness.parentKind = "workstream";
  harness.operatorEmail = "operator@rallywith.ai";
  harness.inactiveUserIds.clear();
  harness.auditFails = false;
  harness.createMessage.mockReset().mockImplementation(async () => {
    harness.order.push("message-admission");
    return { turn: { turnId: "00000000-0000-7000-8000-00000000b006", createdAt: "2026-09-21T12:00:00.000Z" } };
  });
});

describe("impersonation message admission", () => {
  it("audits before admission and uses the represented principal without storing message content", async () => {
    const response = await new ImpersonationService(environment(), auth).send(request);

    expect(response.messageId).toBe("00000000-0000-7000-8000-00000000b006");
    expect(harness.order).toEqual(["audit-attempt", "message-admission", "audit-result"]);
    expect(harness.representedAuth).toMatchObject({ userId: representedId, principal: "impersonation" });
    expect(harness.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: request.message,
      clientMessageId: request.idempotencyKey,
    }));
    const auditText = JSON.stringify(harness.audit);
    expect(auditText).toContain(operatorId);
    expect(auditText).toContain(representedId);
    expect(auditText).toContain("support:approved");
    expect(auditText).toContain(response.messageId);
    expect(auditText).not.toContain(request.message);
  });

  it("records a missing directed relationship and never begins admission", async () => {
    harness.relationship = null;
    await expect(new ImpersonationService(environment(), auth).send(request))
      .rejects.toMatchObject({ code: "impersonation_not_authorized" });

    expect(harness.order).toEqual(["audit-attempt", "audit-result"]);
    expect(harness.createMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.audit)).toContain("impersonation_not_authorized");
  });

  it("uses the same exact relationship path for an explicit self-pair", async () => {
    const selfRequest = SidelineSendRequestSchema.parse({ ...request, representedUserId: operatorId });

    await new ImpersonationService(environment(), auth).send(selfRequest);

    expect(harness.representedAuth).toMatchObject({ userId: operatorId, principal: "impersonation" });
    expect(harness.order).toEqual(["audit-attempt", "message-admission", "audit-result"]);
  });

  it("rejects stale represented membership before destination admission", async () => {
    harness.inactiveUserIds.add(representedId);

    await expect(new ImpersonationService(environment(), auth).send(request))
      .rejects.toMatchObject({ code: "represented_member_inactive" });

    expect(harness.createMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.audit)).toContain("represented_member_inactive");
  });

  it("lets ordinary conversation authority reject an invalid destination", async () => {
    harness.parentKind = "space";

    await expect(new ImpersonationService(environment(), auth).send(request))
      .rejects.toMatchObject({ code: "destination_not_found" });

    expect(harness.createMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.audit)).toContain("destination_not_found");
  });

  it("requires internal-sidecar access independently of relationship authority", async () => {
    harness.operatorEmail = "operator@example.com";

    await expect(new ImpersonationService(environment(), auth).send(request))
      .rejects.toMatchObject({ code: "sideline_access_denied" });

    expect(harness.createMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.audit)).toContain("sideline_access_denied");
  });

  it("fails closed when the attempt audit cannot be recorded", async () => {
    harness.auditFails = true;

    await expect(new ImpersonationService(environment(), auth).send(request))
      .rejects.toThrow("audit unavailable");

    expect(harness.createMessage).not.toHaveBeenCalled();
    expect(harness.order).toEqual([]);
  });
});
