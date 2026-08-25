import { tracing } from "cloudflare:workers";
import type { Context } from "hono";

import type { HonoAppEnv } from "../env";
import { logStructuredEvent, type LogEnv, type LogFields } from "./logger";

/**
 * Custom spans for the three latency-critical work-stream flows: starting a
 * work stream, opening one, and sending it a message.
 *
 * These sit on top of **Cloudflare's automatic tracing**, which both regional
 * Workers already enable (`observability.traces` in `wrangler.*.jsonc`). The
 * platform instruments handler invocations, outbound `fetch`, and binding calls
 * — D1, KV, R2, and Durable Objects — and exports the result over OTLP. It
 * therefore already owns everything an OpenTelemetry SDK would otherwise be
 * installed to do: trace and span ids, parent/child nesting, context
 * propagation across a subrequest, and the exporter. **Do not add an OTel
 * package, mint a trace id, or write a `traceparent` header here.** A
 * hand-rolled id would build a second trace graph beside the platform's, and
 * the two would never join.
 *
 * What this module adds is the part Cloudflare cannot know: the *names* of the
 * steps inside one invocation, and the business identity — which workspace,
 * which work stream, which person — that makes a slow trace actionable. Both
 * are expressed the way the exporter reads them: `tracing.enterSpan` for the
 * step, `span.setAttribute` for the identity.
 *
 * Two platform behaviors this is built on, and both are why so little code is
 * needed here:
 *
 * - **Spans nest by async context.** Anything that runs inside an `enterSpan`
 *   callback — another `enterSpan`, a D1 query, a Durable Object call — becomes
 *   its child automatically. Nothing is wired by hand, and there is no
 *   `spanContext()` to read ids from even if it were.
 * - **`console` output is attributed to the active span.** Every
 *   `logStructuredEvent` call made inside one of these spans is exported as an
 *   OTLP log record sharing that span's trace id, so a destination correlates
 *   the logs to the trace with no work from us.
 *
 * `docs/performance-tracing.md` holds the span names, the attribute registry,
 * and the identity caveat that matters before any of this reaches PostHog.
 * `docs/cloudflare-logging-and-tracing.md` holds what the platform actually
 * does, dated — it is in open beta, and Cloudflare says its span and attribute
 * names are not final.
 */

/** The flows this module traces. Carried as `rally.flow` on every span. */
export type PerfFlow =
  | "workstream_create"
  | "workstream_open"
  | "workstream_message_send";

/**
 * The value types `span.setAttribute` accepts. `null` is admitted at the type
 * level because so many of the ids here are nullable, and dropped at the
 * boundary — an attribute is either set or absent, never present-and-empty.
 */
export type SpanAttributeValue = string | number | boolean | null | undefined;
export type SpanAttributes = Record<string, SpanAttributeValue>;

/**
 * The identity attributes every span in these flows carries.
 *
 * Names follow OpenTelemetry semantic conventions where one exists (`user.id`,
 * `session.id`); everything this product owns is namespaced under `rally.` so
 * it can never collide with a convention added later. This is the one place an
 * Avalon identifier becomes an attribute name, so a rename happens once and a
 * dashboard filtering on `rally.workspace.id` does not care which component
 * emitted the span.
 */
export interface TraceIdentity {
  workspaceId?: string | null | undefined;
  workstreamId?: string | null | undefined;
  userId?: string | null | undefined;
  substreamId?: string | null | undefined;
  /**
   * The desktop's `x-request-id`. A WebSocket upgrade and a command-socket
   * frame carry no `traceparent`, so this — and the socket ticket id, and the
   * client message id — are the attributes that join what the platform traces
   * as separate invocations. They are correlation *attributes*, deliberately
   * not stand-in trace ids.
   */
  requestId?: string | null | undefined;
  sessionId?: string | null | undefined;
  /**
   * The analytics surrogates PostHog knows this person and workspace by. They
   * are what makes a system span joinable to a product event: PostHog is keyed
   * on these and not on `userId`, so without them the two datasets can only be
   * matched by reconstructing the mapping out of regional D1.
   *
   * Absent until the first product event mints them, which is correct rather
   * than a gap — there is no PostHog person to join to yet.
   */
  analyticsPersonId?: string | null | undefined;
  analyticsWorkspaceId?: string | null | undefined;
}

