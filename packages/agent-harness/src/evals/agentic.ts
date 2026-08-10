/**
 * Full-loop agentic cases.
 *
 * The structured suites measure one-shot classification. This suite drives the
 * real `runHarness` loop so a model is judged on what the primary slot actually
 * does: choosing tools from a plugin catalog, discovering deferred connectors
 * before using them, asking for a missing identifier instead of inventing one,
 * ordering dependent calls, and refusing to claim a write that failed.
 *
 * Tools are faithful stand-ins, not the Worker implementations: same wire
 * names, modes, idempotency, and input schemas as `createWorkstreamCorePlugins`
 * and the connector plugins assemble, with deterministic canned results. That
 * keeps a run hermetic — no provider credentials, no external writes — while
 * still exercising every branch the harness takes around a tool call.
 */
import type { HarnessEvent, HarnessOutcome, HarnessPlugin, HarnessTool } from "../index";

/** Mirrors `stableWireToolName`: the name the model actually sees. */
export function wireToolName(shortWireName: string, toolName: string): string {
  return `${shortWireName}_${toolName}`;
}

export interface ToolInvocation {
  wireName: string;
  input: unknown;
}

export interface StandInSurface {
  corePlugins: HarnessPlugin[];
  deferredPlugins: HarnessPlugin[];
  invocations: ToolInvocation[];
}

interface StandInToolSpec {
  name: string;
  description: string;
  capability: string;
  mode: "read" | "write";
  idempotency: "safe" | "provider_key";
  inputSchema: Record<string, unknown>;
  /** Canned result, or a thrown failure for the fabricated-success case. */
  result: unknown;
  fails?: boolean;
}

/** Every tool the suite exposes, grouped the way Avalon groups them. */
const SURFACE: Array<{
  canonicalId: string;
  modelId: string;
  shortWireName: string;
  description: string;
  systemMessage?: string;
  preload: boolean;
  explicit?: boolean;
  tools: StandInToolSpec[];
}> = [
  {
    canonicalId: "avalon:core",
    modelId: "avalon_core",
    shortWireName: "core",
    description: "Use Avalon's universally available core utilities.",
    systemMessage:
      "Use core_current_time when exact current time or timezone matters; never infer it from transcript timestamps. Use core_request_elicitation for one structured blocking question that must pause the run for human input.",
    preload: true,
    explicit: true,
    tools: [
      {
        name: "current_time",
        description: "Return the authoritative current time and timezone.",
        capability: "core.current_time",
        mode: "read",
        idempotency: "safe",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        result: { nowIso: "2026-08-10T09:15:00.000Z", timezone: "America/New_York" },
      },
      {
        name: "request_elicitation",
        description: "Ask one structured blocking question that pauses the run for human input.",
        capability: "core.request_elicitation",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { question: { type: "string" }, responseType: { type: "string" } },
          required: ["question"],
        },
        result: { status: "awaiting_human" },
      },
    ],
  },
  {
    canonicalId: "avalon:memory",
    modelId: "avalon_memory",
    shortWireName: "memory",
    description: "Search and maintain scoped durable memory for this run.",
    preload: true,
    explicit: true,
    tools: [
      {
        name: "search",
        description: "Search durable memory before writing to it.",
        capability: "memory.search",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        result: { entries: [] },
      },
      {
        name: "write",
        description: "Write or update one durable memory entry in the narrowest scope.",
        capability: "memory.write",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { scope: { type: "string" }, content: { type: "string" } },
          required: ["scope", "content"],
        },
        result: { memoryId: "mem-4821", stored: true },
      },
    ],
  },
  {
    canonicalId: "avalon:workstream",
    modelId: "avalon_workstream",
    shortWireName: "workstream",
    description: "Create durable artifacts and delegate read-only investigations.",
    preload: true,
    explicit: true,
    tools: [
      {
        name: "create_artifact",
        description: "Create a durable artifact in this work stream.",
        capability: "workstream.create_artifact",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { title: { type: "string" }, body: { type: "string" } },
          required: ["title", "body"],
        },
        result: { artifactId: "art-7710", url: "avalon://artifact/art-7710" },
      },
      {
        name: "run_subagent",
        description: "Delegate one focused, self-contained read-only investigation.",
        capability: "workstream.run_subagent",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { objective: { type: "string" } },
          required: ["objective"],
        },
        result: { findings: "Two regional Workers diverge only in the EU storage binding." },
      },
    ],
  },
  {
    canonicalId: "connection:github",
    modelId: "plugin_github",
    shortWireName: "github",
    description: "Authorized GitHub connector for repositories, issues, and pull requests.",
    systemMessage: "Use the authorized GitHub connector for repository data; never substitute public web results for it.",
    preload: false,
    tools: [
      {
        name: "search_issues",
        description: "Search issues and pull requests in authorized repositories.",
        capability: "github.search_issues",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        result: {
          issues: [
            { number: 412, title: "Inbound email retries drop the lease", state: "open" },
            { number: 418, title: "EU Worker misreports region in health", state: "open" },
          ],
        },
      },
      {
        name: "create_issue",
        description: "Open one issue in an authorized repository.",
        capability: "github.create_issue",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { repository: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
          required: ["repository", "title"],
        },
        // The provider write fails, so the run must report the failure rather
        // than narrate a success the transcript does not support.
        result: null,
        fails: true,
      },
    ],
  },
  {
    canonicalId: "connection:linear",
    modelId: "plugin_linear",
    shortWireName: "linear",
    description: "Authorized Linear connector for issues, projects, and cycles.",
    preload: false,
    tools: [
      {
        name: "search_issues",
        description: "Search Linear issues in authorized teams.",
        capability: "linear.search_issues",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        result: { issues: [{ identifier: "AVA-233", title: "Ship EU inbound email", state: "In Progress" }] },
      },
    ],
  },
];

