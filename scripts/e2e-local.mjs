#!/usr/bin/env node
// End-to-end behavior of the running local stack, through the same public API
// the desktop client uses: each scenario makes a Canvas (`POST /canvases` with
// an id it minted), talks to Rally in the Canvas's Chat, and reads the Chat
// back. Happy paths must produce an agent reply, sad paths must be refused
// safely, and chaos paths must not corrupt or wedge anything. This lane exists
// because it catches what the unit and workerd suites structurally cannot: its
// first sustained run found a view trigger that crashed every retried run's
// settlement, a creation path that never scheduled naming, and a
// compound-SELECT limit under load.
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
 * *valid* message — the assertion would fail, and the lane would launch a
 * model-backed run on every pass. Nothing compares the two numbers (a test that
 * read them out of their sources would be asserting on source text), so the
 * scenario's `message_too_long` assertion is what fails when the ceiling moves
 * past this one; move this number with it.
 */
const OVERSIZE_MESSAGE_CHARACTERS = 100_001;

/** Member-visible states that mean the conversation is no longer working. */
/**
 * An RFC 9562 UUIDv7, the API's `uuidV7` (`apps/api/src/lib/uuid-v7.ts`)
 * for a script that cannot import TypeScript. The lane's ids are v7 because
 * a command's `operationId` reaches run-outcome and product-usage telemetry,
 * whose contract requires `UuidV7Schema`; a v4 failed that telemetry on every
 * lane run, so the lane never exercised it.
 */
export function uuidV7(now = Date.now()) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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

/**
 * Whether the artifact scenario can expect a publish, given the Worker's
 * provider state and its Terminal availability (`GET /workspace/terminal`).
 * Publishing goes through the Terminal sandbox, which a local stack without
 * Daytona configured does not have, so its absence is a stated skip rather than
 * a failure or a silent pass.
 */
export function artifactGateDecision(modelConfigured, terminalAvailability) {
  if (!modelConfigured) return { run: false, reason: "no model is configured, so nothing can publish" };
  if (terminalAvailability !== "supported") {
    return { run: false, reason: `the Terminal is ${terminalAvailability ?? "unknown"} on this Worker, so nothing can publish` };
  }
  return { run: true };
}