export function identityAttributes(identity: TraceIdentity): SpanAttributes {
  return {
    "user.id": identity.userId,
    "session.id": identity.sessionId,
    "rally.workspace.id": identity.workspaceId,
    "rally.workstream.id": identity.workstreamId,
    "rally.substream.id": identity.substreamId,
    "rally.request.id": identity.requestId,
    // Named for what they are on the other side. A reader who has a PostHog
    // person open and wants its traces filters on the same value they are
    // already looking at.
    "rally.analytics.person_id": identity.analyticsPersonId,
    "rally.analytics.workspace_id": identity.analyticsWorkspaceId,
    // The one vendor-specific name in this file, and it is deliberate.
    //
    // `performance-tracing.md` gives two ways to settle identity before an
    // export: map through the analytics ids at the exporter, or keep the
    // attributes opaque and never promote them to identity. What is not allowed
    // is letting the destination's default decide — and a destination that
    // started reading `user.id` as its person key would split one human into
    // two, since the product pipeline keys the same person on the surrogate.
    //
    // Setting PostHog's own key explicitly takes the first way out and closes
    // the question: identity is the surrogate, chosen here, not inferred there.
    // It is absent when the surrogate is — a person with no PostHog identity
    // yet has nothing to be keyed on.
    "posthog.distinct_id": identity.analyticsPersonId,
  };
}

/** The Cloudflare span surface this module uses. */
interface RuntimeSpan {
  setAttribute(key: string, value: string | number | boolean | undefined): void;
  readonly isTraced?: boolean;
}

/**
 * `setAttribute` treats `undefined` as a documented no-op, but `null` is not an
 * accepted value type at all — so both are filtered here rather than only the
 * one, and an attribute ends up either set or absent. A present-but-empty
 * attribute is worse than a missing one: it makes *unknown* indistinguishable
 * from *known to be nothing* in a dashboard.
 */
function applyAttributes(span: RuntimeSpan, attributes: SpanAttributes): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    span.setAttribute(key, value);
  }
}

/** What a call site is handed. Deliberately narrower than the runtime span. */
export interface TracedSpan {
  setAttributes(attributes: SpanAttributes): void;
  /**
   * Records a failure on the span. The runtime lists `setOutcome` as not yet
   * supported, so the status travels as the attributes a destination reads it
   * from — `otel.status_code`, `error.type`, `otel.status_description` — which
   * is what every backend built on OTLP already understands.
   */
  setError(code: string, message?: string): void;
  /**
   * False when this invocation was not sampled, and false again once the span
   * has ended. The callback runs either way — this only says whether anything
   * is being recorded, so it is worth checking before computing an attribute
   * that costs something. Nothing here computes one that does.
   */
  readonly isTraced: boolean;
}

function tracedSpan(span: RuntimeSpan): TracedSpan {
  return {
    setAttributes(attributes: SpanAttributes): void {
      applyAttributes(span, attributes);
    },
    setError(code: string, message?: string): void {
      applyAttributes(span, {
        "otel.status_code": "ERROR",
        "error.type": code,
        ...(message === undefined ? {} : { "otel.status_description": message }),
      });
    },
    get isTraced(): boolean {
      return span.isTraced ?? true;
    },
  };
}

/**
 * Runs `run` inside a child span. The span ends when `run` settles, whether it
 * resolves or throws — a step that threw is the one worth seeing on the trace,
 * and the runtime records the throw for us.
 *
 * Nesting is the async context's job: whatever span is active when this is
 * called becomes the parent, so a service called from inside a route's span
 * needs no handle passed to it to end up in the right place.
 */
export function inSpan<T>(
  name: string,
  attributes: SpanAttributes,
  run: (span: TracedSpan) => Promise<T>,
): Promise<T> {
  return tracing.enterSpan(name, (span: RuntimeSpan) => {
    applyAttributes(span, attributes);
    return run(tracedSpan(span));
  });
}

