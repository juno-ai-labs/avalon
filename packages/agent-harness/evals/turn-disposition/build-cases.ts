import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TurnDispositionCaseSchema, type TurnDispositionCase } from "../../src/turn-disposition-evaluation";
import type { TurnDispositionState } from "../../src/turn-disposition";
import { assertProtectedEvaluationPaths, writePrivateFile } from "../addressing/secure-paths";

/**
 * Turn the raw conversation exports into evaluation cases: one case per
 * message a person or Rally wrote, in every Thread and Breakout exported.
 *
 * Input, all in the protected scratch directory:
 * - `extract-*.jsonl` and `thread-*.jsonl`: one line per conversation, carrying
 *   the rows `export.sql` returned (`meta`, `turn`, `run`, `checkpoint`). A line
 *   whose substream is `"0"` is a Thread; any other is a Breakout.
 * - `inventory-*.json`: one per workspace, the WorkspaceDO tables that frame a
 *   conversation: its Thread's title and description for a Breakout, its
 *   Channels for a Thread, the Breakouts started under a Thread, and the
 *   Channel messages a Thread's merges produced.
 *
 * Output: cases whose `state` is what the design sends the classifier (parent,
 * charter, where the work stands, the recent exchange, the judged message) and
 * whose `production` records what people did next. `expected` starts null;
 * labels are joined by the runner from a separate file.
 */
interface ExportLine {
  workspaceId: string;
  workstreamId: string;
  substreamId: string;
  kind?: "thread" | "breakout";
  archived: number;
  exactState: string;
  systemKind?: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
}

interface Inventory {
  workspaceId: string;
  name: string;
  inventory: {
    channels: { workstream_id: string; title: string; description: string; system_kind: string | null; origin_type: string | null; archived_at: number | null; exact_state: string }[];
    spaces: { space_id: string; title: string; system_role: string | null }[];
    space_channel_memberships: { space_id: string; workstream_id: string; state: string }[];
    space_messages: { space_id: string; posted_at: number; source_workstream_id: string | null; merge_operation_id: string | null }[];
    breakouts: { workstream_id: string; substream_id: string; title: string; description: string; source_created_at: number; created_by_user_id: string | null }[];
  };
}

interface Turn {
  seq: number;
  turnId: string;
  author: string;
  messageType: string;
  body: string;
  structuredType: string;
  runId: string;
  createdAt: number;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/** The discriminator of a bounded `structured_content_json` export, or the empty string when there is none or it is cut mid-way. */
function structuredType(json: string): string {
  if (json.length === 0) return "";
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string" ? (parsed as { type: string }).type : "";
  } catch {
    const match = /"type"\s*:\s*"([^"]+)"/.exec(json);
    return match?.[1] ?? "";
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

const RESOURCE_REFERENCE = /!?\[([^\]]*)\]\(resource:\/\/([0-9a-zA-Z-]{8,})\)/g;

function outputsIn(body: string): { id: string; title: string }[] {
  const seen = new Map<string, string>();
  for (const match of body.matchAll(RESOURCE_REFERENCE)) {
    const id = match[2]!;
    if (!seen.has(id)) seen.set(id, match[1]!.trim() || "untitled");
  }
  return [...seen.entries()].map(([id, title]) => ({ id, title }));
}

