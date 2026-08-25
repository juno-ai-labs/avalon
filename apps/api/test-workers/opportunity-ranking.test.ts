/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The suggested-work ranking pipeline, on the object that now owns all of it.
 *
 * Candidates, the cached ranking state, the stored result, a recorded round and
 * the lease settlement each had a regional D1 implementation beside them until
 * migration 0090 closed the phase. Deleting those arms left the Worker calling
 * straight through to this object, and left every Node test of the callers
 * asserting a stub — so what these five decide is only asserted here.
 *
 * The settle test is the important one. `docs/potential-bugs.md` records a trap
 * where a member's ranking request and the pass that answers it can clear each
 * other forever; `request_seq` is the whole defence, and it is checked below.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import {
  WorkspaceOpportunityClaimStartResultSchema,
  WorkspaceOpportunityRankingCandidatesResultSchema,
} from "../src/durable-objects/workspace-opportunity-protocol";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000007a0");
const MEMBER = asUserId("00000000-0000-7000-8000-0000000007a1");
const OTHER = asUserId("00000000-0000-7000-8000-0000000007a2");

const NOW = "2026-08-19T12:00:00.000Z";
const LATER = "2026-08-19T12:05:00.000Z";

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

/**
 * Re-established per test rather than once, for the reason
 * `workspace-directory-reads.test.ts` gives: a sibling file's `reset()` takes
 * every object's input gate and wipes D1, so a one-time hook either waits it
 * out or has its tables removed underneath it.
 */
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces(id, region) VALUES (?, 'global')`)
      .bind(WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'owner')`)
      .bind(WORKSPACE_ID, MEMBER),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`)
      .bind(WORKSPACE_ID, OTHER),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  // Every test seeds what it needs; carrying a previous test's rows would make
  // the candidate assertions depend on execution order.
  await runInDurableObject(workspace(), (_instance, state) => {
    for (const table of [
      "suggested_work_sets",
      "suggested_work_ranking_rounds",
      "work_opportunity_user_states",
      "work_opportunity_user_links",
      "work_opportunity_snapshots",
      "work_opportunities",
    ]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
}, 30_000);

let opportunitySeq = 0;

interface OpportunityInput {
  audience?: { scope: "workspace"; userId: null } | { scope: "personal"; userId: string };
  status?: "active" | "starting" | "started" | "superseded" | "expired";
  expiresAt?: string;
  updatedAt?: string;
  startIdempotencyKey?: string | null;
}

/**
 * A row in `work_opportunities`, written straight into the object.
 *
 * `persistOpportunity` is the production writer and it needs an ingested
 * connector event behind it. Nothing below turns on provenance, and
 * `durable-object-runtime.test.ts` covers that whole path already — so these
 * seed the state the readers read, the way the batch-window fixture in that
 * file does.
 */
async function seedOpportunity(input: OpportunityInput = {}): Promise<string> {
  opportunitySeq += 1;
  const id = `00000000-0000-7000-8000-${String(opportunitySeq).padStart(9, "0")}7b0`;
  const audience = input.audience ?? { scope: "workspace" as const, userId: null };
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO work_opportunities
         (opportunity_id, audience_scope, audience_user_id, display_prompt, execution_prompt,
          admission_reasoning, provider_icon, source_label, source_fingerprint, version,
          display_prompt_hash, execution_prompt_hash, status, created_workstream_id,
          created_message_id, started_by_user_id, start_idempotency_key, expires_at,
          created_at, updated_at, started_at)
       VALUES (?, ?, ?, ?, 'Investigate the blocker.', 'Urgent and actionable.', 'plug',
               'Connected activity', ?, 1, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL)`,
      id,
      audience.scope,
      audience.userId,
      `Suggestion ${opportunitySeq}`,
      id.replaceAll("-", "").padEnd(64, "f"),
      "b".repeat(64),
      "c".repeat(64),
      input.status ?? "active",
      input.startIdempotencyKey ?? null,
      Date.parse(input.expiresAt ?? "2027-01-01T00:00:00.000Z"),
      Date.parse("2026-08-01T00:00:00.000Z"),
      Date.parse(input.updatedAt ?? NOW),
    );
  });
  return id;
}