/**
 * A flow's root span. Beyond `inSpan` it does two things: it stamps the flow
 * and identity attributes on the root — children do *not* inherit attributes in
 * OpenTelemetry, which is why `step` repeats the flow and component onto each
 * one — and it accumulates each `step`'s duration so the flow also lands in
 * Workers Logs as **one row** carrying the whole step breakdown.
 *
 * The log row is not a duplicate of the trace. A trace answers "what happened
 * in this one invocation" and needs the trace UI or the OTLP destination to
 * read; the row answers "which step is slow across ten thousand creates" from
 * the Query Builder, with no sampling and no join. Both are cheap; only one of
 * them is billed per span.
 */
export interface FlowSpan extends TracedSpan {
  /** Times a named child span and records it in the flow's summary row. */
  step<T>(name: string, run: () => Promise<T>, attributes?: SpanAttributes): Promise<T>;
  /** Records a zero-work checkpoint in the summary row. Emits no span. */
  mark(name: string): void;
}

export interface FlowSpanOptions {
  flow: PerfFlow;
  /** Names the component: `api`, `api_socket`, `substream_do`, … */
  component: string;
  identity?: TraceIdentity;
  attributes?: SpanAttributes;
}

const MAX_STEPS = 64;

export function inFlowSpan<T>(
  env: LogEnv,
  name: string,
  options: FlowSpanOptions,
  run: (span: FlowSpan) => Promise<T>,
): Promise<T> {
  const identity = options.identity ?? {};
  const callerAttributes = options.attributes ?? {};
  const base: SpanAttributes = {
    "rally.flow": options.flow,
    "rally.component": options.component,
    ...identityAttributes(identity),
    ...callerAttributes,
  };
  return inSpan(name, base, async (span) => {
    // `Date.now()` is pinned by workerd for the duration of a synchronous run
    // and advances only across I/O — the same Spectre mitigation behind
    // Cloudflare documenting its own spans as sometimes reporting 0ms for work
    // that took longer. A step's number is the time it spent waiting on D1, a
    // Durable Object, or a provider; a step that is pure computation reads 0ms.
    // Nothing on these paths is CPU-bound.
    const startedAt = Date.now();
    const steps: Array<[string, number]> = [];
    let cursor = startedAt;
    // Seeded from the caller's attributes so the summary row is self-describing
    // — the HTTP method and route, the transport, the authentication cost —
    // rather than a duration with no context beside it. The flow and identity
    // fields are added explicitly below and are deliberately not duplicated
    // here under their attribute names.
    let extra: LogFields = definedFields(callerAttributes);

    const record = (stepName: string, durationMs: number): void => {
      // An unbounded list is a leak on a long-lived Durable Object invocation.
      // Past the cap steps are dropped but the clock is not, so the total and
      // every earlier step stay truthful.
      if (steps.length < MAX_STEPS) steps.push([stepName, durationMs]);
      else if (steps.length === MAX_STEPS) steps.push(["steps_truncated", 0]);
    };

    const close = (stepName: string): void => {
      const at = Date.now();
      record(stepName, at - cursor);
      cursor = at;
    };

    /**
     * Charge whatever ran since the last step to `unattributed` rather than to
     * the step about to start.
     *
     * A step used to be measured from the previous step's end, so an awaited
     * call sitting *between* two steps was billed to the later one: the row
     * could name a fast step as `slowest_step` at the cost of its slow
     * neighbour, while that step's own span recorded the truth. Naming the gap
     * keeps the parts summing to `duration_ms` — an unstepped await now shows
     * up as itself instead of hiding inside whatever ran next.
     */
    const closeGap = (): void => {
      const at = Date.now();
      if (at > cursor) record("unattributed", at - cursor);
      cursor = at;
    };

    const flowSpan: FlowSpan = {
      setAttributes(attributes: SpanAttributes): void {
        span.setAttributes(attributes);
        // Mirrored onto the summary row, so one row answers what the trace
        // does. Attribute names are kept verbatim rather than translated.
        extra = { ...extra, ...definedFields(attributes) };
      },
      setError(code: string, message?: string): void {
        span.setError(code, message);
        extra = { ...extra, "error.type": code, ...(message === undefined ? {} : { "otel.status_description": message }) };
      },
      get isTraced(): boolean {
        return span.isTraced;
      },
      async step<T2>(stepName: string, stepRun: () => Promise<T2>, attributes: SpanAttributes = {}): Promise<T2> {
        closeGap();
        try {
          // The flow and component are repeated onto every child. OpenTelemetry
          // does not inherit attributes, so without this a step span cannot be
          // filtered or grouped by the flow it belongs to — only followed by
          // hand from its parent. Two short strings per span is worth that.
          //
          // The identity attributes are deliberately *not* repeated: they are
          // many, they are on the root of the same trace, and the `perf_flow`
          // row already carries every step's duration next to them, which is
          // the path built for aggregating across requests.
          return await inSpan(stepName, {
            "rally.flow": options.flow,
            "rally.component": options.component,
            ...attributes,
          }, () => stepRun());
        } finally {
          close(stepName);
        }
      },
      // `mark` deliberately keeps the old accounting: it exists to name work
      // that has already happened since the last step, so the span between the
      // cursor and now *is* what it is reporting.
      mark(stepName: string): void {
        close(stepName);
      },
    };

    try {
      return await run(flowSpan);
    } finally {
      const durationMs = Date.now() - startedAt;
      const slowest = steps.reduce<[string, number] | null>(
        (worst, step) => (worst === null || step[1] > worst[1] ? step : worst),
        null,
      );
      // Emitted inside the span, so the platform attributes this record to it
      // and the OTLP export carries it under the same trace id.
      logStructuredEvent(env, "info", "perf_flow", {
        flow: options.flow,
        component: options.component,
        duration_ms: durationMs,
        steps: Object.fromEntries(steps),
        step_order: steps.map(([stepName]) => stepName).join(","),
        ...(slowest === null ? {} : { slowest_step: slowest[0], slowest_step_ms: slowest[1] }),
        ...definedFields({
          workspace_id: identity.workspaceId,
          workstream_id: identity.workstreamId,
          user_id: identity.userId,
          request_id: identity.requestId,
        }),
        ...extra,
      });
    }
  });
}

