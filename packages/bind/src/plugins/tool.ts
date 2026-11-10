import type { z } from "zod";

/**
 * The plugin/tool vocabulary — the shape of a tool, a bundle of tools, and
 * the result of running one.
 *
 * Two things are deliberately NOT fixed here, because they are where hosts
 * genuinely diverge rather than incidentally differ:
 *
 *  - **The invocation context** (`TCtx`). A census of two production agent
 *    runtimes' contexts found ~33 fields of which exactly one (`abortSignal`)
 *    was shared; the rest are host identity (tenant, workspace, thread, role),
 *    host authorization (principal, scope clamps), or host product
 *    features. A common concrete context would be either a
 *    lowest-common-denominator or a union of two products' identity models,
 *    so the context is a type parameter and the host supplies it.
 *
 *  - **Multimodal content parts** (`TContentPart`). The wire shape is the
 *    provider's, but building one from bytes needs host capabilities, so the
 *    harness carries the parts through without interpreting them.
 *
 * Hosts extend `ToolPlugin` with their own fields via ordinary interface
 * extension (Monad adds `configuration`, `skills`, `exposeViaMcp`).
 */

/**
 * Behavioural hints that travel with a tool on `tools/list`. Mirrors
 * the MCP `ToolAnnotations` shape — duplicated here so plugins can
 * declare them without importing the SDK directly.
 */
export interface ToolAnnotations {
  /** Human-readable title for the tool. */
  title?: string;
  /** True if the tool only reads data. */
  readOnlyHint?: boolean;
  /** True if the tool may make destructive changes. Meaningful only when readOnlyHint===false. */
  destructiveHint?: boolean;
  /** True if calling the tool with the same args yields the same result. */
  idempotentHint?: boolean;
  /** True if the tool may interact with external systems. */
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: z.ZodType;
  /**
   * Pure post-parse canonicalization applied before run-scoped idempotency
   * hashing and execution. Keep model-facing schemas JSON-Schema-compatible;
   * semantic normalization such as sorting set-like arrays belongs here.
   */
  normalizeArgs?: (args: unknown) => unknown;
  /**
   * Pre-computed JSON Schema to pass to the LLM instead of converting via
   * `z.toJSONSchema()`. Also the seam for a host whose tools are authored as
   * raw JSON Schema rather than zod.
   */
  rawJsonSchema?: Record<string, unknown>;
  /** Annotations forwarded on the MCP `tools/list` response. */
  annotations?: ToolAnnotations;
  /** If true, the dispatcher emits a periodic auto-heartbeat. */
  supportsProgress?: boolean;
  /**
   * When `true`, the tool stays runnable (dispatch + `plugin.tools` lookup
   * still resolve it) but is omitted from the model-facing catalog. Used to
   * retire a tool from the prompt while keeping it callable for resumed
   * sessions whose history still references it.
   */
  hidden?: boolean;
  /**
   * Optional human one-liner describing THIS call, derived from its args.
   * MUST be pure + synchronous: `safeParse` the args with the tool's own
   * schema, then read fields — no I/O, no context. Returns `null` to fall
   * back to generic copy. Purity is load-bearing: it runs on the executor
   * hot path inside a fire-and-forget emit.
   */
  summarizeActivity?: (args: unknown) => string | null;
}

/**
 * Structured failure category for a failed `ToolResult`. Lets a host map a
 * plugin failure onto its own error taxonomy — a protocol error code, an HTTP
 * status, a retry decision — without matching on the error string, which is
 * brittle and locale-dependent. Plugins should set it explicitly.
 */
export type ToolFailureKind =
  | "authz" // authorization denied
  | "validation" // user-supplied input invalid
  | "not_found" // referenced resource doesn't exist
  | "conflict" // optimistic-locking / concurrent-write loss
  | "external" // upstream/third-party service failed
  | "not_run" // never started — nothing was attempted and nothing changed
  | "system"; // anything else

/**
 * Human-in-the-loop suspend directive. A first-party tool returns this on a
 * successful result to **end the run** and record its open tool-call as
 * awaiting resolution. Two resume kinds:
 *  - `answer`: the run resumes by threading a human/external response back as
 *    the matching `role:"tool"` result. The loop therefore WITHHOLDS this
 *    call's tool message — the result is the future answer.
 *  - `wake`: a time/event resume that re-enters via a prompt and keeps the
 *    tool message.
 * `request` is an opaque render/route payload, validated by the consumer and
 * never inspected by the loop.
 */
export type SuspendDirective = {
  reason: string;
  resumeKind: "answer" | "wake";
  request?: unknown;
};

export type ToolResult<TContentPart = unknown> =
  | {
      success: true;
      data: unknown;
      contentParts?: TContentPart[];
      suspend?: SuspendDirective;
    }
  | {
      success: false;
      error: string;
      kind?: ToolFailureKind;
      /** Optional structured recovery context safe to expose to the model. */
      data?: unknown;
    };

/**
 * Narrow helper: does this tool result ask the executor to relay multimodal
 * content parts alongside the textual JSON result on the next turn?
 */
export function hasContentParts<TContentPart>(
  result: ToolResult<TContentPart>,
): result is {
  success: true;
  data: unknown;
  contentParts: TContentPart[];
  suspend?: SuspendDirective;
} {
  return (
    result.success === true &&
    Array.isArray(result.contentParts) &&
    result.contentParts.length > 0
  );
}

/**
 * A self-contained bundle of related tools plus the metadata the catalog and
 * the system prompt need. `execute` dispatches by tool name so a plugin can
 * share setup across its tools.
 */
export interface ToolPlugin<TCtx, TContentPart = unknown> {
  name: string;
  description: string;
  /**
   * Optional short icon identifier a host UI may use to pick a glyph. Optional
   * because a headless consumer has no glyph to pick; a host that renders tool
   * activity can re-require it on its own extension of this interface.
   */
  icon?: string;
  /**
   * Global availability gate; unavailable plugins stay registered (so they can
   * still be listed for configuration) but do not resolve for a run.
   *
   * **Must be constant for the lifetime of the process or isolate.** It is
   * re-evaluated on every catalog render — which, for a host that re-renders
   * its system prompt on each activation, is several times per run. A value
   * that can flip mid-run (a TTL-cached feature flag, a health probe, a live
   * credential check) rewrites the catalog and invalidates the provider
   * prompt-cache prefix from that byte onward for every remaining turn, and
   * nothing will fail a test. Gate on process-stable configuration; do the
   * liveness check inside `execute`, where a failure is a tool error.
   */
  isAvailable?: () => boolean;
  /** Instructions appended to the system prompt when this plugin is active. */
  systemMessage?: string;
  tools: ToolDef[];
  execute(
    toolName: string,
    args: unknown,
    ctx: TCtx,
  ): Promise<ToolResult<TContentPart>>;
}

/**
 * The structural minimum the registry and catalog need. Hosts pass their own
 * richer plugin type; this is the constraint, not the contract.
 */
export interface RegistrablePlugin {
  name: string;
  description: string;
  isAvailable?: () => boolean;
}