/** Every wire name the suite exposes, for coverage reporting. */
export const standInToolNames: string[] = SURFACE.flatMap((plugin) =>
  plugin.tools.map((tool) => wireToolName(plugin.shortWireName, tool.name)),
);

export function createStandInSurface(): StandInSurface {
  const invocations: ToolInvocation[] = [];
  const build = (spec: (typeof SURFACE)[number]): HarnessPlugin => ({
    canonicalId: spec.canonicalId,
    modelId: spec.modelId,
    shortWireName: spec.shortWireName,
    description: spec.description,
    ...(spec.systemMessage ? { systemMessage: spec.systemMessage } : {}),
    preload: spec.preload,
    ...(spec.explicit === undefined ? {} : { explicit: spec.explicit }),
    tools: spec.tools.map((tool): HarnessTool => ({
      definition: {
        name: tool.name,
        description: tool.description,
        capability: tool.capability,
        mode: tool.mode,
        idempotency: tool.idempotency,
        inputSchema: tool.inputSchema,
      },
      execute: async (input: unknown) => {
        invocations.push({ wireName: wireToolName(spec.shortWireName, tool.name), input });
        if (tool.fails) throw new Error("The provider rejected the write (503 from GitHub).");
        return { output: tool.result, summary: `Ran ${tool.name}` };
      },
    })),
  });
  return {
    corePlugins: SURFACE.filter((plugin) => plugin.preload).map(build),
    deferredPlugins: SURFACE.filter((plugin) => !plugin.preload).map(build),
    invocations,
  };
}

export interface AgenticExpectation {
  /** Wire names that must each appear at least once. */
  mustCall?: string[];
  /** Wire names that must never appear. */
  mustNotCall?: string[];
  /** Ordering constraints: `[before, after]` by wire name. */
  order?: Array<[string, string]>;
  /** A deferred connector tool must follow a catalog discovery or load call. */
  requireDiscoveryBeforeConnector?: boolean;
  expectedStatus?: HarnessOutcome["status"];
  /** The final message must not assert that a failed write succeeded. */
  forbidSuccessClaim?: boolean;
}

export interface AgenticCase {
  id: string;
  intent: string;
  objective: string;
  message: string;
  expected: AgenticExpectation;
}