async function dismiss(opportunityId: string, userId: string): Promise<void> {
  await expect(workspace().dismissOpportunity({
    workspaceId: WORKSPACE_ID,
    userId,
    opportunityId,
    now: NOW,
  })).resolves.toMatchObject({ dismissed: true });
}

/**
 * Parsed through the protocol schema, the way the Worker's own caller does.
 *
 * The RPC's inferred return type erases to `never` across the boundary, and
 * casting it would let a shape change reach an assertion untouched. Parsing
 * makes the contract part of what this file asserts.
 */
async function candidates(userId = MEMBER) {
  return WorkspaceOpportunityRankingCandidatesResultSchema.parse(
    await workspace().opportunityRankingCandidates({
      workspaceId: WORKSPACE_ID,
      userId,
      now: NOW,
    }),
  );
}

async function candidateIds(userId = MEMBER): Promise<string[]> {
  return (await candidates(userId)).map((candidate) => candidate.id);
}

/** Read the raw set row, for the columns no RPC projects. */
async function storedSet(userId = MEMBER): Promise<{
  due_at: number | null;
  request_seq: number;
  lease_id: string | null;
  last_ranked_at: number | null;
  status: string;
} | undefined> {
  return runInDurableObject(workspace(), (_instance, state) => (
    state.storage.sql.exec<{
      due_at: number | null;
      request_seq: number;
      lease_id: string | null;
      last_ranked_at: number | null;
      status: string;
    }>(
      `SELECT due_at, request_seq, lease_id, last_ranked_at, status
         FROM suggested_work_sets WHERE user_id = ?`,
      userId,
    ).toArray()[0]
  ));
}

