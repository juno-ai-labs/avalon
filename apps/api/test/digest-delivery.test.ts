import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

// Recorded rather than real so a test can see what the terminal event said;
// everything else on the module stays the real implementation.
const emitProductUsageTelemetry = vi.hoisted(() =>
  vi.fn<(env: unknown, input: unknown) => Promise<void>>(async () => undefined));
vi.mock("../src/telemetry/product-usage", async (importOriginal) => ({
  ...await importOriginal<typeof ProductUsageModule>(),
  emitProductUsageTelemetry,
}));

import type * as ProductUsageModule from "../src/telemetry/product-usage";
import type { Env } from "../src/env";
import { deliverDigest } from "../src/services/digest-delivery-service";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";

const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const OWNER = "00000000-0000-7000-8000-000000000002";
const SCHEDULE = "00000000-0000-7000-8000-000000000005";
const DELIVERY = "00000000-0000-7000-8000-000000000006";
const TARGET = "00000000-0000-7000-8000-000000000007";
const WORKSTREAM = "00000000-0000-7000-8000-000000000008";

const databases: DatabaseSync[] = [];
/** The digest work stream's own object database, rebuilt per fixture. */
let objectStore: DatabaseSync;
/** The real WorkspaceDO the fixture stands up, and its own database — where the digest rows live. */
let workspaceDO: WorkspaceDO;
let workspaceStore: DatabaseSync;
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  emitProductUsageTelemetry.mockClear();
});

/**
 * `sendResendEmail` refuses to send outside production, so these run as
 * production against a stubbed transport — the accounting under test is exactly
 * what the non-production short circuit skips. The digest tables are served by
 * the real `WorkspaceDO` the fixture stood up, so settlement's claim and the
 * per-target delivery records are the object's own decisions rather than a
 * re-implementation of them.
 */
function envFor(
  database: DatabaseSync,
  extra: Record<string, unknown> = {},
  substreamExtra: Record<string, unknown> = {},
): Env {
  return createTestEnv({
    DB: sqliteD1(database),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, {
      objectStores: new Map([[WORKSTREAM, objectStore]]),
      extra: substreamExtra,
    }),
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: {
        ...workspaceObjectRpcs(workspaceDO, [
          "digestDeliveryContext",
          "recordDigestSummary",
          "settleDigestDelivery",
          "digestTerminalTelemetryContext",
          "digestDeliveryTargets",
          "markDigestTargetDelivered",
          "markDigestTargetFailed",
        ]),
        ...extra,
      },
    }),
    AVALON_REGION: "global",
    APP_ENV: "production",
    RESEND_API_KEY: "test-key",
    RESEND_FROM_EMAIL: "Avalon <invites@example.com>",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
  });
}

function seededDatabase(status = "running"): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  // Settlement writes its delivery note through the runtime SQL port, so the
  // fixture opens the authority and gives the digest work stream a real object
  // holding its transcript state.
  openWorkstreamAuthorityForTest(database);
  objectStore = testWorkstreamObjectStore();
  databases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, {
    workstreamId: WORKSTREAM,
    workspaceId: WORKSPACE,
    title: "Digest · Owner · Tuesday 11 August · 9:00 AM",
    description: "",
    originType: "ad_hoc",
    createdByUserId: OWNER,
    exactState: "running",
    nextSequenceNumber: 2,
    systemKind: "digest",
    scope: "personal",
  });

  database.exec(`
    INSERT INTO users (id, google_subject, email, name, timezone, created_at, updated_at)
    VALUES ('${OWNER}', 'g-owner', 'owner@example.com', 'Owner', 'Europe/London', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${OWNER}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${OWNER}', 'owner', 'active', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
       next_sequence_number, last_activity_at, created_at, updated_at, system_kind, scope)
    VALUES ('${WORKSTREAM}', '${WORKSPACE}', 'Digest · Owner · Tuesday 11 August · 9:00 AM', '',
            'ad_hoc', '${OWNER}', 'running', 2, '2026-08-11', '2026-08-11', '2026-08-11',
            'digest', 'personal');
  `);
  const built = createTestWorkspaceDO({
    workspaceId: WORKSPACE,
    regionalDatabase: database,
    register: (created) => databases.push(created),
  });
  workspaceDO = built.instance;
  workspaceStore = built.objectDatabase;
  workspaceStore.exec(`
    INSERT INTO digest_schedules
      (id, workspace_id, user_id, day_mask, enabled, execution_principal_json,
       version, created_at, updated_at)
    VALUES ('${SCHEDULE}', '${WORKSPACE}', '${OWNER}', 62, 1,
            '{"type":"user","userId":"${OWNER}"}', 1, '2026-01-01', '2026-01-01');
    INSERT INTO digest_delivery_targets
      (id, workspace_id, digest_schedule_id, user_id, target_type, email_address,
       status, created_at, updated_at)
    VALUES ('${TARGET}', '${WORKSPACE}', '${SCHEDULE}', '${OWNER}', 'email', 'owner@example.com',
            'active', '2026-01-01', '2026-01-01');
    INSERT INTO digest_deliveries
      (id, workspace_id, digest_schedule_id, user_id, planned_for, cursor_from,
       cursor_through, event_count, highlight_count, workstream_id, status, created_at, updated_at)
    VALUES ('${DELIVERY}', '${WORKSPACE}', '${SCHEDULE}', '${OWNER}', '2026-08-11T08:00:00.000Z',
            NULL, 12, 4, 2, '${WORKSTREAM}', '${status}', '2026-01-01', '2026-01-01');
  `);
  return database;
}

