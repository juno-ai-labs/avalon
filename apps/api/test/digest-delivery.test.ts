import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { deliverDigest } from "../src/services/digest-delivery-service";
import { settleDigestRun } from "../src/services/digest-run-settlement";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const OWNER = "00000000-0000-7000-8000-000000000002";
const SCHEDULE = "00000000-0000-7000-8000-000000000005";
const DELIVERY = "00000000-0000-7000-8000-000000000006";
const TARGET = "00000000-0000-7000-8000-000000000007";
const WORKSTREAM = "00000000-0000-7000-8000-000000000008";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/**
 * `sendResendEmail` refuses to send outside production, so these run as
 * production against a stubbed transport — the accounting under test is exactly
 * what the non-production short circuit skips.
 */
function envFor(database: DatabaseSync): Env {
  return {
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "production",
    RESEND_API_KEY: "test-key",
    RESEND_FROM_EMAIL: "Avalon <invites@example.com>",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
  } as unknown as Env;
}

function seededDatabase(status = "running"): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, timezone, created_at, updated_at)
    VALUES ('${OWNER}', 'g-owner', 'owner@example.com', 'Owner', 'Europe/London', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${OWNER}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${OWNER}', 'owner', 'active', '2026-01-01');
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
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
       next_sequence_number, last_activity_at, created_at, updated_at, system_kind, scope)
    VALUES ('${WORKSTREAM}', '${WORKSPACE}', 'Digest · Owner · Tuesday 11 August · 9:00 AM', '',
            'ad_hoc', '${OWNER}', 'running', 2, '2026-08-11', '2026-08-11', '2026-08-11',
            'digest', 'personal');
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

/**
 * `settleDigestRun` owns the whole tail of a run and calls the transport itself,
 * so a test drives it by replacing the global transport rather than by threading
 * a stub through production code that has no other reason to accept one.
 */
function withTransport(response: () => Response): ReturnType<typeof vi.fn> {
  const request = vi.fn(async () => response());
  vi.stubGlobal("fetch", request);
  return request;
}

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

function deliveryStatus(database: DatabaseSync): { status: string; error_json: string | null } {
  return database.prepare("SELECT status, error_json FROM digest_deliveries WHERE id = ?")
    .get(DELIVERY) as { status: string; error_json: string | null };
}

