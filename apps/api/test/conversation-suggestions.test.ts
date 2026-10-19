/**
 * The conversation suggestion slot and the turn-disposition observer, against
 * the real object schema in node:sqlite with a TypeSafe double: the gates in
 * order, one row per confident positive, every decision recorded, a replayed
 * settlement writing nothing twice, a pending row resumed at the draft, the
 * newest-three expiry, and the three resolutions (merge marker, Breakout cut,
 * dismissal). `docs/conversation-suggestions.md` owns the lifecycle.
 */
import "../../../tests/isolated-region";
import { SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationSuggestionStorage,
  observeTurnDisposition,
  resourceEmbeds,
  suggestionForClient,
  type TurnDispositionObservationInput,
} from "../src/durable-objects/conversation-suggestions";
import {
  seedCanonicalConversationTurn,
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";
import { createTestSqlStorage } from "./helpers/sql-storage";

const workspaceId = "00000000-0000-7000-8000-000000000021";
const workstreamId = "00000000-0000-7000-8000-000000000022";
const userId = "00000000-0000-7000-8000-000000000023";
const runId = "run-1";

function answering(choice: string, confidence: number, kind = "deliverable"): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({
    model: "jev-1.13.0",
    answers: {
      disposition: { type: "choice", choice, confidence },
      carried_item_kind: { type: "choice", choice: kind, confidence: 0.9 },
    },
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

function conversation(turns: Array<{ actor: "human" | "assistant" | "system"; text: string; structured?: string; messageType?: "text" | "system" }>) {
  const database = testWorkstreamObjectStore();
  seedWorkstreamObjectRoot(database, { workstreamId, workspaceId });
  turns.forEach((turn, index) => {
    seedCanonicalConversationTurn(database, {
      turnId: `turn-${index + 1}`,
      actor: turn.actor,
      authorUserId: turn.actor === "human" ? userId : null,
      authorSnapshot: turn.actor === "human" ? { displayName: "Morgan", avatarUrl: null } : null,
      text: turn.text,
      transcriptSequence: index + 1,
      createdAt: Date.parse("2026-10-18T10:00:00.000Z") + index * 1000,
      ...(turn.messageType ? { messageType: turn.messageType } : {}),
      ...(turn.structured ? { structuredContentJson: turn.structured } : {}),
      ...(turn.actor === "assistant" ? { producedByRunId: runId } : {}),
    });
  });
  const storage = new ConversationSuggestionStorage(createTestSqlStorage(database));
  return { database, storage };
}

let ids = 0;
function observation(storage: ConversationSuggestionStorage, overrides: Partial<TurnDispositionObservationInput> = {}): TurnDispositionObservationInput {
  return {
    env: { TYPESAFE_API_KEY: "typesafe-key" },
    fetch: answering("worth_carrying_up", 0.91),
    storage,
    workspaceId,
    workstreamId,
    substreamId: "00000000-0000-7000-8000-000000000024",
    runId,
    finalTurnId: "turn-2",
    completed: true,
    backgroundAgent: false,
    identity: { title: "Annual discount", description: "Decide whether the annual plan keeps a discount.", scope: "workspace", archived_at: null, system_kind: null },
    readParent: async () => ({ kind: "thread", id: workstreamId, title: "Pricing for the spring launch", purpose: undefined }),
    onDiagnostic: () => undefined,
    traceId: "trace-1",
    now: () => 1_700_000_000_000,
    newId: () => `00000000-0000-7000-8000-0000000001${String(++ids).padStart(2, "0")}`,
    commit: (mutate) => mutate(),
    ...overrides,
  };
}

const twoTurns = [
  { actor: "human" as const, text: "Should we keep the 20% annual discount at launch?" },
  { actor: "assistant" as const, text: "Keep it. Annual customers churn at a third of the monthly rate. ![Retention table](resource://019fc000-0000-7000-8000-000000000001)" },
];

describe("observeTurnDisposition", () => {
  it("writes one open merge_up row and the judgement for a confident positive in a Breakout", async () => {
    const { storage } = conversation(twoTurns);
    const fetcher = answering("worth_carrying_up", 0.91);
    const result = await observeTurnDisposition(observation(storage, { fetch: fetcher }));
    expect(result.outcome).toBe("judged");
    if (result.outcome !== "judged") return;
    expect(result.code).toBe("worth_carrying_up");
    expect(result.suggestion).toMatchObject({
      kind: "merge_up", judged_turn_id: "turn-2", judged_turn_sequence: 2, status: "open", draft_status: "pending",
      target_kind: "thread", target_id: workstreamId, target_title: "Pricing for the spring launch",
      decision_choice: "worth_carrying_up", decision_confidence: 0.91, decision_model: "jev-1.13.0",
    });
    expect(storage.judgementForRun(runId)).toEqual({ code: "worth_carrying_up", failure_kind: null, suggestion_id: result.suggestion!.suggestion_id });
    expect(storage.open()).toHaveLength(1);
    // The request named the parent and carried the judged message's embed as new here.
    const request = JSON.parse(String((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body)) as {
      state: { parent: { title: string }; judged_message: { outputs: Array<{ title: string; first_time_here: boolean }> }; recent_messages: unknown[]; conversation: { messages_before: number } };
    };
    expect(request.state.parent.title).toBe("Pricing for the spring launch");
    expect(request.state.judged_message.outputs).toEqual([{ title: "Retention table", first_time_here: true }]);
    expect(request.state.recent_messages).toHaveLength(1);
    expect(request.state.conversation.messages_before).toBe(1);
  });

  it("records a continue_here answer and writes no row", async () => {
    const { storage } = conversation(twoTurns);
    const result = await observeTurnDisposition(observation(storage, { fetch: answering("continue_here", 0.8) }));
    expect(result).toMatchObject({ outcome: "judged", code: "continue_here", suggestion: null });
    expect(storage.judgementForRun(runId)?.code).toBe("continue_here");
    expect(storage.open()).toEqual([]);
  });

  it("records a positive at the threshold as confidence_below_threshold, since the comparison is strict", async () => {
    const { storage } = conversation(twoTurns);
    const result = await observeTurnDisposition(observation(storage, { fetch: answering("worth_carrying_up", 0.6) }));
    expect(result).toMatchObject({ outcome: "judged", code: "confidence_below_threshold", suggestion: null });
  });

  it("judges a run once: a replayed settlement finds the judgement and asks nothing", async () => {
    const { storage } = conversation(twoTurns);
    const first = answering("worth_carrying_up", 0.91);
    await observeTurnDisposition(observation(storage, { fetch: first }));
    const second = answering("worth_carrying_up", 0.91);
    const replay = await observeTurnDisposition(observation(storage, { fetch: second }));
    // The first row is still pending its draft, so the replay resumes there.
    expect(replay.outcome).toBe("resumed");
    expect(second).not.toHaveBeenCalled();
    storage.setDraft(storage.open()[0]!.suggestion_id, { text: "Keep the discount.", subject: null });
    const third = answering("worth_carrying_up", 0.91);
    expect(await observeTurnDisposition(observation(storage, { fetch: third }))).toEqual({ outcome: "skipped", gate: "already_judged" });
    expect(third).not.toHaveBeenCalled();
    expect(storage.open()).toHaveLength(1);
  });

  it("stops at the cheap gates before any call", async () => {
    const { storage } = conversation(twoTurns);
    const fetcher = answering("worth_carrying_up", 0.91);
    expect(await observeTurnDisposition(observation(storage, { fetch: fetcher, completed: false }))).toEqual({ outcome: "skipped", gate: "run_not_completed" });
    expect(await observeTurnDisposition(observation(storage, { fetch: fetcher, finalTurnId: "turn-1" }))).toEqual({ outcome: "skipped", gate: "final_turn_not_text" });
    expect(await observeTurnDisposition(observation(storage, { fetch: fetcher, backgroundAgent: true }))).toEqual({ outcome: "skipped", gate: "background_agent" });
    expect(await observeTurnDisposition(observation(storage, { fetch: fetcher, identity: { title: "t", description: "", scope: "workspace", archived_at: 5, system_kind: null } }))).toEqual({ outcome: "skipped", gate: "archived" });
    expect(await observeTurnDisposition(observation(storage, { fetch: fetcher, identity: { title: "t", description: "", scope: "workspace", archived_at: null, system_kind: "digest" } }))).toEqual({ outcome: "skipped", gate: "system_conversation" });
    expect(await observeTurnDisposition(observation(storage, { fetch: fetcher, readParent: async () => null }))).toEqual({ outcome: "skipped", gate: "nothing_offerable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not suggest a result the conversation already carried up", async () => {
    const { storage } = conversation([
      ...twoTurns,
      { actor: "system", messageType: "system", text: "Merged into Pricing", structured: JSON.stringify({ type: "conversation_merged_into", mergedByUserId: userId }) },
    ]);
    const fetcher = answering("worth_carrying_up", 0.91);
    expect(await observeTurnDisposition(observation(storage, { fetch: fetcher }))).toEqual({ outcome: "skipped", gate: "already_carried_up" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("records a positive that lands behind three newer messages as late and shows nothing", async () => {
    const { storage } = conversation([
      ...twoTurns,
      { actor: "human", text: "thanks" },
      { actor: "assistant", text: "You're welcome." },
      { actor: "human", text: "one more thing" },
    ]);
    const result = await observeTurnDisposition(observation(storage));
    expect(result).toMatchObject({ outcome: "judged", code: "late", suggestion: null });
  });

  it("offers a Thread only start_breakout when it is private, and records a merge positive as not_offerable", async () => {
    const { storage } = conversation(twoTurns);
    const privateThread = { title: "t", description: "", scope: "private", archived_at: null, system_kind: null };
    const merge = await observeTurnDisposition(observation(storage, { substreamId: "0", identity: privateThread, fetch: answering("worth_carrying_up", 0.9) }));
    expect(merge).toMatchObject({ outcome: "judged", code: "not_offerable", suggestion: null });
    const { storage: second } = conversation(twoTurns);
    const breakout = await observeTurnDisposition(observation(second, { substreamId: "0", identity: privateThread, fetch: answering("side_question_worth_a_breakout", 0.9) }));
    expect(breakout.outcome === "judged" && breakout.suggestion?.kind).toBe("start_breakout");
    expect(breakout.outcome === "judged" && breakout.suggestion?.target_kind).toBeNull();
  });

  it("paces by the cooldown after a dismissal of the same kind, at a finite value and not at the open one", async () => {
    const { storage } = conversation(twoTurns);
    const now = 1_700_000_000_000;
    const earlier = storage.insertOpen({
      suggestionId: "00000000-0000-7000-8000-000000000199", kind: "merge_up", judgedTurnId: "turn-1", judgedTurnSequence: 1,
      runId: "run-0", target: null, decision: { choice: "worth_carrying_up", confidence: 0.9, model: "jev" }, now: now - 1000,
    });
    storage.dismiss(earlier.suggestion_id, userId, now - 500);
    const paced = await observeTurnDisposition(observation(storage, { cooldownMs: 60_000 }));
    expect(paced).toMatchObject({ outcome: "judged", code: "paced", suggestion: null });
    const { storage: open } = conversation(twoTurns);
    const earlierOpen = open.insertOpen({
      suggestionId: "00000000-0000-7000-8000-000000000198", kind: "merge_up", judgedTurnId: "turn-1", judgedTurnSequence: 1,
      runId: "run-0", target: null, decision: { choice: "worth_carrying_up", confidence: 0.9, model: "jev" }, now: now - 1000,
    });
    open.dismiss(earlierOpen.suggestion_id, userId, now - 500);
    const shown = await observeTurnDisposition(observation(open, { cooldownMs: 0 }));
    expect(shown.outcome === "judged" && shown.suggestion?.kind).toBe("merge_up");
  });

  it("records classifier_unavailable without a key, naming why, and still writes no row", async () => {
    const { storage } = conversation(twoTurns);
    const fetcher = answering("worth_carrying_up", 0.91);
    const result = await observeTurnDisposition(observation(storage, { env: {}, fetch: fetcher }));
    expect(result).toMatchObject({ outcome: "judged", code: "classifier_unavailable", failureKind: "typesafe_key_missing", suggestion: null });
    expect(fetcher).not.toHaveBeenCalled();
    expect(storage.judgementForRun(runId)).toMatchObject({ code: "classifier_unavailable", failure_kind: "typesafe_key_missing" });
  });

  it("asks again after a recorded classifier failure, since a failure is not an answer", async () => {
    const { storage } = conversation(twoTurns);
    await observeTurnDisposition(observation(storage, { env: {} }));
    const fetcher = answering("worth_carrying_up", 0.91);
    const again = await observeTurnDisposition(observation(storage, { fetch: fetcher }));
    expect(again).toMatchObject({ outcome: "judged", code: "worth_carrying_up" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(storage.judgementForRun(runId)).toMatchObject({ code: "worth_carrying_up", failure_kind: null });
    expect(storage.open()).toHaveLength(1);
  });

  it("records a confident side question in a Breakout as not_offerable, not as below the threshold", async () => {
    const { storage } = conversation(twoTurns);
    const result = await observeTurnDisposition(observation(storage, { fetch: answering("side_question_worth_a_breakout", 0.95) }));
    expect(result).toMatchObject({ outcome: "judged", code: "not_offerable", confidence: 0.95, suggestion: null });
  });

  it("writes no row when a merge lands while the classifier is answering", async () => {
    const { database, storage } = conversation(twoTurns);
    const answer = answering("worth_carrying_up", 0.91);
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      // The merge marker appends during the call: the pre-call gate saw none.
      seedCanonicalConversationTurn(database, {
        turnId: "turn-3", actor: "system", authorUserId: null, authorSnapshot: null, messageType: "system",
        text: "Merged into Pricing", transcriptSequence: 3, createdAt: Date.parse("2026-10-18T10:00:05.000Z"),
        structuredContentJson: JSON.stringify({ type: "conversation_merged_into", mergedByUserId: userId }),
      });
      return answer(...args);
    }) as unknown as typeof fetch;
    const result = await observeTurnDisposition(observation(storage, { fetch: fetcher }));
    expect(result).toMatchObject({ outcome: "judged", code: "already_carried_up", suggestion: null });
    expect(storage.open()).toEqual([]);
    expect(storage.judgementForRun(runId)?.code).toBe("already_carried_up");
  });

  it("writes nothing when another caller judged the run while the classifier was answering", async () => {
    const { storage } = conversation(twoTurns);
    const answer = answering("worth_carrying_up", 0.91);
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      // The backfill and the settlement judge the same run; the other finishes first.
      await observeTurnDisposition(observation(storage, { fetch: answering("continue_here", 0.8) }));
      return answer(...args);
    }) as unknown as typeof fetch;
    const result = await observeTurnDisposition(observation(storage, { fetch: fetcher }));
    expect(result).toEqual({ outcome: "skipped", gate: "already_judged" });
    expect(storage.judgementForRun(runId)).toMatchObject({ code: "continue_here", suggestion_id: null });
    expect(storage.open()).toEqual([]);
  });
});

describe("ConversationSuggestionStorage", () => {
  function openRow(storage: ConversationSuggestionStorage, kind: "merge_up" | "start_breakout", turn: string, sequence: number) {
    return storage.insertOpen({
      suggestionId: `00000000-0000-7000-8000-0000000002${String(sequence).padStart(2, "0")}`, kind, judgedTurnId: turn, judgedTurnSequence: sequence,
      runId: `run-${sequence}`, target: { kind: "thread", id: workstreamId, title: "Pricing" },
      decision: { choice: "worth_carrying_up", confidence: 0.9, model: "jev" }, now: 1_700_000_000_000,
    });
  }

  it("expires an open row behind three newer readable messages, not two, as ignored", () => {
    const { database, storage } = conversation([...twoTurns, { actor: "human", text: "thanks" }, { actor: "assistant", text: "You're welcome." }]);
    openRow(storage, "merge_up", "turn-2", 2);
    expect(storage.expireBehindNewest(1)).toEqual([]);
    seedCanonicalConversationTurn(database, {
      turnId: "turn-5", actor: "system", authorSnapshot: null, messageType: "system", text: "a system row", transcriptSequence: 5, createdAt: 5,
    });
    expect(storage.expireBehindNewest(2)).toEqual([]);
    seedCanonicalConversationTurn(database, {
      turnId: "turn-6", actor: "human", authorUserId: userId, authorSnapshot: { displayName: "Morgan", avatarUrl: null }, text: "third", transcriptSequence: 6, createdAt: 6,
    });
    const expired = storage.expireBehindNewest(3);
    expect(expired.map((row) => [row.status, row.resolution, row.resolved_at])).toEqual([["expired", "ignored", 3]]);
    expect(SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS).toBe(3);
    expect(storage.open()).toEqual([]);
  });

  it("resolves open merge rows at or before a merge marker as accepted, and leaves a later one open", () => {
    const { storage } = conversation([...twoTurns, { actor: "human", text: "and the Starter tier?" }, { actor: "assistant", text: "Starter needs its own look." }]);
    openRow(storage, "merge_up", "turn-2", 2);
    openRow(storage, "merge_up", "turn-4", 4);
    const resolved = storage.resolveMergedThrough(3, userId, 9);
    expect(resolved.map((row) => [row.judged_turn_id, row.status, row.resolution, row.resolved_by_user_id])).toEqual([["turn-2", "accepted", "accepted", userId]]);
    expect(storage.open().map((row) => row.judged_turn_id)).toEqual(["turn-4"]);
  });

  it("resolves the breakout row on the cut turn only, and dismisses once", () => {
    const { storage } = conversation([...twoTurns, { actor: "human", text: "and the Starter tier?" }, { actor: "assistant", text: "Starter needs its own look." }]);
    openRow(storage, "start_breakout", "turn-4", 4);
    const other = openRow(storage, "merge_up", "turn-2", 2);
    expect(storage.resolveBreakoutAt("turn-2", userId, 9)).toBeNull();
    expect(storage.resolveBreakoutAt("turn-4", userId, 9)?.status).toBe("accepted");
    expect(storage.dismiss(other.suggestion_id, userId, 10)?.resolution).toBe("dismissed");
    expect(storage.dismiss(other.suggestion_id, userId, 11)).toBeNull();
    expect(storage.open()).toEqual([]);
  });

  it("fills a pending draft in place and withdraws a failed one", () => {
    const { storage } = conversation(twoTurns);
    const row = openRow(storage, "start_breakout", "turn-2", 2);
    const filled = storage.setDraft(row.suggestion_id, { text: "Look at the Starter tier.", subject: "Starter tier" });
    expect(suggestionForClient(filled!)).toMatchObject({ status: "open", draft: { status: "ready", text: "Look at the Starter tier.", subject: "Starter tier" } });
    expect(storage.setDraft(row.suggestion_id, null)).toBeNull();
    const second = openRow(storage, "merge_up", "turn-1", 1);
    expect(storage.setDraft(second.suggestion_id, null)).toMatchObject({ status: "withdrawn", draft_status: "failed" });
  });

  describe("newestSettledTurn, the backfill's pick", () => {
    function settledRun(database: ReturnType<typeof testWorkstreamObjectStore>, id: string, finalTurnId: string, status: "completed" | "running" = "completed") {
      seedWorkstreamRun(database, { id, status });
      database.prepare("UPDATE runs SET final_turn_id = ? WHERE run_id = ?").run(finalTurnId, id);
    }

    it("names the newest completed final turn among the newest three readable messages", () => {
      const { database, storage } = conversation([...twoTurns, { actor: "human", text: "and the Starter tier?" }, { actor: "assistant", text: "Starter needs its own look." }]);
      settledRun(database, "run-a", "turn-2");
      settledRun(database, "run-b", "turn-4");
      expect(storage.newestSettledTurn()).toEqual({ runId: "run-b", turnId: "turn-4" });
    });

    it("finds nothing when the last settled turn sits behind three newer messages", () => {
      const { database, storage } = conversation([...twoTurns, { actor: "human", text: "thanks" }, { actor: "human", text: "one more thing" }, { actor: "human", text: "never mind" }]);
      settledRun(database, "run-a", "turn-2");
      expect(storage.newestSettledTurn()).toBeNull();
    });

    it("finds nothing when the newest Rally turn's run has not completed", () => {
      const { database, storage } = conversation(twoTurns);
      settledRun(database, "run-a", "turn-2", "running");
      expect(storage.newestSettledTurn()).toBeNull();
    });
  });

  it("reads resource embeds once each with the link text as the title", () => {
    expect(resourceEmbeds("See ![Table](resource://a1) and [Table](resource://a1) then [Memo](resource://b2).")).toEqual([
      { id: "a1", title: "Table" }, { id: "b2", title: "Memo" },
    ]);
  });
});
