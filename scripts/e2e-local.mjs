#!/usr/bin/env node
// End-to-end behavior of the running local stack, through the same public API
// the desktop client uses: happy paths that must produce an agent reply, sad
// paths that must be refused safely, and chaos paths that must not corrupt or
// wedge anything. This lane exists because it catches what the unit and
// workerd suites structurally cannot: its first sustained run found a view
// trigger that crashed every retried run's settlement, a creation path that
// never scheduled work-stream naming, and a compound-SELECT limit under load.
//
//   pnpm db:migrate && pnpm db:seed && pnpm db:open-authority
//   pnpm dev:api:local          # in another terminal
//   pnpm e2e:local              # defaults: --happy 10 --sad 8 --chaos 2
//
// Model dependence is decided from the Worker's own /health: with OpenRouter
// configured, a run must complete with a reply; without it, a run must still
// reach a terminal state and tell the member the truth — the lane degrades to
// the boundary oracle rather than silently passing.
import { writeFileSync } from "node:fs";

import { isEntryPoint } from "./entry-point.mjs";
import {
  openSubstreamSocket,
  socketTicketProtocols,
  socketUrlWithoutTicket,
} from "./substream-socket-client.mjs";

const BASE_URL = process.env.AVALON_E2E_BASE_URL ?? "http://127.0.0.1:8787";
const REPORT_PATH = process.env.AVALON_E2E_REPORT ?? null;

/**
 * The opening message the oversize scenario sends: one character past
 * `MESSAGE_MAX_CHARACTERS` in `@rally/contracts`.
 *
 * Carried here rather than imported because this lane is plain Node and the
 * contracts package is TypeScript. That copy is the hazard: this number sat at
 * 50,001 when the ceiling moved to 100,000, which turned the sad path into a
 * *valid* create — the assertion would fail, and the lane would open a real
 * work stream and launch a model-backed run on every pass. `e2e-local-oracles.test.mjs`
 * reads both numbers out of their sources and fails `pnpm test:scripts` when
 * they disagree, so the next move of the ceiling breaks a gate instead of this.
 */
export const OVERSIZE_MESSAGE_CHARACTERS = 100_001;

/** Member-visible states that mean the work stream is no longer working. */
export const TERMINAL_STATES = ["completed", "failed", "needs_input", "stopped", "idle"];

/**
 * What a finished run must look like, given whether a model is reachable.
 * `idle` is the legitimate post-stop resting state — treating it as a hang was
 * this campaign's own first false positive.
 */
export function runOutcomeOracle(modelConfigured, terminal) {
  if (!TERMINAL_STATES.includes(terminal.status)) {
    return { ok: false, reason: `never reached a terminal state (${terminal.status})` };
  }
  if (!modelConfigured) {
    return terminal.status === "completed" && !terminal.agentText
      ? { ok: false, reason: "completed with no reply and no model to produce one" }
      : { ok: true };
  }
  if (terminal.status === "needs_input") return { ok: true, note: "model asked a question" };
  if (terminal.status !== "completed") return { ok: false, reason: `terminal=${terminal.status}` };
  if (!terminal.agentText) return { ok: false, reason: "completed with no agent reply text" };
  return { ok: true };
}

/**
 * Whether the lane may run, given the Worker's provider state.
 *
 * The no-model oracle only proves "terminal and truthful" — it cannot catch a
 * run that fails before the provider for the wrong reason, which is exactly
 * the defect family this lane exists for. So a missing key is a refusal by
 * default, and degrading is a choice a caller states, never a silent
 * weakening the summary line has to be read carefully to notice.
 */
export function modelGateDecision(modelConfigured, allowNoModel) {
  if (modelConfigured) return { run: true, degraded: false };
  if (allowNoModel) return { run: true, degraded: true };
  return {
    run: false,
    reason: "OpenRouter is not configured on the Worker. Add OPENROUTER_API_KEY to .env.local, run `pnpm env:sync`, restart `pnpm dev:api:local` — or pass --allow-no-model to run the degraded terminal-and-truthful oracles only.",
  };
}

/** Interleaves lanes so load is realistic rather than phase-batched. */
export function buildPlan(counts, lanes) {
  const plan = [];
  for (const [lane, count] of Object.entries(counts)) {
    const kinds = lanes[lane] ?? [];
    for (let index = 0; index < count; index += 1) {
      plan.push([kinds[index % kinds.length], index]);
    }
  }
  return plan;
}