function authorOf(turn: Turn): "person" | "rally" {
  return turn.author === "agent" ? "rally" : "person";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const directory = option(argv, "--extract");
  const output = option(argv, "--output");
  if (!directory || !output) throw new Error("--extract <dir> and --output <file> are required");
  const names = await readdir(directory);
  const exportFiles = names.filter((name) => /^(extract|thread)-.*\.jsonl$/.test(name)).sort();
  const inventoryFiles = names.filter((name) => /^inventory-.*\.json$/.test(name)).sort();
  if (exportFiles.length === 0) throw new Error("no extract-*.jsonl or thread-*.jsonl files found");
  const inputs = [...exportFiles, ...inventoryFiles].map((name) => resolve(directory, name));
  await assertProtectedEvaluationPaths(inputs, [resolve(output)]);

  const inventories = new Map<string, Inventory>();
  for (const name of inventoryFiles) {
    const parsed = JSON.parse(await readFile(resolve(directory, name), "utf8")) as Inventory;
    inventories.set(parsed.workspaceId, parsed);
  }

  const cases: TurnDispositionCase[] = [];
  const stats = {
    conversations: 0, threads: 0, breakouts: 0, skippedDuplicates: 0, parseFailures: 0,
    cases: 0, personCases: 0, rallyCases: 0, withSummary: 0, withOutputs: 0, withRevisedOutputs: 0,
    mergedLater: 0, breakoutStartedBeforeNext: 0, finalTurns: 0, missingParent: 0, emptyPurpose: 0,
  };
  const seenConversations = new Set<string>();
  for (const name of exportFiles) {
    const source = await readFile(resolve(directory, name), "utf8");
    for (const line of source.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: ExportLine;
      try {
        parsed = JSON.parse(line) as ExportLine;
      } catch {
        stats.parseFailures += 1;
        continue;
      }
      const conversationKey = `${parsed.workstreamId}/${parsed.substreamId}`;
      if (seenConversations.has(conversationKey)) {
        stats.skippedDuplicates += 1;
        continue;
      }
      seenConversations.add(conversationKey);
      const conversationKind: "thread" | "breakout" = parsed.kind ?? (parsed.substreamId === "0" ? "thread" : "breakout");
      stats.conversations += 1;
      if (conversationKind === "thread") stats.threads += 1; else stats.breakouts += 1;

      const inventory = inventories.get(parsed.workspaceId)?.inventory;
      const rows = parsed.rows;
      const meta = rows.find((row) => row.k === "meta");
      const title = text(meta?.mt).trim();
      const description = text(meta?.body).trim();
      const purpose = description || title;
      const originType = text(meta?.run) || null;
      const turns: Turn[] = rows.filter((row) => row.k === "turn")
        .map((row) => ({
          seq: Number(row.seq),
          turnId: text(row.tid),
          author: text(row.at),
          messageType: text(row.mt),
          body: text(row.body),
          structuredType: structuredType(text(row.sc)),
          runId: text(row.run),
          createdAt: Number(row.ts),
        }))
        .sort((left, right) => left.seq - right.seq);
      const completedFinalTurns = new Set<string>();
      for (const row of rows) {
        if (row.k === "run" && text(row.at) === "completed" && text(row.run)) completedFinalTurns.add(text(row.run));
      }
      const checkpoints = rows.filter((row) => row.k === "checkpoint")
        .map((row) => ({ throughSeq: Number(row.seq), summary: text(row.body) }))
        .filter((checkpoint) => checkpoint.summary.trim().length > 0)
        .sort((left, right) => left.throughSeq - right.throughSeq);

      // Who the parent is, and what production did afterwards.
      const thread = inventory?.channels.find((channel) => channel.workstream_id === parsed.workstreamId);
      let parent: TurnDispositionState["parent"];
      if (conversationKind === "breakout") {
        if (!thread) stats.missingParent += 1;
        parent = {
          kind: "thread",
          title: thread?.title ?? "",
          ...(thread?.description ? { purpose: thread.description } : {}),
        };
      } else {
        const spaceIds = new Set((inventory?.space_channel_memberships ?? [])
          .filter((membership) => membership.workstream_id === parsed.workstreamId && membership.state === "active")
          .map((membership) => membership.space_id));
        const channelTitles = (inventory?.spaces ?? [])
          .filter((space) => spaceIds.has(space.space_id))
          .map((space) => space.system_role === "general" ? "General" : space.title);
        if (channelTitles.length === 0) stats.missingParent += 1;
        parent = { kind: "channel", title: channelTitles.length > 0 ? channelTitles.join(", ") : "General" };
      }
      const mergeTimes: number[] = conversationKind === "breakout"
        ? turns.filter((turn) => turn.structuredType === "conversation_merged_into").map((turn) => turn.createdAt)
        : (inventory?.space_messages ?? [])
            .filter((message) => message.source_workstream_id === parsed.workstreamId)
            .map((message) => message.posted_at);
      const breakoutTimes: number[] = conversationKind === "thread"
        ? (inventory?.breakouts ?? [])
            .filter((breakout) => breakout.workstream_id === parsed.workstreamId)
            .map((breakout) => breakout.source_created_at)
        : [];

      const judged = turns.filter((turn) =>
        (turn.author === "member" || turn.author === "agent" || turn.author === "external")
        && turn.messageType === "text"
        && turn.body.trim().length > 0);
      if (judged.length === 0) continue;
      const openingRequest = judged.find((turn) => turn.author !== "agent")?.body;
      const outputFirstSeen = new Map<string, number>();
      const outputHistory: { id: string; title: string; index: number }[] = [];

      judged.forEach((turn, index) => {
        const nextCreatedAt = judged[index + 1]?.createdAt ?? Number.POSITIVE_INFINITY;
        const recent = judged.slice(Math.max(0, index - 6), index).map((candidate) => ({
          author: authorOf(candidate),
          text: candidate.body,
        }));
        const summary = [...checkpoints].reverse().find((checkpoint) => checkpoint.throughSeq < turn.seq)?.summary;
        const earlierOutputs = outputHistory.slice(-8).map((entry) => ({ title: entry.title, messages_ago: index - entry.index }));
        const outputs = outputsIn(turn.body).map((output) => ({
          title: output.title,
          first_time_here: !outputFirstSeen.has(output.id),
        }));
        const carriedUpBefore = mergeTimes.filter((time) => time < turn.createdAt).length;
        const mergedLater = mergeTimes.some((time) => time > turn.createdAt);
        const mergedBeforeNext = mergeTimes.some((time) => time > turn.createdAt && time < nextCreatedAt);
        const breakoutStartedBeforeNext = breakoutTimes.some((time) => time > turn.createdAt && time < nextCreatedAt);
        const evaluationCase: TurnDispositionCase = {
          id: conversationKind === "breakout" ? `${parsed.substreamId}:${turn.seq}` : `${parsed.workstreamId}:0:${turn.seq}`,
          workspaceId: parsed.workspaceId,
          workstreamId: parsed.workstreamId,
          substreamId: parsed.substreamId,
          turnId: turn.turnId,
          runId: turn.author === "agent" && turn.runId ? turn.runId : null,
          createdAt: Number.isFinite(turn.createdAt) ? turn.createdAt : 0,
          state: {
            parent,
            conversation: {
              kind: conversationKind,
              title,
              purpose,
              ...(openingRequest !== undefined ? { opening_request: openingRequest } : {}),
              messages_before: index,
            },
            so_far: {
              ...(summary !== undefined ? { summary } : {}),
              earlier_outputs: earlierOutputs,
              carried_up_before: carriedUpBefore,
            },
            recent_messages: recent,
            judged_message: { author: authorOf(turn), text: turn.body, outputs },
          },
          production: {
            authorType: turn.author as "member" | "agent" | "external",
            conversationKind,
            systemKind: parsed.systemKind ?? thread?.system_kind ?? null,
            originType,
            ordinal: index + 1,
            count: judged.length,
            lastMessage: index === judged.length - 1,
            finalTurnOfCompletedRun: turn.author === "agent" && completedFinalTurns.has(turn.turnId),
            breakoutStartedBeforeNext,
            mergedBeforeNext,
            mergedLater,
            conversationState: parsed.exactState,
            archived: parsed.archived === 1,
          },
          expected: null,
        };
        TurnDispositionCaseSchema.parse(evaluationCase);
        cases.push(evaluationCase);
        stats.cases += 1;
        if (evaluationCase.state.judged_message.author === "person") stats.personCases += 1; else stats.rallyCases += 1;
        if (summary !== undefined) stats.withSummary += 1;
        if (outputs.length > 0) stats.withOutputs += 1;
        if (outputs.some((output) => !output.first_time_here)) stats.withRevisedOutputs += 1;
        if (mergedLater) stats.mergedLater += 1;
        if (breakoutStartedBeforeNext) stats.breakoutStartedBeforeNext += 1;
        if (evaluationCase.production.finalTurnOfCompletedRun) stats.finalTurns += 1;
        if (purpose.length === 0) stats.emptyPurpose += 1;
        // Outputs this message named become history for the messages after it.
        for (const output of outputsIn(turn.body)) {
          if (!outputFirstSeen.has(output.id)) {
            outputFirstSeen.set(output.id, index);
            outputHistory.push({ id: output.id, title: output.title, index });
          }
        }
      });
    }
  }
  cases.sort((left, right) => left.createdAt - right.createdAt);
  await writePrivateFile(resolve(output), `${cases.map((evaluationCase) => JSON.stringify(evaluationCase)).join("\n")}\n`);
  process.stdout.write(`${JSON.stringify(stats)}\n`);
}

await main();
