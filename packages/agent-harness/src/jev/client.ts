import { z } from "zod";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import type { StructuredModelDiagnostic } from "../index";

/**
 * One TypeSafe SystemOne request, and nothing about any particular decision.
 *
 * Everything here was extracted from `classifyAddressingWithTypeSafe`, which
 * had been the only JEV caller and therefore owned the endpoint, the envelope,
 * the owned deadline, the failure vocabulary and the diagnostic shape alongside
 * one product question. A second caller written the same way would have copied
 * about a hundred and thirty lines of transport, and the copies would have
 * drifted where it matters least visibly: `docs/jev-best-practices.md` names
 * "`>=` in one service and `>` in another" as the failure to expect, and the
 * same applies to whether a timeout is reported as an abort.
 *
 * So a caller supplies the decision (state, questions, answer schema, model
 * alias, deadline) and this owns the wire. It knows nothing about addressing,
 * semantic triggers, or anything else, and it never decides what a confidence
 * means: see `cascade.ts` for that half.
 */
export const JEV_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";

/** The alias that follows JEV's current release rather than pinning one. */
export const JEV_LATEST_MODEL = "jev-latest";

/**
 * A JEV request that did not produce an answer, carrying the code a log records.
 *
 * The code vocabulary is the provider's, not one decision's: `typesafe_http_429`
 * means the same thing to every caller, which is what makes one alert and one
 * runbook entry cover all of them.
 */
export class JevRequestFailed extends Error {
  readonly kind: string;

  constructor(kind: string, message?: string) {
    super(message ?? kind);
    this.name = "JevRequestFailed";
    this.kind = kind;
  }
}

export interface JevTraceContext {
  requestId?: string | undefined;
  harnessRunId?: string | undefined;
}

export interface JevRequest<Answers> {
  /** The TypeSafe credential. A caller without one has no JEV stage at all. */
  apiKey: string;
  /** A model alias such as `jev-latest`, or an exact pinned version. */
  model: string;
  /**
   * The semantically named state the question reasons over. Its field names are
   * part of the request being evaluated, so they belong to the caller.
   */
  state: Record<string, unknown>;
  /** The questions document, keyed by answer name. */
  questions: Record<string, unknown>;
  /** The schema for the response's `answers` object. */
  answers: z.ZodType<Answers>;
  /** Names this decision in diagnostics and lakehouse records. */
  schemaName: string;
  /**
   * This request's own deadline, separate from `signal`.
   *
   * Required, and deliberately without a default: a deadline is a number
   * somebody has to justify for the path it bounds, and a shared default would
   * silently apply one decision's latency budget to another's.
   */
  timeoutMs: number;
  /** Caller cancellation. Distinct from the deadline: it stops work rather than permitting failover. */
  signal?: AbortSignal | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  onDiagnostic?: ((event: StructuredModelDiagnostic) => void | Promise<void>) | undefined;
  traceContext?: JevTraceContext | undefined;
}

export interface JevResult<Answers> {
  /** The model that answered, which an alias makes distinct from the one requested. */
  model: string;
  answers: Answers;
  usage?: { inputTokens: number; outputTokens: number } | undefined;
}

/**
 * The response envelope, built around the caller's answers schema rather than
 * parsing the two separately.
 *
 * One parse, so a rejected field's path stays rooted at the response: a
 * confidence the provider omitted is reported as `answers.<name>.confidence`
 * and not as `<name>.confidence`. That prefix is what tells an operator reading
 * `docs/naming-a-schema-failure.md`'s catalogue which side of the boundary
 * failed, and a regression test pins it.
 */
function jevEnvelopeSchema<Answers>(answers: z.ZodType<Answers>) {
  return z.object({
    model: z.string().min(1),
    answers,
    usage: z.object({
      input_tokens: z.number().nonnegative(),
      output_tokens: z.number().nonnegative(),
    }).optional(),
  });
}

/**
 * Ask JEV one question set and return its typed answers.
 *
 * Throws `JevRequestFailed` for every transport and protocol outcome, and the
 * original `ZodError` when the response parsed as JSON but not as the answers
 * the caller declared — that error carries the field path, which
 * `docs/naming-a-schema-failure.md` requires a boundary to keep rather than
 * reduce to "invalid".
 *
 * A caller's `signal` aborting is rethrown as the abort it is. The owned
 * deadline is reported as `typesafe_request_timed_out`, which is what lets a
 * cascade tell "we ran out of patience" from "the caller went away".
 */