/** A publish landed when the Canvas lists an artifact at a version. */
export function artifactOutcomeOracle(canvas) {
  const artifacts = canvas?.artifacts ?? [];
  if (artifacts.length === 0) return { ok: false, reason: "the run finished and the Canvas holds no artifact" };
  if (!artifacts.every((artifact) => artifact.version >= 1)) return { ok: false, reason: "an artifact has no version" };
  return { ok: true };
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
  const terminal = await fetch(new URL("/workspace/terminal", BASE_URL), {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json()).catch(() => null);
  const artifactGate = artifactGateDecision(modelConfigured, terminal?.availability);
  if (!artifactGate.run) console.log(`Artifact scenario skipped: ${artifactGate.reason}.`);

  // Set by any request the Worker answered with a 5xx or did not answer at
  // all; the scenario loop then asks /health once whether the Worker is alive.
  let serverFailureSeen = false;
  const api = async (method, path, body) => {
    let response;
    try {
      response = await fetch(new URL(path, BASE_URL), {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      serverFailureSeen = true;
      throw error;
    }
    if (response.status >= 500) serverFailureSeen = true;
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const uid = () => uuidV7();
  const substreamCommand = async (canvasId, command) => {
    const ticket = await api("GET", `/conversations/${canvasId}/substreams/0/socket`);
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

  const waitForTerminal = async (canvasId, timeoutMs = 120_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const chat = await api("GET", `/conversations/${canvasId}`);
      const turns = canonicalTurns(chat.body);
      const agent = turns.filter((turn) => turn.actor === "assistant" && turn.entryKind === "conversation");
      const status = chat.body?.harnessStatus;
      if (TERMINAL_STATES.includes(status)) {
        return { status, agentText: turnText(agent.at(-1)) || null };
      }
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
    return { status: "timeout", agentText: null };
  };

  // A Canvas whose id this lane minted, then its opening message in the Chat
  // through the REST admission route a command client uses.
  const createCanvas = async (canvasId = uid()) => {
    const created = await api("POST", "/canvases", { canvasId });
    if (created.status !== 201) {
      throw new Error(`create ${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`);
    }
    if (created.body?.canvasId !== canvasId) throw new Error("create answered a different Canvas");
    return canvasId;
  };
  const post = (canvasId, text, clientMessageId = uid()) =>
    api("POST", `/conversations/${canvasId}/substreams/0/messages`, { text, clientMessageId });
  const create = async (openingMessage) => {
    const canvasId = await createCanvas();
    const sent = await post(canvasId, openingMessage);
    if (sent.status !== 201) throw new Error(`opening message ${sent.status}: ${JSON.stringify(sent.body).slice(0, 200)}`);
    return canvasId;
  };
  const message = (
    canvasId,
    text,
    clientMessageId = uid(),
    mentions = [],
  ) => substreamCommand(canvasId, {
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
      const canvasId = await create(prompts[index % prompts.length]);
      return { canvasId, ...expectRunOutcome(await waitForTerminal(canvasId)) };
    },
    async happy_follow_up() {
      const canvasId = await create("Reply with the word FIRST.");
      await waitForTerminal(canvasId);
      const followUp = await message(canvasId, "Now reply with exactly the word SECOND.");
      if (followUp.status !== 200 && followUp.status !== 201) {
        throw new Error(`follow-up ${followUp.status}`);
      }
      return { canvasId, ...expectRunOutcome(await waitForTerminal(canvasId)) };
    },
    async happy_stop_midrun() {
      const canvasId = await create(
        "Count from 1 to 500 slowly, one number per line, with commentary on each.",
      );
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const stop = await substreamCommand(canvasId, {
        type: "stop_harness",
        operationId: uid(),
      });
      if (![200, 202, 204, 409].includes(stop.status)) throw new Error(`stop ${stop.status}`);
      const terminal = await waitForTerminal(canvasId);
      if (terminal.status === "timeout") throw new Error("never settled after stop");
      return { canvasId, terminal: terminal.status };
    },
    async happy_transcript_ordered() {
      const canvasId = await create("Reply with the word ORDERED.");
      await waitForTerminal(canvasId);
      const listed = await api("GET", `/conversations/${canvasId}`);
      const items = canonicalTurns(listed.body);
      if (listed.status !== 200 || items.length < 1) throw new Error(`transcript ${listed.status}`);
      const sequences = items.map((turn) => turn.transcriptSequence);
      if (JSON.stringify([...sequences].sort((a, b) => a - b)) !== JSON.stringify(sequences)) {
        throw new Error("transcript out of order");
      }
      return { canvasId, messages: items.length };
    },
    async happy_artifact_publishes() {
      if (!artifactGate.run) return { skipped: artifactGate.reason };
      const canvasId = await create(
        "Publish a short Markdown document titled E2E note that says hello, then reply with the word PUBLISHED.",
      );
      expectRunOutcome(await waitForTerminal(canvasId, 240_000));
      const canvas = await api("GET", `/canvases/${canvasId}`);
      if (canvas.status !== 200) throw new Error(`canvas ${canvas.status}`);
      const verdict = artifactOutcomeOracle(canvas.body);
      if (!verdict.ok) throw new Error(verdict.reason);
      return { canvasId, artifacts: canvas.body.artifacts.length };
    },

    async sad_unauthorized() {
      const response = await fetch(new URL("/canvases", BASE_URL), {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`);
    },
    async sad_invalid_body() {
      const response = await api("POST", "/canvases", { nonsense: true });
      if (response.status !== 400) throw new Error(`expected 400, got ${response.status}`);
    },
    async sad_oversize_message() {
      const response = await post(uid(), "x".repeat(OVERSIZE_MESSAGE_CHARACTERS));
      if (response.status !== 400) throw new Error(`expected 400, got ${response.status}`);
      // The code, not just the status: a message one character over the ceiling
      // and a body the schema cannot read are both 400, and only one of them is
      // what this scenario exists to exercise. Asserting the status alone is how
      // this case could pass while testing nothing.
      if (response.body?.error?.code !== "message_too_long") {
        throw new Error(`expected message_too_long, got ${response.body?.error?.code}`);
      }
    },
    async sad_missing_canvas() {
      const response = await api("GET", `/conversations/${uid()}`);
      if (![403, 404].includes(response.status)) throw new Error(`expected 403/404, got ${response.status}`);
    },
    async sad_message_to_missing_canvas() {
      const response = await message(uid(), "hello?");
      if (![403, 404].includes(response.status)) throw new Error(`expected 403/404, got ${response.status}`);
    },
    async sad_duplicate_client_message_id() {
      const canvasId = await create("Reply with the word ONCE.");
      await waitForTerminal(canvasId);
      const clientMessageId = uid();
      const first = await message(canvasId, "exactly once", clientMessageId);
      const replay = await message(canvasId, "exactly once", clientMessageId);
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
      const listed = await api("GET", `/conversations/${canvasId}`);
      const copies = canonicalTurns(listed.body).filter((turn) => turn.clientMessageId === clientMessageId);
      if (copies.length > 1) throw new Error(`replay landed ${copies.length} times`);
      return { first: first.status, replay: replay.status };
    },
    async sad_mentions_unknown_user() {
      const canvasId = await create("Reply with the word HI.");
      await waitForTerminal(canvasId);
      const response = await message(canvasId, "hey @ghost", uid(), [
        { type: "person", userId: uid(), startOffset: 4, endOffset: 10 },
      ]);
      if (![400, 409, 422].includes(response.status)) {
        throw new Error(`expected a safe rejection, got ${response.status}`);
      }
    },
    async sad_bad_token() {
      const response = await fetch(new URL("/canvases", BASE_URL), {
        method: "POST",
        headers: { authorization: "Bearer not-a-token", "content-type": "application/json" },
        body: JSON.stringify({ canvasId: uid() }),
      });
      if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`);
    },

    async chaos_concurrent_messages() {
      const canvasId = await create("Reply with the word READY.");
      await waitForTerminal(canvasId);
      const burst = await Promise.all(Array.from({ length: 6 }, (_, k) =>
        message(canvasId, `burst ${k}: reply with the word OK.`)));
      const serverErrors = burst.filter((b) => b.status >= 500);
      if (serverErrors.length > 0) {
        throw new Error(`${serverErrors.length}/6 burst writes returned 5xx`);
      }
      const terminal = await waitForTerminal(canvasId, 150_000);
      if (terminal.status === "timeout") throw new Error("burst never settled");
      return { canvasId, terminal: terminal.status };
    },
    async chaos_concurrent_creates() {
      // Six creates at once, each beside its own retry naming the same id at
      // the same moment: a retry must answer the Canvas its first made.
      const ids = Array.from({ length: 6 }, () => uid());
      const creates = await Promise.all(ids.flatMap((canvasId) => [
        api("POST", "/canvases", { canvasId }), api("POST", "/canvases", { canvasId }),
      ]));
      const serverErrors = creates.filter((c) => c.status >= 500);
      if (serverErrors.length > 0) throw new Error(`${serverErrors.length}/12 creates returned 5xx`);
      const answered = creates.map((c) => c.body?.canvasId);
      if (ids.some((canvasId, k) => answered[2 * k] !== canvasId || answered[2 * k + 1] !== canvasId)) {
        throw new Error("a create or its retry answered a different Canvas");
      }
      const sent = await Promise.all(ids.map((canvasId) => post(canvasId, "Reply with the word MADE.")));
      if (sent.some((reply) => reply.status !== 201)) {
        throw new Error(`opening messages ${sent.map((reply) => reply.status).join(",")}`);
      }
      const settled = await Promise.all(ids.map((canvasId) => waitForTerminal(canvasId, 150_000)));
      const hung = settled.filter((outcome) => outcome.status === "timeout").length;
      if (hung > 0) throw new Error(`${hung}/6 concurrent runs never settled`);
      return { settled: settled.length };
    },
  };

  const lanes = {
    happy: ["happy_create_and_reply", "happy_follow_up", "happy_stop_midrun",
      "happy_transcript_ordered", "happy_artifact_publishes"],
    sad: ["sad_unauthorized", "sad_bad_token", "sad_invalid_body", "sad_oversize_message",
      "sad_missing_canvas", "sad_message_to_missing_canvas",
      "sad_duplicate_client_message_id", "sad_mentions_unknown_user"],
    chaos: ["chaos_concurrent_messages", "chaos_concurrent_creates"],
  };
  const plan = buildPlan(counts, lanes);
  const results = [];
  let cursor = 0;
  const startedAt = Date.now();
  // A Worker that died turns every later scenario into "fetch failed", which
  // hides the one that killed it. One /health probe after a 5xx or a refused
  // connection decides; a dead Worker ends the run with that as the verdict.
  let workerDiedDuring = null;
  const workerAlive = () => fetch(new URL("/health", BASE_URL)).then((r) => r.ok).catch(() => false);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < plan.length && workerDiedDuring === null) {
      const mine = cursor;
      cursor += 1;
      const [kind, index] = plan[mine];
      const scenarioStart = Date.now();
      try {
        const detail = await scenarios[kind](index);
        results.push({ kind, ok: true, ms: Date.now() - scenarioStart, detail });
        process.stdout.write(detail?.skipped
          ? `- ${kind} skipped: ${detail.skipped}\n`
          : `✓ ${kind} (${Date.now() - scenarioStart}ms)\n`);
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error).slice(0, 300);
        results.push({ kind, ok: false, ms: Date.now() - scenarioStart, error: reason });
        process.stdout.write(`✗ ${kind}: ${reason.slice(0, 160)}\n`);
        if (/fetch failed|Realtime/u.test(reason)) serverFailureSeen = true;
      }
      if (serverFailureSeen && workerDiedDuring === null) {
        serverFailureSeen = false;
        if (!(await workerAlive())) workerDiedDuring = kind;
      }
    }
  }));
  if (workerDiedDuring !== null) {
    console.log(`\nThe Worker died during ${workerDiedDuring}; ${plan.length - cursor} scenarios were not run. `
      + "Read the Worker's own log for why; the results below stop there.");
  }

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
  console.log(`total=${results.length} ok=${results.length - failures.length} fail=${failures.length} wall=${Math.round((Date.now() - startedAt) / 1000)}s model=${modelConfigured ? "live" : "absent"} artifacts=${artifactGate.run ? "checked" : `skipped (${artifactGate.reason})`}`);
  if (REPORT_PATH) writeFileSync(REPORT_PATH, JSON.stringify({ results, failures }, null, 1));
  for (const failure of failures.slice(0, 20)) console.log(` - ${failure.kind}: ${failure.error}`);
  if (workerDiedDuring !== null) console.log(`verdict: the Worker died during ${workerDiedDuring}`);
  process.exit(failures.length > 0 || workerDiedDuring !== null ? 1 : 0);
}
