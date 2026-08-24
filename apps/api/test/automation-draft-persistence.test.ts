import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import type * as IntegrationsModule from "../src/services/integrations";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const compileAutomationDraft = vi.hoisted(() => vi.fn());
const reserveAutomation = vi.hoisted(() => vi.fn(async () => ({
  emailAddress: "quiet-amber-steady-heron@automation.with-avalon.com",
  status: "reserved" as const,
})));
const activateAutomationRoute = vi.hoisted(() => vi.fn(async () => ({
  emailAddress: "quiet-amber-steady-heron@automation.with-avalon.com",
  status: "active" as const,
})));
const ensureAutomationAddress = vi.hoisted(() => vi.fn(async () => ({
  emailAddress: "quiet-amber-steady-heron@automation.with-avalon.com",
  status: "active" as const,
})));

vi.mock("../src/services/integrations", async (importOriginal) => ({
  ...await importOriginal<typeof IntegrationsModule>(),
  compileAutomationDraft,
}));
vi.mock("../src/services/workstream-email-routing-service", () => ({
  WorkstreamEmailRoutingService: class {
    async backfillAutomationAddresses() {
      return [];
    }
    reserveAutomation = reserveAutomation;
    activateAutomationRoute = activateAutomationRoute;
    ensureAutomationAddress = ensureAutomationAddress;
  },
}));

import { AutomationService } from "../src/services/automation-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { testSubstreamAgentsBinding } from "./helpers/durable-authority";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const userId = asUserId("00000000-0000-7000-8000-000000000002");
const otherUserId = asUserId("00000000-0000-7000-8000-000000000003");

const auth: AuthContext = {
  sessionId: "session-1",
  userId,
  workspaceId,
  region: "global",
  role: "owner",
};

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
beforeEach(() => vi.clearAllMocks());

