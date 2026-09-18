import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import type * as NamingService from "../src/services/workstream-naming-service";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import {
  openWorkstreamAuthorityForTest,
  testSubstreamAgentsBinding,
  testWorkstreamContract,
} from "./helpers/durable-authority";

/**
 * What a create writes into `scope`, at the layer that decides it.
 *
 * The work stream's own object owns the rule — the Workers-runtime suite proves
 * the row it writes and who may then read it. What is proved here is the step
 * in front of that: whether the scope a caller *knows* survives the trip to the
 * object, and what the object is asked for when nobody names one.
 *
 * Both halves come from one defect. `CreateWorkstreamRequestSchema` is not
 * `.strict()`, so the `scope` the Slack ingress computes for a private channel
 * was stripped by the `parse` inside the creation service and never reached
 * `initialize`, which hardcoded `'workspace'` — every work stream summoned from
 * a private conversation by a linked member was created readable by the whole
 * workspace. The scope is now an explicit argument, and the case nobody names
 * is `personal` rather than `workspace`.
 */

vi.mock("../src/services/integrations", () => ({
  classifyWorkstreamMessage: vi.fn(async () => ({
    classification: "human_only",
    confidence: 1,
    rationaleCode: "test",
  })),
  publishWorkstreamEvent: vi.fn(async () => undefined),
  activateWorkstreamLoop: vi.fn(async () => "execution-receipt"),
}));
vi.mock("../src/services/workstream-naming-service", async (importOriginal) => ({
  ...await importOriginal<typeof NamingService>(),
  nameWorkstream: vi.fn(async () => undefined),
}));
vi.mock("../src/services/workstream-email-routing-service", () => ({
  WorkstreamEmailRoutingService: class {
    async reserve(input: { workstreamId: string }) {
      return { emailAddress: `otter-${input.workstreamId}@automation.with-avalon.com` };
    }
    async activateWorkstreamRoute() {
      return undefined;
    }
    async setStatus() {
      return undefined;
    }
  },
}));

import { WorkstreamService } from "../src/services/workstream-service";
import { createTestEnv } from "./helpers/cloudflare-test";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const memberId = asUserId("00000000-0000-7000-8000-000000000002");
const at = "2026-08-21T09:00:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

const auth: AuthContext = {
  sessionId: "session-1",
  userId: memberId,
  workspaceId,
  region: "global",
  role: "member",
};