function definedFields(attributes: SpanAttributes): LogFields {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null),
  );
}

/**
 * The request-scoped flow span. `requestContext` has already resolved the
 * request id — the one the desktop sent as `x-request-id` and the response
 * echoes — so a flow the desktop printed locally is one attribute filter away
 * from its trace.
 */
export function requestFlowSpan<T>(
  c: Context<HonoAppEnv>,
  name: string,
  options: { flow: PerfFlow; identity?: TraceIdentity; attributes?: SpanAttributes },
  run: (span: FlowSpan) => Promise<T>,
): Promise<T> {
  const auth = c.get("auth");
  return inFlowSpan(c.env, name, {
    flow: options.flow,
    component: "api",
    identity: {
      requestId: c.get("requestId"),
      workspaceId: auth?.workspaceId,
      userId: auth?.userId,
      sessionId: auth?.sessionId,
      analyticsPersonId: auth?.analyticsPersonId,
      analyticsWorkspaceId: auth?.analyticsWorkspaceId,
      ...(options.identity ?? {}),
    },
    attributes: {
      // Semantic-convention names, so the exported span reads like every other
      // HTTP span a destination has ever seen.
      "http.request.method": c.req.method,
      "http.route": c.req.routePath,
      // Authentication runs before this span opens, so its cost is inside
      // `http_request` and outside this flow's duration. Carrying the number
      // is what stops the difference between the two reading as unexplained.
      "rally.auth.duration_ms": c.get("authDurationMs"),
      ...(options.attributes ?? {}),
    },
  }, run);
}

/**
 * The span an untraced path holds: a `FlowSpan` that emits nothing. A call site
 * keeps `span.step(...)` unconditional rather than growing a branch per step —
 * branches that would then have to be kept in step with each other.
 */
export const noFlowSpan: FlowSpan = Object.freeze({
  step: <T>(_name: string, run: () => Promise<T>): Promise<T> => run(),
  mark: (): void => undefined,
  setAttributes: (): void => undefined,
  setError: (): void => undefined,
  isTraced: false,
});