function seededDatabase(): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, timezone, created_at, updated_at)
    VALUES
      ('${userId}', 'subject-1', 'adam@example.com', 'Adam', 'America/Los_Angeles', '2026-01-01', '2026-01-01'),
      ('${otherUserId}', 'subject-2', 'sam@example.com', 'Sam', 'America/Los_Angeles', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, timezone, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Avalon Studio', 'avalon-studio', 'global', 'America/Los_Angeles', '${userId}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES
      ('${workspaceId}', '${userId}', 'owner', 'active', '2026-01-01'),
      ('${workspaceId}', '${otherUserId}', 'member', 'active', '2026-01-01');
  `);
  return database;
}

function serviceFor(database: DatabaseSync, as: AuthContext = auth): AutomationService {
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    // A promoted automation carries a schedule, so reading it asks the
    // workspace object for the work stream planned against the next run.
    // Nothing here ever opens one, and these tests are about the draft's own
    // lifecycle, so the object answers as it would: nothing is planned.
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: {
        plannedWorkstream: async () => null,
        refreshSchedule: async () => ({ alarmAt: null }),
      },
    }),
  });
  return new AutomationService(env, as);
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    name: "Blog monitor",
    description: "Check a blog for new posts.",
    overview: "Checks the configured blog every day.",
    instructions: "Check the configured blog and report new posts.",
    triggers: [{ type: "interval", intervalSeconds: 86_400, summary: "Every 24 hours" }],
    requiredCapabilities: [],
    expectedOutputs: [],
    defaultBehavior: {},
    recommendedPlugins: [],
    memoryTables: [],
    suggestedScope: "personal",
    followUpQuestion: "Which blog should I monitor?",
    elicitation: null,
    ready: false,
    ...overrides,
  };
}

describe("automation drafts", () => {
  it("puts an automation being set up in the list before it is ever created", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft());
    const service = serviceFor(database);

    const compiled = await service.compile({
      messages: [{ role: "user", content: "Watch my blog." }],
    }, "request-1");

    expect((await service.list()).items).toEqual([expect.objectContaining({
      id: compiled.draftId,
      name: "Blog monitor",
      status: "draft",
      // A draft is not reachable, so it holds no address and never asks the
      // registry for one just to be listed.
      emailAddress: null,
      nextRunAt: null,
    })]);
    expect(reserveAutomation).not.toHaveBeenCalled();
    expect(Number((database.prepare(
      "SELECT COUNT(*) AS count FROM schedules WHERE automation_subscription_id = ?",
    ).get(compiled.draftId) as { count: number }).count)).toBe(0);
  });

  it("writes each later turn through to the same draft rather than piling up rows", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft());
    const service = serviceFor(database);
    const first = await service.compile({
      messages: [{ role: "user", content: "Watch my blog." }],
    }, "request-1");

    compileAutomationDraft.mockResolvedValue(draft({ name: "Example blog monitor" }));
    const second = await service.compile({
      draftId: first.draftId,
      messages: [
        { role: "user", content: "Watch my blog." },
        { role: "assistant", content: "Which blog should I monitor?" },
        { role: "user", content: "https://example.com/blog" },
      ],
    }, "request-2");

    expect(second.draftId).toBe(first.draftId);
    const items = (await service.list()).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: first.draftId, name: "Example blog monitor" });
  });

  it("hands back the conversation so the draft can be picked up where it was left", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft());
    const service = serviceFor(database);
    const compiled = await service.compile({
      messages: [{ role: "user", content: "Watch my blog." }],
      attachmentIds: ["00000000-0000-7000-8000-00000000000a"],
    }, "request-1");

    const state = await service.draftState(compiled.draftId);

    expect(state).toMatchObject({
      draftId: compiled.draftId,
      attachmentIds: ["00000000-0000-7000-8000-00000000000a"],
      draft: expect.objectContaining({ name: "Blog monitor", ready: false }),
      messages: [
        { role: "user", content: "Watch my blog." },
        // The reply the person is looking at is part of the conversation, so
        // reopening the draft does not lose the question it ended on.
        { role: "assistant", content: "Which blog should I monitor?" },
      ],
    });
  });

  it("says a conversation it can no longer read is unavailable rather than failing", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft());
    const service = serviceFor(database);
    const compiled = await service.compile({
      messages: [{ role: "user", content: "Watch my blog." }],
    }, "request-1");
    // What a draft written by an earlier deploy looks like once the compiler's
    // contract has moved on. Left to the route's own parse this is a 500, and
    // a sidebar row that answers 500 forever cannot be opened or explained.
    database.prepare(
      "UPDATE automation_subscriptions SET draft_conversation_json = ? WHERE id = ?",
    ).run('{"messages":[{"role":"user","content":"Watch my blog."}],"attachmentIds":[],"draft":{"name":"Blog monitor"}}', compiled.draftId);

    await expect(service.draftState(compiled.draftId)).rejects.toMatchObject({
      status: 409,
      code: "automation_draft_unavailable",
    });
    // Still listed, so it can still be archived.
    expect((await service.list()).items.map((item) => item.id)).toEqual([compiled.draftId]);
  });

  it.each([
    {
      name: "reads an unnamed morning in the account's own day",
      scope: "personal" as const,
      triggerTimezone: null,
      expected: "America/New_York",
    },
    {
      name: "keeps the zone the person actually named",
      scope: "personal" as const,
      triggerTimezone: "Asia/Tokyo",
      expected: "Asia/Tokyo",
    },
    {
      name: "reads an unnamed morning for a workspace automation in the workspace's day",
      scope: "workspace" as const,
      triggerTimezone: null,
      expected: "America/Los_Angeles",
    },
  ])("$name", async ({ scope, triggerTimezone, expected }) => {
    const database = seededDatabase();
    // The workspace stays on Pacific: the defect this covers was a New York
    // account whose automation was created on Pacific time, so the two zones
    // have to disagree for the assertion to mean anything.
    database.exec(`UPDATE users SET timezone = 'America/New_York' WHERE id = '${userId}'`);
    compileAutomationDraft.mockResolvedValue(draft({
      followUpQuestion: null,
      ready: true,
      suggestedScope: scope,
      triggers: [{
        type: "calendar",
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        timezone: triggerTimezone,
        summary: "Every morning at 9:00 AM",
      }],
    }));
    const service = serviceFor(database);
    const compiled = await service.compile({
      messages: [{ role: "user", content: "Brief me every morning." }],
    }, "request-1");

    const created = await service.create({
      draftId: compiled.draftId,
      draft: compiled.draft,
      scope,
      defaultPluginIds: [],
      activitySourcePluginIds: {},
      resourceIds: [],
      deliveryTargets: [],
    });

    expect(database.prepare(
      "SELECT timezone FROM schedules WHERE automation_subscription_id = ?",
    ).get(created.id)).toEqual({ timezone: expected });
  });

  it("refuses to reopen the conversation behind an automation that already runs", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft({ followUpQuestion: null, ready: true }));
    const service = serviceFor(database);
    const compiled = await service.compile({
      messages: [{ role: "user", content: "Watch my blog." }],
    }, "request-1");
    await service.create({
      draftId: compiled.draftId,
      draft: compiled.draft,
      scope: "personal",
      defaultPluginIds: [],
      activitySourcePluginIds: {},
      resourceIds: [],
      deliveryTargets: [],
    });

    await expect(service.draftState(compiled.draftId)).rejects.toMatchObject({
      status: 409,
      code: "automation_not_draft",
    });
  });

  it("promotes the draft in place, so the sidebar entry becomes the automation", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft({ followUpQuestion: null, ready: true }));
    const service = serviceFor(database);
    const compiled = await service.compile({
      messages: [{ role: "user", content: "Watch my blog." }],
    }, "request-1");

    const created = await service.create({
      draftId: compiled.draftId,
      draft: compiled.draft,
      scope: "personal",
      defaultPluginIds: [],
      activitySourcePluginIds: {},
      resourceIds: [],
      deliveryTargets: [],
    });

    expect(created.id).toBe(compiled.draftId);
    expect(created.status).toBe("active");
    const items = (await service.list()).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: compiled.draftId, status: "active" });
    // The conversation is spent: an automation that runs is edited through its
    // overview, not by reopening the transcript that wrote it.
    expect(database.prepare(
      "SELECT draft_conversation_json FROM automation_subscriptions WHERE id = ?",
    ).get(compiled.draftId)).toEqual({ draft_conversation_json: null });
    expect(Number((database.prepare(
      "SELECT COUNT(*) AS count FROM schedules WHERE automation_subscription_id = ? AND enabled = 1",
    ).get(compiled.draftId) as { count: number }).count)).toBe(1);
  });

  it("keeps a draft out of every sidebar but its author's", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft({ suggestedScope: "workspace" }));
    const compiled = await serviceFor(database).compile({
      messages: [{ role: "user", content: "Watch our blog." }],
    }, "request-1");

    // Suggesting a workspace automation is a proposal inside the draft, not a
    // decision: the row stays personal until its author creates it.
    expect(database.prepare(
      "SELECT scope, owner_user_id FROM automation_subscriptions WHERE id = ?",
    ).get(compiled.draftId)).toEqual({ scope: "personal", owner_user_id: userId });
    const otherAuth: AuthContext = { ...auth, userId: otherUserId, role: "member" };
    expect((await serviceFor(database, otherAuth).list()).items).toEqual([]);
  });

  it("starts a new draft when the id names something the caller may not write to", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft());
    const mine = await serviceFor(database).compile({
      messages: [{ role: "user", content: "Watch my blog." }],
    }, "request-1");

    const otherAuth: AuthContext = { ...auth, userId: otherUserId, role: "member" };
    const theirs = await serviceFor(database, otherAuth).compile({
      draftId: mine.draftId,
      messages: [{ role: "user", content: "Watch a different blog." }],
    }, "request-2");

    expect(theirs.draftId).not.toBe(mine.draftId);
    expect(database.prepare(
      "SELECT owner_user_id FROM automation_subscriptions WHERE id = ?",
    ).get(mine.draftId)).toEqual({ owner_user_id: userId });
  });

  it("refuses to resume a draft into a running automation", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft());
    const service = serviceFor(database);
    const compiled = await service.compile({
      messages: [{ role: "user", content: "Watch my blog." }],
    }, "request-1");

    // Resuming is a transition between two states only a created automation
    // reaches. Arriving at 'active' through it would skip every check `create`
    // makes and hand a half-written automation a live address and a Run now.
    await expect(service.setPaused(compiled.draftId, false)).rejects.toMatchObject({
      status: 409,
      code: "automation_not_created",
    });
    expect(database.prepare(
      "SELECT status FROM automation_subscriptions WHERE id = ?",
    ).get(compiled.draftId)).toEqual({ status: "draft" });
    expect(activateAutomationRoute).not.toHaveBeenCalled();
    expect(ensureAutomationAddress).not.toHaveBeenCalled();
  });

  it("refuses to share a draft as a workspace template", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft());
    const service = serviceFor(database);
    const compiled = await service.compile({
      messages: [{ role: "user", content: "Watch my blog." }],
    }, "request-1");

    // The draft's template is owned by whoever started the conversation, so the
    // ownership check cannot stand in for this one. A published draft would put
    // a half-written template in the gallery, and a subscriber would pin the
    // very version row every later turn rewrites in place.
    await expect(service.shareSubscription(compiled.draftId)).rejects.toMatchObject({
      status: 409,
      code: "automation_not_created",
    });
    expect(database.prepare(
      "SELECT sharing_state FROM automation_templates WHERE id = (SELECT template_id FROM automation_subscriptions WHERE id = ?)",
    ).get(compiled.draftId)).toEqual({ sharing_state: "private" });
  });

  it("deletes a draft without minting the address it never had", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft());
    const service = serviceFor(database);
    const compiled = await service.compile({
      messages: [{ role: "user", content: "Watch my blog." }],
    }, "request-1");

    await service.deleteAutomation(compiled.draftId);

    // Reserving an address purely to disable it would tombstone one forever for
    // an automation nobody ever created.
    expect(ensureAutomationAddress).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT lifecycle_state, email_address FROM automation_subscriptions WHERE id = ?",
    ).get(compiled.draftId)).toEqual({ lifecycle_state: "deleted", email_address: null });
  });

  it("leaves the address of a deleted automation claimed", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft({ followUpQuestion: null, ready: true }));
    const service = serviceFor(database);
    const compiled = await service.compile({
      messages: [{ role: "user", content: "Report every day." }],
    }, "request-1");
    await service.create({
      draftId: compiled.draftId,
      draft: compiled.draft,
      scope: "personal",
      defaultPluginIds: [],
      activitySourcePluginIds: {},
      resourceIds: [],
      deliveryTargets: [],
    });
    ensureAutomationAddress.mockClear();

    await service.deleteAutomation(compiled.draftId);

    // Global records only that the address was taken, and an address is never
    // handed to a second owner — so a delete has no route state to move. The
    // row keeps the address, and mail to it is refused by the lifecycle check
    // the inbound resolver already makes.
    expect(ensureAutomationAddress).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT lifecycle_state, email_address FROM automation_subscriptions WHERE id = ?",
    ).get(compiled.draftId)).toEqual({
      lifecycle_state: "deleted",
      email_address: "quiet-amber-steady-heron@automation.with-avalon.com",
    });
  });

  it("drops a compile turn that lands after the draft was created", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft({ followUpQuestion: null, ready: true }));
    const service = serviceFor(database);
    const compiled = await service.compile({
      messages: [{ role: "user", content: "Report every day." }],
    }, "request-1");
    await service.create({
      draftId: compiled.draftId,
      draft: compiled.draft,
      scope: "personal",
      defaultPluginIds: [],
      activitySourcePluginIds: {},
      resourceIds: [],
      deliveryTargets: [],
    });

    // A turn that began before the automation was created still finishes. It
    // must not write through to the automation it has become: the row is no
    // longer a draft, so its name, its instructions, and its emptied
    // conversation all stay as creation left them.
    compileAutomationDraft.mockResolvedValue(draft({ name: "Stale rewrite", instructions: "Do something else." }));
    await service.compile({
      draftId: compiled.draftId,
      messages: [{ role: "user", content: "Actually, change it." }],
    }, "request-2");

    expect(database.prepare(
      `SELECT t.name, v.instructions, s.status, s.draft_conversation_json
       FROM automation_subscriptions s
       JOIN automation_templates t ON t.id = s.template_id
       JOIN automation_template_versions v ON v.id = s.template_version_id
       WHERE s.id = ?`,
    ).get(compiled.draftId)).toEqual({
      name: "Blog monitor",
      instructions: "Check the configured blog and report new posts.",
      status: "active",
      draft_conversation_json: null,
    });
  });

  it("refuses a second creation of the same draft rather than scheduling it twice", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft({ followUpQuestion: null, ready: true }));
    const service = serviceFor(database);
    const compiled = await service.compile({
      messages: [{ role: "user", content: "Report every day." }],
    }, "request-1");
    const createInput = {
      draftId: compiled.draftId,
      draft: compiled.draft,
      scope: "personal" as const,
      defaultPluginIds: [],
      activitySourcePluginIds: {},
      resourceIds: [],
      deliveryTargets: [],
    };
    await service.create(createInput);

    // Nothing constrains a subscription to one schedule, so a second creation
    // that got as far as the inserts would leave the automation firing twice
    // for every trigger it has.
    await expect(service.create(createInput)).rejects.toMatchObject({
      status: 409,
      code: "automation_already_created",
    });
    expect(Number((database.prepare(
      "SELECT COUNT(*) AS count FROM schedules WHERE automation_subscription_id = ?",
    ).get(compiled.draftId) as { count: number }).count)).toBe(1);
  });

  it("lists a draft alongside the automations that run, each with its own status", async () => {
    const database = seededDatabase();
    compileAutomationDraft.mockResolvedValue(draft({ name: "Alpha report", followUpQuestion: null, ready: true }));
    const service = serviceFor(database);
    const ready = await service.compile({
      messages: [{ role: "user", content: "Report every day." }],
    }, "request-1");
    await service.create({
      draftId: ready.draftId,
      draft: ready.draft,
      scope: "personal",
      defaultPluginIds: [],
      activitySourcePluginIds: {},
      resourceIds: [],
      deliveryTargets: [],
    });
    compileAutomationDraft.mockResolvedValue(draft({ name: "Zulu monitor" }));
    const pending = await service.compile({
      messages: [{ role: "user", content: "Watch my blog." }],
    }, "request-2");

    // The list is ordered by name; sinking drafts below the automations that
    // run is the sidebar's arrangement of it, covered where that lives.
    expect((await service.list()).items.map((item) => [item.id, item.status])).toEqual([
      [ready.draftId, "active"],
      [pending.draftId, "draft"],
    ]);
  });
});