export async function askJev<Answers>(request: JevRequest<Answers>): Promise<JevResult<Answers>> {
  const fetcher = request.fetch ?? globalThis.fetch;
  const traceId = request.traceContext?.requestId
    ?? request.traceContext?.harnessRunId
    ?? crypto.randomUUID();
  const inferenceRequestId = crypto.randomUUID();
  const startedAt = Date.now();
  const requestPayload = {
    state: request.state,
    questions: request.questions,
    model: request.model,
  };
  const diagnosticBase = {
    provider: "typesafe" as const,
    schemaName: request.schemaName,
    model: request.model,
    attempt: 0,
    fallbackAttempt: 0,
    repairAttempt: 0,
    inferenceRequestId,
    traceId,
  };
  await request.onDiagnostic?.({ ...diagnosticBase, stage: "model_request", requestPayload });

  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), request.timeoutMs);
  const signal = request.signal
    ? AbortSignal.any([request.signal, deadline.signal])
    : deadline.signal;
  let failureResponseBytes: number | undefined;
  let failureResponsePayload: Record<string, unknown> | undefined;
  try {
    const response = await fetcher(JEV_SYSTEM_ONE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestPayload),
      signal,
    });
    const raw = await response.text();
    failureResponseBytes = new TextEncoder().encode(raw).byteLength;

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      if (!response.ok) throw new JevRequestFailed(`typesafe_http_${response.status}`);
      throw new JevRequestFailed("typesafe_response_invalid_json");
    }
    if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
      failureResponsePayload = decoded as Record<string, unknown>;
    }
    if (!response.ok) throw new JevRequestFailed(`typesafe_http_${response.status}`);

    const parsed = jevEnvelopeSchema(request.answers).safeParse(decoded);
    if (!parsed.success) {
      const error = parsed.error;
      await request.onDiagnostic?.({
        ...diagnosticBase,
        stage: "complete",
        latencyMs: Date.now() - startedAt,
        responseBytes: failureResponseBytes,
        success: false,
        failureKind: zodDiagnosticCode(error, "typesafe_response") ?? "typesafe_response_invalid",
        responsePayload: decoded as Record<string, unknown>,
        validationIssues: error.issues.map((issue) => ({
          path: issue.path.length === 0 ? "-root-" : issue.path.join("."),
          code: issue.code,
        })),
      });
      throw error;
    }

    const usage = parsed.data.usage
      ? { inputTokens: parsed.data.usage.input_tokens, outputTokens: parsed.data.usage.output_tokens }
      : undefined;
    await request.onDiagnostic?.({
      ...diagnosticBase,
      stage: "complete",
      model: parsed.data.model,
      latencyMs: Date.now() - startedAt,
      responseBytes: failureResponseBytes,
      ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
      success: true,
      responsePayload: decoded as Record<string, unknown>,
    });
    return { model: parsed.data.model, answers: parsed.data.answers, usage };
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    await request.onDiagnostic?.({
      ...diagnosticBase,
      stage: "complete",
      latencyMs: Date.now() - startedAt,
      ...(failureResponseBytes !== undefined ? { responseBytes: failureResponseBytes } : {}),
      ...(failureResponsePayload ? { responsePayload: failureResponsePayload } : {}),
      success: false,
      failureKind: jevFailureKind(error, request.signal, deadline.signal),
    });
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/**
 * The one place a JEV failure gets its name.
 *
 * Order matters: a caller's cancellation is reported as cancellation even when
 * the deadline fired in the same tick, because a cascade must not treat a
 * caller going away as permission to spend a second provider call.
 */
export function jevFailureKind(
  error: unknown,
  callerSignal?: AbortSignal,
  deadlineSignal?: AbortSignal,
): string {
  if (callerSignal?.aborted) return "typesafe_request_aborted";
  if (deadlineSignal?.aborted) return "typesafe_request_timed_out";
  if (error instanceof JevRequestFailed) return error.kind;
  return "typesafe_request_failed";
}
