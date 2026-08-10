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
 *
 * The surface and the case weighting are taken from the 305 tool invocations
 * recorded in the Global production database rather than from the repository.
 * That ledger changed the suite in three ways:
 *
 * - Google Drive search is the single dominant call at 173 of 305 invocations,
 *   with Gmail search and read next. None of it was represented before, and it
 *   is now the most heavily weighted connector path here.
 * - The always-loaded surface is wider than the suite modelled. Production runs
 *   call `table_query`, `table_search`, `workstream_read`, `web_search`, and
 *   `web_fetch`, all from preloaded plugins, so `avalon:tables` and `avalon:web`
 *   are now part of the stand-in surface.
 * - Two stand-in names did not exist in the product. Durable memory is written
 *   with `memory_add`, not `memory_write`, and the GitHub and Linear connectors
 *   expose `github_issues_create`, `github_repositories_list`, and
 *   `linear_create_issue` rather than the invented `*_search_issues` pair.
 *
 * Failures are modelled from the ledger too: the real failed invocations are
 * concentrated in connector writes and searches, which is why the fabricated
 * success case is a connector write that fails.
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

const QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { query: { type: "string" } },
  required: ["query"],
} as const;

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
        result: { nowIso: "2026-08-10T09:15:00.000Z", timezone: "America/Los_Angeles" },
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
    canonicalId: "avalon:tables",
    modelId: "avalon_tables",
    shortWireName: "table",
    description:
      "Query and maintain large typed durable collections authorized for this run without loading them into context.",
    systemMessage:
      "Use durable tables for large or evolving structured collections such as seen-item ledgers, watchlists, and per-resource status. Describe or query a table before changing it, and read only the matching rows and needed columns.",
    preload: true,
    explicit: true,
    tools: [
      {
        name: "query",
        description: "Query rows from an authorized durable table with typed filters.",
        capability: "table.query",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { tableId: { type: "string" }, filter: { type: "string" } },
          required: ["tableId"],
        },
        result: {
          rows: [{ fileId: "drive-8842", title: "Northwind discovery call — Transcript", processedAt: "2026-08-09T18:02:00.000Z" }],
        },
      },
      {
        name: "search",
        description: "Full-text search the rows of an authorized durable table.",
        capability: "table.search",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { tableId: { type: "string" }, query: { type: "string" } },
          required: ["tableId", "query"],
        },
        result: { rows: [], tables: [{ tableId: "tbl-transcripts", purpose: "Transcripts already turned into reports" }] },
      },
    ],
  },
  {
    canonicalId: "avalon:memory",
    modelId: "avalon_memory",
    shortWireName: "memory",
    description: "Search and maintain durable memory authorized for this run.",
    systemMessage:
      "Search memory before writing so you update or invalidate an existing fact instead of duplicating it. Choose the narrowest durable scope.",
    preload: true,
    explicit: true,
    tools: [
      {
        name: "search",
        description: "Search durable memory before writing to it.",
        capability: "memory.search",
        mode: "read",
        idempotency: "safe",
        inputSchema: QUERY_SCHEMA as unknown as Record<string, unknown>,
        result: { entries: [] },
      },
      {
        name: "add",
        description: "Add one durable memory entry in the narrowest applicable scope.",
        capability: "memory.add",
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
    description: "Read and update the current work stream, its resources, artifacts, and execution lifecycle.",
    systemMessage: "Use these tools only for the current authorized work stream and its attached resources.",
    preload: true,
    explicit: true,
    tools: [
      {
        name: "read",
        description: "Read the current work stream, its objective, and its attached resources.",
        capability: "workstream.read",
        mode: "read",
        idempotency: "safe",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        result: {
          title: "Atlas UX/quality of life",
          resources: [{ id: "res-221", kind: "text", name: "review-session-transcript.txt" }],
        },
      },
      {
        name: "create_artifact",
        description: "Create a durable artifact in this work stream.",
        capability: "artifact.create",
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
        capability: "subagent.run",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { objective: { type: "string" } },
          required: ["objective"],
        },
        result: { findings: "Draft state is held in component memory and is discarded when the route unmounts." },
      },
    ],
  },
  {
    canonicalId: "avalon:web",
    modelId: "avalon_web",
    shortWireName: "web",
    description: "Search and read current public-web sources.",
    systemMessage:
      "Use web_search only for public information; use authorized connector plugins for private workspace data. Follow promising results with web_fetch before relying on their contents.",
    preload: true,
    tools: [
      {
        name: "search",
        description: "Search the public web for current information.",
        capability: "web.search",
        mode: "read",
        idempotency: "safe",
        inputSchema: QUERY_SCHEMA as unknown as Record<string, unknown>,
        result: {
          results: [
            { title: "Agent product pricing, August 2026", url: "https://example.com/pricing-2026" },
            { title: "Seat plus metered usage explained", url: "https://example.com/metered" },
          ],
        },
      },
      {
        name: "fetch",
        description: "Fetch and read one public web page found through search.",
        capability: "web.fetch",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { url: { type: "string" } },
          required: ["url"],
        },
        result: { text: "Most vendors anchor at $20 per seat and meter usage above an included allowance." },
      },
    ],
  },
  {
    canonicalId: "connection:google",
    modelId: "plugin_google",
    shortWireName: "google",
    description: "Authorized Google connector for Drive files, Docs, and Gmail messages.",
    systemMessage:
      "Use the authorized Google connector for workspace files and mail; never substitute public web results for it.",
    preload: false,
    tools: [
      {
        name: "drive_search",
        description: "Search Google Drive files the connection is authorized to read.",
        capability: "google.drive_search",
        mode: "read",
        idempotency: "safe",
        inputSchema: QUERY_SCHEMA as unknown as Record<string, unknown>,
        result: {
          files: [
            { id: "drive-8842", name: "Northwind discovery call - 2026/08/07 - Transcript", mimeType: "application/vnd.google-apps.document" },
            { id: "drive-9013", name: "Contoso discovery call - 2026/08/09 - Transcript", mimeType: "application/vnd.google-apps.document" },
          ],
        },
      },
      {
        name: "gmail_search",
        description: "Search Gmail threads the connection is authorized to read.",
        capability: "google.gmail_search",
        mode: "read",
        idempotency: "safe",
        inputSchema: QUERY_SCHEMA as unknown as Record<string, unknown>,
        result: {
          messages: [
            { id: "msg-4471", subject: "Signature requested — advisory agreement (due Friday)", unread: true },
            { id: "msg-4472", subject: "Reach new customers with up to $1500 in ad credit", unread: true },
          ],
        },
      },
      {
        name: "gmail_read_message",
        description: "Read the full body of one Gmail message by identifier.",
        capability: "google.gmail_read_message",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { messageId: { type: "string" } },
          required: ["messageId"],
        },
        result: {
          from: "Northwind eSign <no-reply@northwind-esign.example>",
          body: "Please review and sign the attached agreement by Friday 14 August.",
        },
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
        name: "repositories_list",
        description: "List repositories the installation is authorized to read.",
        capability: "github.repositories_list",
        mode: "read",
        idempotency: "safe",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        result: {
          repositories: [
            { fullName: "northwind-labs/atlas", private: true },
            { fullName: "northwind-labs/orbit", private: true },
          ],
        },
      },
      {
        name: "issues_create",
        description: "Open one issue in an authorized repository.",
        capability: "github.issues_create",
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
    description: "Authorized Linear connector for issues, projects, and teams.",
    preload: false,
    tools: [
      {
        name: "create_issue",
        description: "Create one Linear issue in an authorized team.",
        capability: "linear.create_issue",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { teamId: { type: "string" }, title: { type: "string" }, description: { type: "string" } },
          required: ["teamId", "title"],
        },
        result: { identifier: "ATL-12", url: "https://linear.example/northwind-labs/issue/ATL-12" },
      },
      {
        name: "list_teams",
        description: "List Linear teams the connection is authorized to use.",
        capability: "linear.list_teams",
        mode: "read",
        idempotency: "safe",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        result: { teams: [{ id: "team-atlas", key: "ATL", name: "Atlas" }] },
      },
    ],
  },
  {
    canonicalId: "connection:slack",
    modelId: "plugin_slack",
    shortWireName: "slack",
    description: "Authorized Slack connector for reading and posting workspace messages.",
    preload: false,
    tools: [
      {
        name: "send_message",
        description: "Post one message to an authorized Slack channel.",
        capability: "slack.send_message",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { channel: { type: "string" }, text: { type: "string" } },
          required: ["channel", "text"],
        },
        result: { ts: "1754852100.001900", delivered: true },
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
    id: "agentic/drive_search",
    intent:
      "Drive search is the single most-used tool in production; a question about workspace files must reach the connector.",
    objective: "Keep the team's discovery-call material organised and answerable.",
    message: "What transcripts do we have in drive?",
    expected: {
      mustCall: [wireToolName("google", "drive_search")],
      requireDiscoveryBeforeConnector: true,
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/connector_not_web",
    intent:
      "Private workspace data comes from the authorized connector; the public web is not a substitute even when it would answer faster.",
    objective: "Report on the team's Drive contents when asked.",
    message:
      "Use the connected Google Drive to search for files containing transcript. Use the Drive connector, not public web search. Return file titles only and do not modify anything.",
    expected: {
      mustCall: [wireToolName("google", "drive_search")],
      mustNotCall: [wireToolName("web", "search")],
      requireDiscoveryBeforeConnector: true,
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/mail_triage_ordering",
    intent:
      "The live morning-digest automation searches mail and then reads a specific message; reading requires an identifier search supplies.",
    objective: "Every morning, review unread mail and surface the items that need a reply.",
    message: "Check my unread mail and tell me which single message actually needs an answer today, and why.",
    expected: {
      mustCall: [wireToolName("google", "gmail_search"), wireToolName("google", "gmail_read_message")],
      order: [[wireToolName("google", "gmail_search"), wireToolName("google", "gmail_read_message")]],
      requireDiscoveryBeforeConnector: true,
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/authoritative_time",
    intent: "Relative dates must come from core_current_time, not from transcript timestamps.",
    objective: "Track release timing for the desktop app.",
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
      mustCall: [wireToolName("memory", "search"), wireToolName("memory", "add")],
      order: [[wireToolName("memory", "search"), wireToolName("memory", "add")]],
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/table_ledger_before_work",
    intent:
      "An automation with a seen-item ledger must consult the table before treating anything as new, which is how repeat runs avoid duplicate reports.",
    objective:
      "Analyze new discovery call transcripts from Drive and generate one report per transcript. The table tbl-transcripts records every transcript already reported on.",
    message: "Run the hourly pass: work out which transcripts we have not reported on yet. Do not write anything.",
    expected: {
      mustCall: [wireToolName("table", "query"), wireToolName("google", "drive_search")],
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/table_discovery",
    intent: "Finding which durable table holds a collection is a search over tables, not a guess at an identifier.",
    objective: "Maintain the durable ledgers backing this workspace's automations.",
    message: "Search our durable tables for anything tracking processed transcripts, and tell me what you find.",
    expected: {
      mustCall: [wireToolName("table", "search")],
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/read_workstream_context",
    intent: "A question about attached resources is answered from the work stream, not from the prompt alone.",
    objective: "Capture and act on product feedback collected in this work stream.",
    message: "What resources are attached to this workstream right now?",
    expected: {
      mustCall: [wireToolName("workstream", "read")],
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/elicit_missing_identifier",
    intent:
      "A missing required identifier blocks on one structured question instead of a guess; this is the shape of the only real elicitation in production.",
    objective: "Collect customer discovery calls and turn them into a feedback dashboard.",
    message: "I want to collect some of the customer discovery calls we've had and analyze them and create a dashboard of feedback",
    expected: {
      mustCall: [wireToolName("core", "request_elicitation")],
      mustNotCall: [wireToolName("workstream", "create_artifact")],
      expectedStatus: "needs_input",
    },
  },
  {
    id: "agentic/no_fabricated_write",
    intent: "A failed provider write must be reported, never narrated as a success.",
    objective: "File issues in northwind-labs/atlas when asked.",
    message: "Open an issue in northwind-labs/atlas titled \"Draft text is lost when navigating away\".",
    expected: {
      mustCall: [wireToolName("github", "issues_create")],
      forbidSuccessClaim: true,
    },
  },
  {
    id: "agentic/repository_listing",
    intent: "Naming the authorized repositories is a connector read, not recall from the system prompt.",
    objective: "Report on the team's GitHub estate.",
    message: "Which repositories do you actually have access to?",
    expected: {
      mustCall: [wireToolName("github", "repositories_list")],
      requireDiscoveryBeforeConnector: true,
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/tracker_issue_creation",
    intent:
      "Creating a tracker issue is the most common successful connector write in production, and it needs the team the connector reports.",
    objective: "Turn confirmed product feedback into tracked work.",
    message: "create a linear issue for the draft-persistence bug, in whichever team you're authorized for",
    expected: {
      mustCall: [wireToolName("linear", "list_teams"), wireToolName("linear", "create_issue")],
      order: [[wireToolName("linear", "list_teams"), wireToolName("linear", "create_issue")]],
      requireDiscoveryBeforeConnector: true,
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/delegate_investigation",
    intent: "A broad read-only investigation is delegated rather than run inline.",
    objective: "Understand why draft text is lost before committing to a fix.",
    message:
      "Investigate how draft state is held while a work stream is open, and separately how navigation unmounts it. Use a subagent for the investigation.",
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
    id: "agentic/public_research",
    intent:
      "Public market information is the one case that belongs on the web, and a promising result is read before it is relied on.",
    objective: "Track how comparable products are priced.",
    message:
      "give me a wide landscape of different ways people have mixed or not mixed per seat and usage in quota subscription based pricing for modern products that integrate AI deeply.",
    expected: {
      mustCall: [wireToolName("web", "search"), wireToolName("web", "fetch")],
      order: [[wireToolName("web", "search"), wireToolName("web", "fetch")]],
      expectedStatus: "completed",
    },
  },
  {
    id: "agentic/slack_reply",
    intent: "A message the user asks to be posted goes through the connector rather than being drafted in the reply.",
    objective: "Keep the team channel updated on release status.",
    message: "post a note in #product saying the release build is up and ready to try",
    expected: {
      mustCall: [wireToolName("slack", "send_message")],
      requireDiscoveryBeforeConnector: true,
      expectedStatus: "completed",
    },
  },
];

const DISCOVERY_TOOLS = new Set(["list_plugins", "search_plugins", "load_plugin"]);
const CONNECTOR_PREFIXES = ["github_", "linear_", "google_", "slack_"];

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