if (isEntryPoint(import.meta.url)) await main();

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((argument, index, all) => {
    if (!argument.startsWith("--")) return null;
    const value = Number(all[index + 1]);
    // `|| 1` here once turned `--chaos 0` into one chaos scenario: zero is a
    // value, not an absence.
    return [argument.slice(2), Number.isFinite(value) ? value : 1];
  }).filter(Boolean));
  const counts = { happy: args.happy ?? 10, sad: args.sad ?? 8, chaos: args.chaos ?? 2 };
  const concurrency = args.concurrency ?? 4;

  const health = await fetch(new URL("/health", BASE_URL)).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.error(`No healthy Worker at ${BASE_URL} — start one with \`pnpm dev:api:local\`.`);
    process.exit(1);
  }
  const modelConfigured = health.checks?.openRouter?.ok === true
    && health.checks.openRouter.message === "configured";
  const gate = modelGateDecision(modelConfigured, Boolean(args["allow-no-model"]));
  if (!gate.run) {
    console.error(gate.reason);
    process.exit(1);
  }
  if (gate.degraded) {
    console.log("Running WITHOUT a model: oracles degrade to the terminal-and-truthful boundary.");
  }

  const session = await fetch(new URL("/auth/dev/session", BASE_URL), {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }).then((r) => r.json());
  if (!session.accessToken) {
    console.error("Development session unavailable — the stack must run with RALLY_DEV_AUTH=true (the default local configuration).");
    process.exit(1);
  }
  const token = session.accessToken;

  const api = async (method, path, body) => {
    const response = await fetch(new URL(path, BASE_URL), {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const uid = () => crypto.randomUUID();
  const substreamCommand = async (workstreamId, command) => {
    const ticket = await api("GET", `/workstreams/${workstreamId}/substreams/0/socket`);
    if (ticket.status !== 200) return ticket;
    const socket = await openSubstreamSocket(socketUrlWithoutTicket(ticket.body.url), {
      expectOpen: true,
      protocols: socketTicketProtocols(ticket.body.ticket),
      command,
      subscriptionBootstrap: ticket.body.subscriptionBootstrap ?? false,
      // This is the same end-to-end operation budget used by waitForTerminal;
      // command admission should fail the scenario before model settlement does.
      timeoutMs: 120_000,
    });
    const result = socket.commandResult;
    if (result?.type === "client_command_failed") {
      return { status: result.error.status, body: { error: result.error } };
    }
    if (result?.type !== "client_command_succeeded") {
      throw new Error("substream command closed without a correlated receipt");
    }
    return { status: 200, body: result };
  };
  const canonicalTurns = (body) => {
    const transcript = body?.transcript;
    if (!transcript) return [];
    const byId = new Map();
    for (const turn of [...(transcript.ranges ?? []).flatMap((range) => range.turns ?? []),
      ...(transcript.activeTurns ?? [])]) {
      const current = byId.get(turn.turnId);
      if (!current || turn.revision > current.revision) byId.set(turn.turnId, turn);
    }
    return [...byId.values()].sort((left, right) =>
      left.transcriptSequence - right.transcriptSequence || left.turnId.localeCompare(right.turnId));
  };
  const turnText = (turn) => (turn?.blocks ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const waitForTerminal = async (workstreamId, timeoutMs = 120_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const workstream = await api("GET", `/workstreams/${workstreamId}`);
      const turns = canonicalTurns(workstream.body);
      const agent = turns.filter((turn) => turn.actor === "assistant" && turn.entryKind === "conversation");
      const status = workstream.body?.harnessStatus;
      if (TERMINAL_STATES.includes(status)) {
        return { status, agentText: turnText(agent.at(-1)) || null };
      }
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
    return { status: "timeout", agentText: null };
  };

  const create = async (openingMessage, clientMessageId = uid()) => {
    const created = await api("POST", "/workstreams", { openingMessage, clientMessageId });
    if (created.status !== 201 && created.status !== 200) {
      throw new Error(`create ${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`);
    }
    return created.body.workstream.id;
  };
  const message = (
    workstreamId,
    text,
    clientMessageId = uid(),
    mentions = [],
  ) => substreamCommand(workstreamId, {
    type: "create_message",
    operationId: uid(),
    payload: {
      text, clientMessageId, mentions, confirmedParticipantUserIds: [], attachmentIds: [],
    },
  });
  const expectRunOutcome = (terminal) => {
    const verdict = runOutcomeOracle(modelConfigured, terminal);
    if (!verdict.ok) throw new Error(verdict.reason);
    return verdict;
  };

  const scenarios = {
    async happy_create_and_reply(index) {
      const prompts = [
        "Reply with exactly the word PONG and nothing else.",
        "What is 7 * 6? Reply with just the number.",
        "Reply with the single word DONE.",
      ];
      const workstreamId = await create(prompts[index % prompts.length]);
      return { workstreamId, ...expectRunOutcome(await waitForTerminal(workstreamId)) };
    },
    async happy_follow_up() {
      const workstreamId = await create("Reply with the word FIRST.");
      await waitForTerminal(workstreamId);
      const followUp = await message(workstreamId, "Now reply with exactly the word SECOND.");
      if (followUp.status !== 200 && followUp.status !== 201) {
        throw new Error(`follow-up ${followUp.status}`);
      }
      return { workstreamId, ...expectRunOutcome(await waitForTerminal(workstreamId)) };
    },
    async happy_stop_midrun() {
      const workstreamId = await create(
        "Count from 1 to 500 slowly, one number per line, with commentary on each.",
      );
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const stop = await substreamCommand(workstreamId, {
        type: "stop_harness",
        operationId: uid(),
      });
      if (![200, 202, 204, 409].includes(stop.status)) throw new Error(`stop ${stop.status}`);
      const terminal = await waitForTerminal(workstreamId);
      if (terminal.status === "timeout") throw new Error("never settled after stop");
      return { workstreamId, terminal: terminal.status };
    },
    async happy_transcript_ordered() {
      const workstreamId = await create("Reply with the word ORDERED.");
      await waitForTerminal(workstreamId);
      const listed = await api("GET", `/workstreams/${workstreamId}`);
      const items = canonicalTurns(listed.body);
      if (listed.status !== 200 || items.length < 1) throw new Error(`transcript ${listed.status}`);
      const sequences = items.map((turn) => turn.transcriptSequence);
      if (JSON.stringify([...sequences].sort((a, b) => a - b)) !== JSON.stringify(sequences)) {
        throw new Error("transcript out of order");
      }
      return { workstreamId, messages: items.length };
    },
    async happy_title_settles() {
      // Every post-cutover work stream once kept its provisional title in
      // `naming` forever: the object creation path never scheduled the first
      // naming pass. The sidebar skeleton was the member-visible symptom.
      const workstreamId = await create("Plan a small dinner party for six people.");
      const start = Date.now();
      let titleStatus = "naming";
      while (Date.now() - start < 60_000) {
        const workstream = await api("GET", `/workstreams/${workstreamId}`);
        titleStatus = workstream.body?.workstream?.titleStatus ?? "?";
        if (titleStatus !== "naming") break;
        await new Promise((resolve) => setTimeout(resolve, 2_500));
      }
      if (titleStatus === "naming") throw new Error("title never left naming");
      return { workstreamId, titleStatus };
    },

    async sad_unauthorized() {
      const response = await fetch(new URL("/workstreams", BASE_URL), {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`);
    },
    async sad_invalid_body() {
      const response = await api("POST", "/workstreams", { nonsense: true });
      if (response.status !== 400) throw new Error(`expected 400, got ${response.status}`);
    },
    async sad_oversize_message() {
      const response = await api("POST", "/workstreams", {
        openingMessage: "x".repeat(OVERSIZE_MESSAGE_CHARACTERS), clientMessageId: uid(),
      });
      if (response.status !== 400) throw new Error(`expected 400, got ${response.status}`);
      // The code, not just the status: a message one character over the ceiling
      // and a body the schema cannot read are both 400, and only one of them is
      // what this scenario exists to exercise. Asserting the status alone is how
      // this case could pass while testing nothing.
      if (response.body?.error?.code !== "message_too_long") {
        throw new Error(`expected message_too_long, got ${response.body?.error?.code}`);
      }
    },
    async sad_missing_workstream() {
      const response = await api("GET", `/workstreams/${uid()}`);
      if (![403, 404].includes(response.status)) throw new Error(`expected 403/404, got ${response.status}`);
    },
    async sad_message_to_missing_workstream() {
      const response = await message(uid(), "hello?");
      if (![403, 404].includes(response.status)) throw new Error(`expected 403/404, got ${response.status}`);
    },
    async sad_duplicate_client_message_id() {
      const workstreamId = await create("Reply with the word ONCE.");
      await waitForTerminal(workstreamId);
      const clientMessageId = uid();
      const first = await message(workstreamId, "exactly once", clientMessageId);
      const replay = await message(workstreamId, "exactly once", clientMessageId);
      if (replay.status >= 500) throw new Error(`replay returned ${replay.status}`);
      if (first.body?.turn?.turnId !== replay.body?.turn?.turnId) {
        throw new Error("replay returned a different accepted turn");
      }
      for (const [label, response] of [["first", first], ["replay", replay]]) {
        const keys = Object.keys(response.body ?? {}).sort().join(",");
        if (keys !== "clientMessageId,command,deliveryState,operationId,turn,type") {
          throw new Error(`${label} receipt exposed unexpected fields: ${keys}`);
        }
        if (response.body.command !== "create_message" || response.body.type !== "client_command_succeeded") {
          throw new Error(`${label} receipt did not identify the accepted socket command`);
        }
        if (!["canonical", "pending"].includes(response.body.deliveryState)) {
          throw new Error(`${label} receipt has invalid delivery state`);
        }
      }
      const listed = await api("GET", `/workstreams/${workstreamId}`);
      const copies = canonicalTurns(listed.body).filter((turn) => turn.clientMessageId === clientMessageId);
      if (copies.length > 1) throw new Error(`replay landed ${copies.length} times`);
      return { first: first.status, replay: replay.status };
    },
    async sad_mentions_unknown_user() {
      const workstreamId = await create("Reply with the word HI.");
      await waitForTerminal(workstreamId);
      const response = await message(workstreamId, "hey @ghost", uid(), [
        { type: "person", userId: uid(), startOffset: 4, endOffset: 10 },
      ]);
      if (![400, 409, 422].includes(response.status)) {
        throw new Error(`expected a safe rejection, got ${response.status}`);
      }
    },
    async sad_bad_token() {
      const response = await fetch(new URL("/workstreams", BASE_URL), {
        method: "POST",
        headers: { authorization: "Bearer not-a-token", "content-type": "application/json" },
        body: JSON.stringify({ openingMessage: "x", clientMessageId: uid() }),
      });
      if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`);
    },

    async chaos_concurrent_messages() {
      const workstreamId = await create("Reply with the word READY.");
      await waitForTerminal(workstreamId);
      const burst = await Promise.all(Array.from({ length: 6 }, (_, k) =>
        message(workstreamId, `burst ${k}: reply with the word OK.`)));
      const serverErrors = burst.filter((b) => b.status >= 500);
      if (serverErrors.length > 0) {
        throw new Error(`${serverErrors.length}/6 burst writes returned 5xx`);
      }
      const terminal = await waitForTerminal(workstreamId, 150_000);
      if (terminal.status === "timeout") throw new Error("burst never settled");
      return { workstreamId, terminal: terminal.status };
    },
    async chaos_concurrent_creates() {
      const creates = await Promise.all(Array.from({ length: 6 }, () =>
        api("POST", "/workstreams", {
          openingMessage: "Reply with the word MADE.", clientMessageId: uid(),
        })));
      const serverErrors = creates.filter((c) => c.status >= 500);
      if (serverErrors.length > 0) throw new Error(`${serverErrors.length}/6 creates returned 5xx`);
      const settled = await Promise.all(creates.map((c) =>
        waitForTerminal(c.body.workstream.id, 150_000)));
      const hung = settled.filter((s) => s.status === "timeout").length;
      if (hung > 0) throw new Error(`${hung}/6 concurrent runs never settled`);
      return { settled: settled.length };
    },
  };

  const lanes = {
    happy: ["happy_create_and_reply", "happy_follow_up", "happy_stop_midrun",
      "happy_transcript_ordered", "happy_title_settles"],
    sad: ["sad_unauthorized", "sad_bad_token", "sad_invalid_body", "sad_oversize_message",
      "sad_missing_workstream", "sad_message_to_missing_workstream",
      "sad_duplicate_client_message_id", "sad_mentions_unknown_user"],
    chaos: ["chaos_concurrent_messages", "chaos_concurrent_creates"],
  };
  const plan = buildPlan(counts, lanes);
  const results = [];
  let cursor = 0;
  const startedAt = Date.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < plan.length) {
      const mine = cursor;
      cursor += 1;
      const [kind, index] = plan[mine];
      const scenarioStart = Date.now();
      try {
        const detail = await scenarios[kind](index);
        results.push({ kind, ok: true, ms: Date.now() - scenarioStart, detail });
        process.stdout.write(`✓ ${kind} (${Date.now() - scenarioStart}ms)\n`);
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error).slice(0, 300);
        results.push({ kind, ok: false, ms: Date.now() - scenarioStart, error: reason });
        process.stdout.write(`✗ ${kind}: ${reason.slice(0, 160)}\n`);
      }
    }
  }));

  const failures = results.filter((r) => !r.ok);
  const byKind = {};
  for (const result of results) {
    byKind[result.kind] ??= { ok: 0, fail: 0, ms: [] };
    byKind[result.kind][result.ok ? "ok" : "fail"] += 1;
    byKind[result.kind].ms.push(result.ms);
  }
  console.log("\n=== e2e summary ===");
  console.table(Object.entries(byKind).map(([kind, s]) => ({
    kind, ok: s.ok, fail: s.fail,
    p50: s.ms.sort((a, b) => a - b)[Math.floor(s.ms.length / 2)],
    max: Math.max(...s.ms),
  })));
  console.log(`total=${results.length} ok=${results.length - failures.length} fail=${failures.length} wall=${Math.round((Date.now() - startedAt) / 1000)}s model=${modelConfigured ? "live" : "absent"}`);
  if (REPORT_PATH) writeFileSync(REPORT_PATH, JSON.stringify({ results, failures }, null, 1));
  for (const failure of failures.slice(0, 20)) console.log(` - ${failure.kind}: ${failure.error}`);
  process.exit(failures.length > 0 ? 1 : 0);
}