const context = {
  workspaceId: WORKSPACE,
  deliveryId: DELIVERY,
  userId: OWNER,
  recipientName: "Owner",
  workspaceName: "Avalon Studio",
  timezone: "Europe/London",
  plannedFor: "2026-08-11T08:00:00.000Z",
  bodyMarkdown: "## Launch\n\n- Shipped the installer",
  itemCount: 4,
  highlightCount: 2,
};

const acceptingResend = vi.fn(async () => new Response(JSON.stringify({ id: "resend-1" }), { status: 200 }));

afterEach(() => vi.unstubAllGlobals());

/**
 * An accepting transport whose recorded arguments a test can read back. The
 * signature is declared on the mock rather than on an unused parameter list, so
 * `mock.calls` is typed without introducing arguments nothing reads.
 */
function recordingTransport() {
  return vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify({ id: "resend-1" }), { status: 200 }),
  );
}

describe("digest delivery", () => {
  it("sends to a frozen destination and records it", async () => {
    const database = seededDatabase();
    const request = vi.fn(async () => new Response(JSON.stringify({ id: "resend-1" }), { status: 200 }));

    const result = await deliverDigest(envFor(database), context, request as unknown as typeof fetch);

    expect(result).toEqual({ delivered: 1, skipped: 0, failed: 0 });
    expect(workspaceStore.prepare(
      "SELECT last_delivered_delivery_id, status FROM digest_delivery_targets WHERE id = ?",
    ).get(TARGET)).toMatchObject({ last_delivered_delivery_id: DELIVERY, status: "active" });
  });

  it("does not send twice when the workflow step is retried", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    const request = vi.fn(async () => new Response(JSON.stringify({ id: "resend-1" }), { status: 200 }));
    await deliverDigest(env, context, request as unknown as typeof fetch);

    const second = await deliverDigest(env, context, request as unknown as typeof fetch);

    expect(second).toEqual({ delivered: 0, skipped: 1, failed: 0 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("marks a permanently rejected destination for attention without throwing", async () => {
    const database = seededDatabase();
    const request = vi.fn(async () => new Response("bad recipient", { status: 422 }));

    const result = await deliverDigest(envFor(database), context, request as unknown as typeof fetch);

    // A frozen address the provider will keep rejecting never fixes itself, so
    // it is surfaced rather than failing the step on every occurrence forever.
    expect(result).toEqual({ delivered: 0, skipped: 0, failed: 1 });
    expect(workspaceStore.prepare("SELECT status FROM digest_delivery_targets WHERE id = ?").get(TARGET))
      .toEqual({ status: "needs_input" });
  });

  it("does not count a send against a target that vanished before it was recorded", async () => {
    const database = seededDatabase();
    // A settings save mid-delivery deletes and re-inserts every target row
    // under fresh ids. The transport stands in for that moment: the send
    // lands, and by the time the record is written the row is gone.
    const request = vi.fn(async () => {
      workspaceStore.exec(`DELETE FROM digest_delivery_targets WHERE id = '${TARGET}'`);
      return new Response(JSON.stringify({ id: "resend-1" }), { status: 200 });
    });

    const result = await deliverDigest(envFor(database), context, request as unknown as typeof fetch);

    // Counting it delivered would settle the occurrence with no idempotency
    // marker written anywhere, and a retried step would send the recreated
    // target a second copy on that authority. Skipped is the honest count:
    // nothing was recorded, and nothing is left claiming it was.
    expect(result).toEqual({ delivered: 0, skipped: 1, failed: 0 });
  });

  it("rethrows a retryable failure so the workflow step retries it", async () => {
    const database = seededDatabase();
    const request = vi.fn(async () => new Response("upstream down", { status: 503 }));

    await expect(deliverDigest(envFor(database), context, request as unknown as typeof fetch))
      .rejects.toBeDefined();
    expect(workspaceStore.prepare("SELECT status FROM digest_delivery_targets WHERE id = ?").get(TARGET))
      .toEqual({ status: "active" });
  });
});

describe("digest email transport", () => {
  it("addresses the frozen address and tags the message", async () => {
    const database = seededDatabase();
    const request = recordingTransport();

    await deliverDigest(envFor(database), context, request as unknown as typeof fetch);

    const init = request.mock.calls[0]![1];
    const body = JSON.parse(String(init.body)) as {
      to: string[];
      subject: string;
      tags: Array<{ name: string; value: string }>;
    };
    expect(body.to).toEqual(["owner@example.com"]);
    expect(body.subject).toContain("Avalon Studio");
    expect(body.tags).toContainEqual({ name: "category", value: "daily_digest" });
    expect(new Headers(init.headers).get("idempotency-key")).toBe(`avalon-digest/${TARGET}/${DELIVERY}`);
  });

  it("skips a destination whose member is no longer active", async () => {
    const database = seededDatabase();
    database.exec(`UPDATE workspace_members SET status = 'suspended' WHERE user_id = '${OWNER}'`);

    expect(await deliverDigest(envFor(database), context, acceptingResend as unknown as typeof fetch))
      .toEqual({ delivered: 0, skipped: 0, failed: 0 });
  });
});