function seededDatabase(): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${memberId}', 'google-member', 'member@example.com', 'Member', '${at}', '${at}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Avalon Studio', 'avalon-studio', 'global', '${memberId}', '${at}', '${at}');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${workspaceId}', '${memberId}', 'owner', 'active', '${at}');
  `);
  openWorkstreamAuthorityForTest(database);
  return database;
}

/** The environment, plus the `initialize` payloads the object was handed. */
function environment(database: DatabaseSync): {
  env: Env;
  initializeInputs: Array<Record<string, unknown>>;
} {
  const initializeInputs: Array<Record<string, unknown>> = [];
  /** The contract row each initialized work stream would answer `get` with. */
  const initialized = new Map<string, Record<string, unknown>>();
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: "error",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, {
      product: {
        initialize: (request) => {
          const input = request.input as Record<string, unknown>;
          initializeInputs.push(input);
          const workstream = testWorkstreamContract({
            id: input.workstreamId,
            workspaceId: input.workspaceId,
            title: input.title,
            objective: input.objective,
            createdByUserId: input.creatorUserId,
            emailAddress: input.emailAddress,
            scope: input.scope,
          });
          initialized.set(String(input.workstreamId), workstream);
          return {
            workstream,
            turnId: crypto.randomUUID(),
            harnessRunId: crypto.randomUUID(),
          };
        },
        // A completed receipt replays through `get` rather than `initialize`,
        // so the replay half of the idempotency tests needs it.
        get: (request) => {
          const workstreamId = String(request.workstreamId ?? "");
          const workstream = initialized.get(workstreamId)
            ?? [...initialized.values()][0];
          return {
            ...workstream,
            participants: [],
            viewers: [],
            resources: [],
            connections: [],
            backgroundTasks: [],
            openElicitations: [],
            suggestions: [],
            latestHarnessRunId: null,
          };
        },
      },
    }),
    WORKSTREAM_DOS: testSubstreamAgentsBinding(database, {
      extra: parentCreationRpcs(),
    }),
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: {
        opportunityOriginEvents: vi.fn(async () => []),
      },
    }),
  });
  return { env, initializeInputs };
}

/**
 * The parent's half of a create.
 *
 * `WorkstreamObjectCreationService` reserves the main conversation on the
 * parent object before the child is initialized, then flushes its provisional
 * directory effects alongside initialization. Nothing in this file asserts on
 * those parent operations, but a create that cannot make them never reaches
 * `initialize`, which is what these tests read.
 */
function parentCreationRpcs() {
  return {
    reserveChild: vi.fn(async (input: { authorityGeneration: number }) => ({
      reserved: true as const,
      authorityGeneration: input.authorityGeneration,
    })),
    flushProvisionalDirectory: vi.fn(async () => undefined),
  };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "A work stream",
    objective: "Do the thing",
    openingMessage: "Start it",
    clientMessageId: `client-${crypto.randomUUID()}`,
    participantUserIds: [] as string[],
    attachmentIds: [] as string[],
    ...overrides,
  };
}

describe("the audience a new work stream is created with", () => {
  it("asks the object for a private work stream when the caller names no audience", async () => {
    const database = seededDatabase();
    const { env, initializeInputs } = environment(database);

    await new WorkstreamService(env, auth).create(createInput());

    // What the object was *asked* for. The work stream that comes back carries
    // whatever this file's `initialize` double echoed, so asserting on it would
    // be asserting on the double's own configuration; the row it really writes
    // is proved on workerd in `durable-object-runtime.test.ts`.
    expect(initializeInputs).toHaveLength(1);
    expect(initializeInputs[0]).toMatchObject({ scope: "personal" });
  });

  it("carries the audience a connector ingress resolved through to the object", async () => {
    const database = seededDatabase();
    const { env, initializeInputs } = environment(database);
    const service = new WorkstreamService(env, auth);

    // What the Slack ingress computes for a thread in a public channel. Nothing
    // seats a participant on this branch — the room is the channel — so a scope
    // dropped on the way through leaves that channel a work stream none of its
    // members can open.
    await service.create(createInput({ scope: "workspace" }));
    // And a private channel or a DM, whose members are seated instead.
    await service.create(createInput({ scope: "personal" }));

    expect(initializeInputs.map((input) => input.scope)).toEqual(["workspace", "personal"]);
  });

  it("gives a suggestion the audience it was shown to", async () => {
    const database = seededDatabase();
    const { env, initializeInputs } = environment(database);
    const service = new WorkstreamService(env, auth);

    // A suggestion Avalon put in front of the whole workspace. Whoever presses
    // start claims it and everybody else is answered
    // `work_opportunity_already_claimed`, so landing this on the private default
    // would take the work away from the people it was just offered to.
    await service.createFromOpportunity({
      opportunityId: "00000000-0000-7000-8000-0000000000a1",
      version: 1,
      displayPrompt: "Chase the assigned issue",
      executionPrompt: "Trace ISS-42 and prepare the fix.",
      displayPromptHash: "display-hash",
      executionPromptHash: "execution-hash",
      idempotencyKey: "start-workspace-suggestion",
      audienceScope: "workspace",
    });
    // And one only its owner was ever shown.
    await service.createFromOpportunity({
      opportunityId: "00000000-0000-7000-8000-0000000000a2",
      version: 1,
      displayPrompt: "Reply to the thread",
      executionPrompt: "Draft a reply.",
      displayPromptHash: "display-hash-2",
      executionPromptHash: "execution-hash-2",
      idempotencyKey: "start-personal-suggestion",
      audienceScope: "personal",
    });

    expect(initializeInputs.map((input) => input.scope)).toEqual(["workspace", "personal"]);
  });

  it("refuses a retry of one create key that resolved a different audience", async () => {
    const database = seededDatabase();
    const { env, initializeInputs } = environment(database);
    const service = new WorkstreamService(env, auth);
    // A Slack event id is one create key across every redelivery Slack makes on
    // an ack timeout, and the channel type is re-resolved per delivery:
    // `conversations.info` timing out, or a token that lost the scope for it,
    // answers `unknown`, which fails closed to `personal`.
    const clientMessageId = "event:Ev0PRIVATE1";

    const first = await service.create(createInput({ clientMessageId, scope: "workspace" }));
    expect(initializeInputs).toMatchObject([{ scope: "workspace" }]);

    // Replaying the *same* audience is still the idempotent replay it was: one
    // work stream, and no second initialize.
    await expect(service.create(createInput({ clientMessageId, scope: "workspace" })))
      .resolves.toMatchObject({ workstream: { id: first.workstream.id } });
    expect(initializeInputs).toHaveLength(1);

    // A different one is a different request. Without the scope in the receipt
    // hash this replayed instead, handing back the workspace-readable work
    // stream the first attempt committed.
    await expect(service.create(createInput({ clientMessageId, scope: "personal" })))
      .rejects.toMatchObject({ status: 409, code: "workstream_create_idempotency_conflict" });
    expect(initializeInputs).toHaveLength(1);
  });
});