describe("digest delivery", () => {
  it("sends to a frozen destination and records it", async () => {
    const database = seededDatabase();
    const request = vi.fn(async () => new Response(JSON.stringify({ id: "resend-1" }), { status: 200 }));

    const result = await deliverDigest(envFor(database), context, request as unknown as typeof fetch);

    expect(result).toEqual({ delivered: 1, skipped: 0, failed: 0 });
    expect(database.prepare(
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
    expect(database.prepare("SELECT status FROM digest_delivery_targets WHERE id = ?").get(TARGET))
      .toEqual({ status: "needs_input" });
  });

  it("rethrows a retryable failure so the workflow step retries it", async () => {
    const database = seededDatabase();
    const request = vi.fn(async () => new Response("upstream down", { status: 503 }));

    await expect(deliverDigest(envFor(database), context, request as unknown as typeof fetch))
      .rejects.toBeDefined();
    expect(database.prepare("SELECT status FROM digest_delivery_targets WHERE id = ?").get(TARGET))
      .toEqual({ status: "active" });
  });
});

describe("settling a digest run", () => {
  it("records what the run wrote and marks the delivery delivered", async () => {
    const database = seededDatabase();
    withTransport(() => new Response(JSON.stringify({ id: "resend-1" }), { status: 200 }));

    await settleDigestRun(envFor(database), DELIVERY, "completed", "## Launch\n\n- Shipped it");

    expect(deliveryStatus(database).status).toBe("delivered");
    expect(database.prepare("SELECT summary_markdown FROM digest_deliveries WHERE id = ?").get(DELIVERY))
      .toEqual({ summary_markdown: "## Launch\n\n- Shipped it" });
  });

  it("notes the delivery in the occurrence's own work stream", async () => {
    const database = seededDatabase();
    withTransport(() => new Response(JSON.stringify({ id: "resend-1" }), { status: 200 }));

    await settleDigestRun(envFor(database), DELIVERY, "completed", "## Launch");

    // Resolved through the delivery's own `workstream_id`, so it lands whether
    // or not the launch recorded a `harness_run_id` to join back through. A
    // transcript whose summary carries no note is a digest nobody received,
    // which is what somebody chasing a missing email is looking for.
    expect(database.prepare(
      "SELECT workstream_id, text_content FROM messages WHERE client_message_id = ?",
    ).get(`digest-delivered:${DELIVERY}`)).toEqual({
      workstream_id: WORKSTREAM,
      text_content: "Delivered to 1 destination.",
    });
    expect(database.prepare("SELECT next_sequence_number FROM workstreams WHERE id = ?").get(WORKSTREAM))
      .toEqual({ next_sequence_number: 3 });
  });

  it("sends nothing when the run finished without writing a digest", async () => {
    const database = seededDatabase();

    await settleDigestRun(envFor(database), DELIVERY, "completed", null);

    // A placeholder sentence describing the run is not a digest. Failing here
    // keeps the window unconsumed, so its events reach the next occurrence.
    expect(deliveryStatus(database).status).toBe("failed");
    expect(deliveryStatus(database).error_json).toContain("digest_run_completed");
  });

  it("does not consume the window when every destination failed", async () => {
    const database = seededDatabase();
    // Permanently rejected, so `deliverDigest` records it and returns rather
    // than throwing — the path where a run could otherwise look successful.
    withTransport(() => new Response("bad recipient", { status: 422 }));

    await settleDigestRun(envFor(database), DELIVERY, "completed", "## Launch");

    expect(deliveryStatus(database).status).toBe("failed");
    expect(deliveryStatus(database).error_json).toContain("digest_not_delivered");
  });

  it("still consumes the window when nothing was sent but nothing failed", async () => {
    const database = seededDatabase();
    withTransport(() => new Response(JSON.stringify({ id: "resend-1" }), { status: 200 }));
    // Already served on an earlier attempt of this same step.
    database.exec(
      `UPDATE digest_delivery_targets SET last_delivered_delivery_id = '${DELIVERY}' WHERE id = '${TARGET}'`,
    );

    await settleDigestRun(envFor(database), DELIVERY, "completed", "## Launch");

    expect(deliveryStatus(database).status).toBe("delivered");
  });

  it("settles once, so a retried step does not send the digest again", async () => {
    const database = seededDatabase("delivered");
    withTransport(() => new Response(JSON.stringify({ id: "resend-1" }), { status: 200 }));

    await settleDigestRun(envFor(database), DELIVERY, "completed", "## Launch");

    expect(database.prepare("SELECT summary_markdown FROM digest_deliveries WHERE id = ?").get(DELIVERY))
      .toEqual({ summary_markdown: null });
  });

  it("does not deliver a run that needs input", async () => {
    const database = seededDatabase();

    await settleDigestRun(envFor(database), DELIVERY, "needs_input", "What did you mean?");

    expect(deliveryStatus(database).status).toBe("failed");
  });

  it("carries the frozen counts into the email rather than recounting them", async () => {
    const database = seededDatabase();
    const request = recordingTransport();
    const env = envFor(database);
    // The delivery was claimed with 4 events, 2 of which name this person.
    // Recomputing either would have to re-derive the audience filter, the
    // look-back floor and the per-run cap.
    await deliverDigest(env, { ...context, itemCount: 4, highlightCount: 2 }, request as unknown as typeof fetch);

    const body = JSON.parse(String(request.mock.calls[0]![1].body)) as { html: string };
    expect(body.html).toContain("2 for you");
    expect(body.html).toContain("4 updates");
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
    expect(body.tags).toContainEqual({ name: "category", value: "scheduled_digest" });
    expect(new Headers(init.headers).get("idempotency-key")).toBe(`avalon-digest/${TARGET}/${DELIVERY}`);
  });

  it("skips a destination whose member is no longer active", async () => {
    const database = seededDatabase();
    database.exec(`UPDATE workspace_members SET status = 'suspended' WHERE user_id = '${OWNER}'`);

    expect(await deliverDigest(envFor(database), context, acceptingResend as unknown as typeof fetch))
      .toEqual({ delivered: 0, skipped: 0, failed: 0 });
  });
});