describe("the ranking pipeline the workspace object owns", () => {
  describe("opportunityRankingCandidates", () => {
    it("offers the workspace's suggestions and the member's own, not somebody else's", async () => {
      const shared = await seedOpportunity();
      const mine = await seedOpportunity({
        audience: { scope: "personal", userId: MEMBER },
      });
      const theirs = await seedOpportunity({
        audience: { scope: "personal", userId: OTHER },
      });

      const ids = await candidateIds();

      expect(ids).toContain(shared);
      expect(ids).toContain(mine);
      // A personal suggestion is one person's; ranking it for anyone else would
      // put its display prompt in front of them.
      expect(ids).not.toContain(theirs);
    });

    it("drops a suggestion this member dismissed, and keeps it for everyone else", async () => {
      const dismissed = await seedOpportunity();

      await dismiss(dismissed, MEMBER);

      await expect(candidateIds(MEMBER)).resolves.not.toContain(dismissed);
      // Dismissal is per member, so the other member's candidate list is
      // untouched — this is the difference between "not for me" and "withdrawn".
      await expect(candidateIds(OTHER)).resolves.toContain(dismissed);
    });

    it("drops a suggestion that has expired or already been started", async () => {
      const expired = await seedOpportunity({ expiresAt: "2026-08-19T11:00:00.000Z" });
      const started = await seedOpportunity({ status: "started" });
      const live = await seedOpportunity();

      const ids = await candidateIds();

      expect(ids).toEqual([live]);
      expect(ids).not.toContain(expired);
      expect(ids).not.toContain(started);
    });

    it("marks the ones already on screen, so a re-rank knows what it is replacing", async () => {
      const suggested = await seedOpportunity();
      const fresh = await seedOpportunity();
      await workspace().storeOpportunityRanking({
        workspaceId: WORKSPACE_ID,
        userId: MEMBER,
        candidateFingerprint: "fingerprint",
        opportunityIds: [suggested],
        reasoning: "Ranked",
        model: null,
        status: "ready",
      });

      const ranked = await candidates();

      expect(ranked.find((candidate) => candidate.id === suggested)?.currentlySuggested)
        .toBe(true);
      expect(ranked.find((candidate) => candidate.id === fresh)?.currentlySuggested)
        .toBe(false);
    });
  });

  describe("storeOpportunityRanking and opportunityRankingState", () => {
    it("reports back exactly what was stored, in the order it was stored", async () => {
      const first = await seedOpportunity();
      const second = await seedOpportunity();

      await workspace().storeOpportunityRanking({
        workspaceId: WORKSPACE_ID,
        userId: MEMBER,
        candidateFingerprint: "fingerprint-one",
        opportunityIds: [second, first],
        reasoning: "Second reads more urgent",
        model: "x-ai/grok-4.5",
        status: "ready",
      });

      await expect(workspace().opportunityRankingState(WORKSPACE_ID, MEMBER))
        .resolves.toEqual({
          candidateFingerprint: "fingerprint-one",
          // The order is the ranking. Returning a set would lose the answer.
          opportunityIds: [second, first],
          status: "ready",
        });
    });

    it("replaces a member's set rather than accumulating rows", async () => {
      const first = await seedOpportunity();
      const second = await seedOpportunity();
      const store = (ids: string[], fingerprint: string) => workspace().storeOpportunityRanking({
        workspaceId: WORKSPACE_ID,
        userId: MEMBER,
        candidateFingerprint: fingerprint,
        opportunityIds: ids,
        reasoning: "Ranked",
        model: null,
        status: "ready",
      });

      await store([first], "fingerprint-one");
      await store([second], "fingerprint-two");

      await expect(workspace().opportunityRankingState(WORKSPACE_ID, MEMBER))
        .resolves.toMatchObject({
          candidateFingerprint: "fingerprint-two",
          opportunityIds: [second],
        });
    });

    it("answers with nothing for a member who has never been ranked", async () => {
      // Not an empty ranking — the read path treats those differently, and a
      // member with no row at all is the state a new member is in.
      await expect(workspace().opportunityRankingState(WORKSPACE_ID, OTHER))
        .resolves.toBeNull();
    });
  });

  describe("settleOpportunityRanking — the standoff `request_seq` prevents", () => {
    /** Put the member's set under a lease, as the product alarm's claim does. */
    async function lease(requestSeq: number): Promise<string> {
      const leaseId = "00000000-0000-7000-8000-0000000007c1";
      await workspace().markOpportunityRankingDue(WORKSPACE_ID, [MEMBER], 0);
      await runInDurableObject(workspace(), (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE suggested_work_sets
              SET lease_id = ?, lease_expires_at = ?, request_seq = ?
            WHERE user_id = ?`,
          leaseId,
          Date.now() + 600_000,
          requestSeq,
          MEMBER,
        );
      });
      return leaseId;
    }

    it("clears the request it answered", async () => {
      const leaseId = await lease(4);

      await workspace().settleOpportunityRanking({
        workspaceId: WORKSPACE_ID,
        userId: MEMBER,
        leaseId,
        requestSeq: 4,
        outcome: "completed",
        retryAt: null,
      });

      const set = await storedSet();
      expect(set?.due_at).toBeNull();
      expect(set?.lease_id).toBeNull();
      expect(set?.last_ranked_at).not.toBeNull();
    });

    it("leaves a request that arrived while it was ranking", async () => {
      const leaseId = await lease(4);

      // The member dismissed something mid-pass, so a new ranking is owed. The
      // pass settling now answered the *previous* request; clearing this one
      // would drop a refill nobody will ask for again.
      await workspace().markOpportunityRankingDue(WORKSPACE_ID, [MEMBER], 0);
      const beforeSettle = await storedSet();
      expect(beforeSettle?.request_seq).toBe(5);

      await workspace().settleOpportunityRanking({
        workspaceId: WORKSPACE_ID,
        userId: MEMBER,
        leaseId,
        requestSeq: 4,
        outcome: "completed",
        retryAt: null,
      });

      const set = await storedSet();
      expect(set?.due_at).not.toBeNull();
      expect(set?.lease_id).toBeNull();
    });

    it("re-arms a failed pass at the retry instant it was given", async () => {
      const leaseId = await lease(4);
      const retryAt = "2026-08-19T12:30:00.000Z";

      await workspace().settleOpportunityRanking({
        workspaceId: WORKSPACE_ID,
        userId: MEMBER,
        leaseId,
        requestSeq: 4,
        outcome: "failed",
        retryAt,
      });

      const set = await storedSet();
      expect(set?.status).toBe("failed");
      expect(set?.lease_id).toBeNull();
      expect(set?.due_at).toBe(Date.parse(retryAt));
    });

    it("ignores a settle carrying a lease the set no longer holds", async () => {
      await lease(4);

      // A pass whose lease expired and was claimed by another must not settle
      // the ranking that replaced it.
      await workspace().settleOpportunityRanking({
        workspaceId: WORKSPACE_ID,
        userId: MEMBER,
        leaseId: "00000000-0000-7000-8000-0000000007cf",
        requestSeq: 4,
        outcome: "completed",
        retryAt: null,
      });

      const set = await storedSet();
      expect(set?.lease_id).toBe("00000000-0000-7000-8000-0000000007c1");
      expect(set?.due_at).not.toBeNull();
    });
  });

  describe("recordOpportunityRankingRound", () => {
    it("keeps the round the ranking produced, with its candidates and its choice", async () => {
      const first = await seedOpportunity();
      const second = await seedOpportunity();

      await workspace().recordOpportunityRankingRound({
        workspaceId: WORKSPACE_ID,
        userId: MEMBER,
        roundId: "00000000-0000-7000-8000-0000000007d1",
        candidateIds: [first, second],
        selectedIds: [second],
        reasoning: "Second is blocking somebody",
        model: "x-ai/grok-4.5",
        roundNumber: 0,
      });

      const rounds = await runInDurableObject(workspace(), (_instance, state) => (
        state.storage.sql.exec<{
          candidate_ids_json: string; selected_ids_json: string; round_number: number;
        }>(
          `SELECT candidate_ids_json, selected_ids_json, round_number
             FROM suggested_work_ranking_rounds WHERE user_id = ?`,
          MEMBER,
        ).toArray()
      ));

      expect(rounds).toHaveLength(1);
      expect(JSON.parse(rounds[0]!.candidate_ids_json)).toEqual([first, second]);
      expect(JSON.parse(rounds[0]!.selected_ids_json)).toEqual([second]);
      expect(rounds[0]!.round_number).toBe(0);
    });
  });

  describe("completeOpportunityStart — the third leg of the claim ledger", () => {
    it("records the work stream the claim created and takes the suggestion off screen", async () => {
      const opportunityId = await seedOpportunity();
      const claim = WorkspaceOpportunityClaimStartResultSchema.parse(
        await workspace().claimOpportunityStart({
          workspaceId: WORKSPACE_ID,
          userId: MEMBER,
          opportunityId,
          now: NOW,
          version: 1,
          idempotencyKey: "start-once",
        }),
      );
      expect(claim.outcome).toBe("claimed");

      await workspace().completeOpportunityStart({
        workspaceId: WORKSPACE_ID,
        userId: MEMBER,
        opportunityId,
        now: LATER,
        version: 1,
        idempotencyKey: "start-once",
        workstreamId: "00000000-0000-7000-8000-0000000007e1",
        messageId: "00000000-0000-7000-8000-0000000007e2",
        snapshotId: "00000000-0000-7000-8000-0000000007e3",
      });

      const stored = await runInDurableObject(workspace(), (_instance, state) => (
        state.storage.sql.exec<{
          status: string; created_workstream_id: string | null; created_message_id: string | null;
        }>(
          `SELECT status, created_workstream_id, created_message_id
             FROM work_opportunities WHERE opportunity_id = ?`,
          opportunityId,
        ).one()
      ));
      expect(stored).toMatchObject({
        status: "started",
        created_workstream_id: "00000000-0000-7000-8000-0000000007e1",
        created_message_id: "00000000-0000-7000-8000-0000000007e2",
      });
      // A started suggestion stops being offered, which is what makes the start
      // final rather than a state the next ranking could undo.
      await expect(candidateIds()).resolves.not.toContain(opportunityId);
    });

    it("refuses to complete a claim whose key does not match the one that was made", async () => {
      const opportunityId = await seedOpportunity();
      await workspace().claimOpportunityStart({
        workspaceId: WORKSPACE_ID,
        userId: MEMBER,
        opportunityId,
        now: NOW,
        version: 1,
        idempotencyKey: "start-once",
      });

      // The fence is the whole point of a three-leg ledger: an attempt that
      // lost the claim and finished anyway must not stamp its work stream onto
      // the suggestion the winner is starting.
      //
      // Asserted inside the object rather than across the RPC, deliberately.
      // Called on a stub, this throw left *two* rejected promises — the one the
      // caller awaits, and one the RPC layer holds for the remote call — and an
      // assertion handles only the first. The second reached Vitest as an
      // unhandled rejection, which fails the run under a summary reading
      // "222 passed". The success path above covers the RPC hop; this covers
      // what the fence decides.
      await expect(runInDurableObject(workspace(), async (instance) => {
        await (instance as WorkspaceDO).completeOpportunityStart({
          workspaceId: WORKSPACE_ID,
          userId: MEMBER,
          opportunityId,
          now: LATER,
          version: 1,
          idempotencyKey: "a-different-attempt",
          workstreamId: "00000000-0000-7000-8000-0000000007e4",
          messageId: "00000000-0000-7000-8000-0000000007e5",
          snapshotId: "00000000-0000-7000-8000-0000000007e6",
        });
      })).rejects.toThrow(/work_opportunity_start_fenced/u);

      // And the winner's row is untouched by the loser's attempt.
      const stored = await runInDurableObject(workspace(), (_instance, state) => (
        state.storage.sql.exec<{ created_workstream_id: string | null }>(
          `SELECT created_workstream_id FROM work_opportunities WHERE opportunity_id = ?`,
          opportunityId,
        ).one()
      ));
      expect(stored.created_workstream_id).toBeNull();
    });
  });

  it("returns visibility-filtered telemetry context with each member action", async () => {
    const opportunityId = await seedOpportunity();
    const firstImpressedAt = Date.parse("2026-08-19T11:55:00.000Z");
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO work_opportunity_user_states (
           opportunity_id, user_id, status, impression_count, first_impressed_at,
           last_impressed_at, resolved_at, created_workstream_id, updated_at
         ) VALUES (?, ?, 'impressed', 2, ?, ?, NULL, NULL, ?)`,
        opportunityId,
        MEMBER,
        firstImpressedAt,
        firstImpressedAt,
        firstImpressedAt,
      );
      const nodes = [
        ["00000000-0000-7000-8000-0000000008b1", "slack", "workspace", null],
        ["00000000-0000-7000-8000-0000000008b2", "linear", "personal", MEMBER],
        ["00000000-0000-7000-8000-0000000008b3", "github", "personal", OTHER],
      ] as const;
      for (const [nodeId, provider, visibilityScope, visibilityUserId] of nodes) {
        state.storage.sql.exec(
          `INSERT INTO opportunity_provenance_nodes (
             node_id, node_kind, source_id, provider, provider_tenant_id, canonical_url,
             label, occurred_at, visibility_scope, visibility_user_id, locator_json, created_at
           ) VALUES (?, 'activity', ?, ?, NULL, NULL, ?, ?, ?, ?, '{}', ?)`,
          nodeId,
          nodeId,
          provider,
          `${provider} source`,
          firstImpressedAt,
          visibilityScope,
          visibilityUserId,
          firstImpressedAt,
        );
      }
      nodes.forEach(([nodeId], position) => {
        state.storage.sql.exec(
          `INSERT INTO work_opportunity_provenance_roots (opportunity_id, node_id, position)
           VALUES (?, ?, ?)`,
          opportunityId,
          nodeId,
          position,
        );
      });
    });

    const impressions = await workspace().recordOpportunityImpressions({
      workspaceId: WORKSPACE_ID,
      userId: MEMBER,
      opportunityIds: [opportunityId],
      now: NOW,
      rerankBefore: "2026-08-19T11:00:00.000Z",
    });
    const expectedContext = {
      opportunityId,
      version: 1,
      audienceScope: "workspace",
      createdAt: "2026-08-01T00:00:00.000Z",
      impressionCount: 3,
      firstImpressedAt: "2026-08-19T11:55:00.000Z",
      connectorTypes: ["linear", "slack"],
    };
    expect(impressions).toEqual([expectedContext]);

    const claim = WorkspaceOpportunityClaimStartResultSchema.parse(
      await workspace().claimOpportunityStart({
        workspaceId: WORKSPACE_ID,
        userId: MEMBER,
        opportunityId,
        now: NOW,
        version: 1,
        idempotencyKey: "telemetry-context",
      }),
    );
    expect(claim.telemetryContext).toEqual(expectedContext);
    await workspace().releaseOpportunityStart({
      workspaceId: WORKSPACE_ID,
      userId: MEMBER,
      opportunityId,
      now: NOW,
      version: 1,
      idempotencyKey: "telemetry-context",
    });

    await expect(workspace().dismissOpportunity({
      workspaceId: WORKSPACE_ID,
      userId: MEMBER,
      opportunityId,
      now: NOW,
    })).resolves.toEqual({ dismissed: true, telemetryContext: expectedContext });
  });
});
