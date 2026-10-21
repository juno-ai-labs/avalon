import { createHash } from "node:crypto";
import { z } from "zod";
import { caseSchema, splitForFamily, type EvalCase } from "./evaluation";

const turnSchema = z.object({ seq: z.number(), id: z.string(), role: z.string(), content: z.string(), created_at: z.number(), structured: z.string().nullable().optional() });
export const rawSchema = z.object({
  org: z.string(), workspaceId: z.string(), workstreamId: z.string(), substreamId: z.string(),
  runs: z.array(z.object({ run_id: z.string(), trigger_part_id: z.string().nullable(), input_fence_seq: z.number(),
    final_turn_id: z.string(), origin: z.string(), started_at: z.number() })),
  turns: z.array(turnSchema),
  tools: z.array(z.object({ run_id: z.string(), call_id: z.string(), operation: z.string(), status: z.string(),
    input: z.string(), summary: z.string().nullable(), error: z.string().nullable().optional(), started_at: z.number(), settled_at: z.number().nullable() })),
});
export const annotationSchema = z.object({
  runId: z.string(), contextSequences: z.array(z.number()), contextStatus: caseSchema.shape.state.shape.context_status,
  expected: caseSchema.shape.expected, expectedNudge: z.boolean(), lifecycle: caseSchema.shape.lifecycle,
  rationale: z.string(), tags: z.array(z.string()),
});
export type RawConversation = z.infer<typeof rawSchema>;
export type Annotation = z.infer<typeof annotationSchema>;

function turnText(turn: z.infer<typeof turnSchema>): string {
  if (turn.content || !turn.structured) return turn.content;
  const elicitation = z.object({ elicitation: z.object({ prompt: z.string(), answer: z.unknown() }) })
    .safeParse(JSON.parse(turn.structured));
  if (!elicitation.success || elicitation.data.elicitation.answer == null) return turn.content;
  return JSON.stringify({ question: elicitation.data.elicitation.prompt, answer: elicitation.data.elicitation.answer });
}

/** Alias conversations share run IDs. Union parent thread IDs before splitting,
 * so a breakout also reachable as a top-level thread cannot leak across splits. */
export function buildCases(raw: RawConversation[], annotations: Annotation[]): EvalCase[] {
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    const p = parent.get(id);
    return p && p !== id ? root(p) : id;
  };
  const owner = new Map<string, string>();
  for (const c of raw) {
    for (const r of c.runs) {
      const previous = owner.get(r.run_id);
      if (previous) {
        const a = root(previous), b = root(c.workstreamId);
        parent.set(a > b ? a : b, a > b ? b : a);
      }
      owner.set(r.run_id, c.workstreamId);
    }
  }
  if (new Set(annotations.map((a) => a.runId)).size !== annotations.length) throw new Error("Duplicate annotations");
  return annotations.map((annotation) => {
    const candidates = raw.filter((c) => c.runs.some((r) => r.run_id === annotation.runId));
    // Prefer the actual breakout over its thread alias.
    candidates.sort((a, b) => Number(a.substreamId === "0") - Number(b.substreamId === "0"));
    const c = candidates[0];
    if (!c) throw new Error(`Missing run ${annotation.runId}`);
    const run = c.runs.find((r) => r.run_id === annotation.runId)!;
    const final = c.turns.find((t) => t.id === run.final_turn_id);
    if (!final || final.role !== "assistant") throw new Error(`Missing assistant final ${run.run_id}`);
    const trigger = c.turns.find((t) => t.id === run.trigger_part_id);
    const fence = trigger?.seq ?? run.input_fence_seq;
    if (trigger && (trigger.seq >= final.seq || trigger.created_at > final.created_at)) throw new Error("Trigger is after final");
    const linked = annotation.contextSequences.map((seq) => {
      const turn = c.turns.find((t) => t.seq === seq);
      if (!turn || turn.seq >= fence || turn.created_at > final.created_at) throw new Error(`Invalid older context ${seq} for ${run.run_id}`);
      return { id: turn.id, role: turn.role, text: turnText(turn), relation: "curated_antecedent" };
    });
    // Delivered steering and agent messages before the final are evidence too.
    // Assistant progress is excluded: it must not be mistaken for a deliverable.
    for (const t of c.turns.filter((t) => t.seq > fence && t.seq < final.seq && t.created_at <= final.created_at && t.role !== "assistant").sort((a, b) => a.seq - b.seq)) {
      linked.push({ id: t.id, role: t.role, text: turnText(t), relation: "delivered_during_execution" });
    }
    const receipts = c.tools.filter((t) => t.run_id === run.run_id && t.started_at <= final.created_at).map((t) => {
      const settled = t.settled_at !== null && t.settled_at <= final.created_at;
      const input = z.record(z.string(), z.unknown()).parse(JSON.parse(t.input));
      const target = Object.fromEntries(Object.entries(input).filter(([k]) =>
        ["path", "filePath", "resourceId", "documentId", "spreadsheetId", "range", "url", "title", "displayName", "agentId", "messageId", "description", "pluginId"].includes(k)));
      const error = settled && t.error ? z.object({ code: z.string().optional(), message: z.string().optional() }).parse(JSON.parse(t.error)) : null;
      const summary = settled ? t.summary ?? (error ? JSON.stringify(error) : null) : null;
      return { id: t.call_id, operation: t.operation, target, status: settled ? t.status : "pending",
        summary, output_refs: summary?.match(/(?:https?:\/\/|resource:\/\/)[^\s)]+/g) ?? [] };
    });
    const family = root(c.workstreamId);
    return caseSchema.parse({
      id: `real-${createHash("sha256").update(run.run_id).digest("hex").slice(0, 16)}`,
      family, split: splitForFamily(family), suite: "real", org: c.org,
      kind: c.substreamId === "0" ? "thread" : "breakout", tags: annotation.tags,
      state: {
        triggering_request: { id: trigger?.id ?? run.trigger_part_id ?? "missing", text: trigger ? turnText(trigger) : "", origin: run.origin },
        linked_context: linked, candidate_final: final.content, tool_receipts: receipts,
        context_status: trigger && turnText(trigger) ? annotation.contextStatus : "unresolved",
        evidence_coverage: "Exact recorded final and trigger; curated older turns and all intervening non-assistant messages. Current-run tool-effect statuses and summaries only, not full provider outputs or previous-run receipts. No post-final outcomes.",
      },
      lifecycle: annotation.lifecycle, expected: annotation.expected, expectedNudge: annotation.expectedNudge, rationale: annotation.rationale,
      provenance: { runId: run.run_id, finalTurnId: final.id, startedAt: run.started_at,
        aliases: candidates.map((a) => ({ workspaceId: a.workspaceId, workstreamId: a.workstreamId, substreamId: a.substreamId })),
        referenceAuthor: "Codex; independently authored before JEV predictions; not human-adjudicated" },
    });
  });
}