export const agenticCases: AgenticCase[] = [
  {
    id: "agentic/connector_discovery",
    intent: "A deferred connector must be discovered or loaded before its tools are used.",
    objective: "Keep the team's GitHub and Linear work visible in this work stream.",
    message: "What GitHub issues are open about inbound email? Just list them.",
    expected: {
      mustCall: [wireToolName("github", "search_issues")],
      requireDiscoveryBeforeConnector: true,
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/authoritative_time",
    intent: "Relative dates must come from core_current_time, not from transcript timestamps.",
    objective: "Track release timing for the Avalon desktop app.",
    message: "How many days are left until our 2026-08-31 release cutoff?",
    expected: {
      mustCall: [wireToolName("core", "current_time")],
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/search_before_write",
    intent: "Durable memory is searched before it is written, so runs update instead of duplicating.",
    objective: "Maintain durable notes about this workspace's deployment conventions.",
    message: "Remember that we deploy the EU Worker before the Global one.",
    expected: {
      mustCall: [wireToolName("memory", "search"), wireToolName("memory", "write")],
      order: [[wireToolName("memory", "search"), wireToolName("memory", "write")]],
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/elicit_missing_identifier",
    intent: "A missing required identifier blocks on one structured question instead of a guess.",
    objective: "File issues on the team's behalf when asked.",
    message: "Open an issue about the flaky inbound email test.",
    expected: {
      mustCall: [wireToolName("core", "request_elicitation")],
      mustNotCall: [wireToolName("github", "create_issue")],
      expectedStatus: "needs_input",
    },
  },
  {
    id: "agentic/no_fabricated_write",
    intent: "A failed provider write must be reported, never narrated as a success.",
    objective: "File issues in juno-ai-labs/avalon when asked.",
    message: "Open an issue in juno-ai-labs/avalon titled \"Inbound email lease drops on retry\".",
    expected: {
      mustCall: [wireToolName("github", "create_issue")],
      forbidSuccessClaim: true,
    },
  },
  {
    id: "agentic/delegate_investigation",
    intent: "A broad read-only investigation is delegated rather than run inline.",
    objective: "Understand how the two regional Workers differ before the next migration.",
    message:
      "Investigate how the Global and EU Workers differ in configuration, and separately how their inbound email paths differ. Use a subagent for the investigation.",
    expected: {
      mustCall: [wireToolName("workstream", "run_subagent")],
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/durable_artifact",
    intent: "A requested durable artifact is created, not merely described in prose.",
    objective: "Capture decisions as durable artifacts in this work stream.",
    message: "Write up our model routing decision as an artifact titled \"Primary model selection\".",
    expected: {
      mustCall: [wireToolName("workstream", "create_artifact")],
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/connector_not_web",
    intent: "Named private workspace data comes from the authorized connector, never a web guess.",
    objective: "Report on the team's Linear backlog.",
    message: "What's the state of AVA-233 in Linear?",
    expected: {
      mustCall: [wireToolName("linear", "search_issues")],
      requireDiscoveryBeforeConnector: true,
      expectedStatus: "completed",
    },
  },
];

const DISCOVERY_TOOLS = new Set(["list_plugins", "search_plugins", "load_plugin"]);
const CONNECTOR_PREFIXES = ["github_", "linear_"];

/** Phrases that assert a completed write, used only when the write failed. */
const SUCCESS_CLAIM = /\b(created|opened|filed|submitted)\b[^.]*\b(issue|ticket)\b/i;

export interface AgenticVerdict {
  passed: boolean;
  actual: string;
  expected: string;
  note?: string;
}

export function gradeAgenticCase(
  expectation: AgenticExpectation,
  outcome: HarnessOutcome,
  events: HarnessEvent[],
): AgenticVerdict {
  const called = events
    .filter((event): event is Extract<HarnessEvent, { type: "tool_started" }> => event.type === "tool_started")
    .map((event) => event.toolName);
  const trajectory = called.join(" → ") || "(no tool calls)";
  const failures: string[] = [];

  for (const required of expectation.mustCall ?? []) {
    if (!called.includes(required)) failures.push(`never called ${required}`);
  }
  for (const forbidden of expectation.mustNotCall ?? []) {
    if (called.includes(forbidden)) failures.push(`called ${forbidden}, which is not permitted here`);
  }
  for (const [before, after] of expectation.order ?? []) {
    const firstBefore = called.indexOf(before);
    const firstAfter = called.indexOf(after);
    if (firstAfter !== -1 && (firstBefore === -1 || firstBefore > firstAfter)) {
      failures.push(`called ${after} before ${before}`);
    }
  }
  if (expectation.requireDiscoveryBeforeConnector) {
    const firstConnector = called.findIndex((name) => CONNECTOR_PREFIXES.some((prefix) => name.startsWith(prefix)));
    const firstDiscovery = called.findIndex((name) => DISCOVERY_TOOLS.has(name));
    if (firstConnector !== -1 && (firstDiscovery === -1 || firstDiscovery > firstConnector)) {
      failures.push("used a deferred connector tool without discovering or loading it first");
    }
  }
  if (expectation.expectedStatus && outcome.status !== expectation.expectedStatus) {
    failures.push(`run ended ${outcome.status}, wanted ${expectation.expectedStatus}`);
  }
  if (expectation.forbidSuccessClaim) {
    const toolFailed = events.some((event) => event.type === "tool_failed");
    if (toolFailed && SUCCESS_CLAIM.test(outcome.content)) {
      failures.push("claimed the write succeeded after the tool call failed");
    }
  }

  const verdict: AgenticVerdict = {
    passed: failures.length === 0,
    actual: trajectory,
    expected: describeExpectation(expectation),
  };
  return failures.length === 0 ? verdict : { ...verdict, note: failures.join("; ") };
}

function describeExpectation(expectation: AgenticExpectation): string {
  const parts: string[] = [];
  if (expectation.mustCall?.length) parts.push(`calls ${expectation.mustCall.join(" + ")}`);
  if (expectation.mustNotCall?.length) parts.push(`avoids ${expectation.mustNotCall.join(" + ")}`);
  if (expectation.requireDiscoveryBeforeConnector) parts.push("discovery before connector use");
  if (expectation.order?.length) {
    parts.push(expectation.order.map(([before, after]) => `${before} before ${after}`).join(", "));
  }
  if (expectation.expectedStatus) parts.push(`ends ${expectation.expectedStatus}`);
  if (expectation.forbidSuccessClaim) parts.push("no fabricated success");
  return parts.join("; ");
}
