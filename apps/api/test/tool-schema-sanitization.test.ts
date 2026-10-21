import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { asUserId } from "@rally/contracts";

import {
  droppedNullableBranches,
  nonObjectRootSchema,
  nonObjectRootUnionBranches,
  runHarness,
  weakenedCompositionBranches,
} from "@rally/agent-harness";
import { __integrationTesting } from "../src/services/integrations";
import { createTestEnv } from "./helpers/cloudflare-test";
import { createTestConnectorRegistry } from "./helpers/connector-registry";
import { authorsNullBranch, everyConnectorCursor } from "./helpers/connector-cursors";
import { everyAuthoredToolSchema } from "./helpers/authored-tool-schemas";
import { providerRequestView, providerStreamResponse } from "@rally/agent-harness/test-support/responses-stream";

/**
 * Every authored tool schema, walked from the registries rather than listed by
 * hand, against the sanitizer that actually rewrites it on the way to the
 * provider.
 *
 * Two separate defects, both introduced by one line on `memory_search`:
 *
 *   oneOf: [{ required: ["query"] }, { required: ["memoryItemId"] }]
 *
 * **The fatal one.** A root-level union branch that xAI cannot read as an
 * object is a hard 400 covering the whole request, every tool — measured
 * against grok-4.3/4.5/4.6. For three days every x-ai call in the fleet failed:
 * default routes paid a dead round trip and fell back to Gemini, so the fleet
 * looked healthy, and a work stream pinned to Grok from the composer's model
 * picker had nowhere to fall back to and simply died. The sanitizer is not what
 * made it fatal — the *authored* branches fail identically, because a bare
 * `{ required: [...] }` is no more an object to xAI than the `{}` the sanitizer
 * leaves. Only the root matters; the same union nested under a property is
 * accepted by all nine models tested.
 *
 * **The silent one.** A tool schema is not what Avalon wrote — it is what Bind's
 * sanitizer emits. It prunes each branch's `required` against a `properties`
 * map those branches do not have, so what reached the wire was `oneOf: [{}, {}]`
 * and the constraint was gone on *every* provider, Gemini and OpenAI included.
 * They accept it without complaint and let the model send both parameters or
 * neither.
 *
 * Nothing caught either one, because the authored schema reads correctly and no
 * test had ever run one through the sanitizer. Walking the registries is what
 * makes this a standing guard rather than a snapshot: a tool added next year
 * fails here until its wire schema survives the trip, and it fails at
 * `pnpm test` rather than three days later in a payload log.
 */
describe("tool schema sanitization", () => {
  it.each(["OpenRouter", "Azure"])("preserves the complete Gmail argument contract through the actual %s request", async (provider) => {
    const adapter = createTestConnectorRegistry().get("google");
    const casesForTool = (name: string): Array<{ label: string; args: unknown; accepted: boolean; schemaAccepted?: boolean }> => {
      const reply = name === "gmail.reply" || name === "gmail.create_reply_draft";
      const base = reply ? { query: "from:sender@example.com subject:Renewal after:2026/10/20", body: "Hello." } : { to: ["recipient@example.com"], subject: "A new conversation", body: "Hello." };
      return [
        { label: "minimal", args: base, accepted: true },
        { label: "rich", args: { ...base, bcc: ["hidden@example.com"], cc: null, htmlBody: "<b>Hello</b>", includeSignature: true, attachments: [{ filename: "report.pdf", mimeType: "application/pdf", content: "JVBERi0=" }] }, accepted: true },
        { label: "invalid BCC", args: { ...base, bcc: ["invalid"] }, accepted: false },
        { label: "invalid address", args: { ...base, to: ["invalid"] }, accepted: false },
        { label: "long body", args: { ...base, body: "a".repeat(500_001) }, accepted: false },
        { label: "old discriminated message", args: { message: { kind: reply ? "reply" : "new", ...base } }, accepted: false },
        ...["kind", "preview", "threadId", ...reply ? [] : ["messageId"], "inReplyTo", "references", "arbitrary"].map((field) => ({ label: `undeclared ${field}`, args: { ...base, [field]: field === "preview" ? true : "undeclared" }, accepted: false })),
        { label: "invalid attachment bytes", args: { ...base, attachments: [{ filename: "report.pdf", mimeType: "application/pdf", content: "not base64" }] }, accepted: false },
        { label: "undeclared attachment field", args: { ...base, attachments: [{ filename: "report.pdf", mimeType: "application/pdf", content: "JVBERi0=", preview: true }] }, accepted: false },
        ...(reply ? [{ label: "exact message ID", args: { body: "Hello.", messageId: "18f0a2c4d5e6f702" }, accepted: true }, { label: "both selectors", args: { ...base, messageId: "18f0a2c4d5e6f702" }, accepted: false, schemaAccepted: true }, { label: "no query", args: { body: "Hello." }, accepted: false, schemaAccepted: true }, { label: "reply subject override", args: { ...base, subject: "Unrelated subject" }, accepted: false }] : [{ label: "no recipients", args: { ...base, to: [] }, accepted: false }, { label: "query on new mail", args: { ...base, query: "subject:Renewal" }, accepted: false }]),
      ];
    };
    const mailWrites = adapter.agentPlugin.tools.filter((tool) => ["gmail.send", "gmail.create_draft", "gmail.reply", "gmail.create_reply_draft"].includes(tool.name));
    expect(mailWrites.map((tool) => tool.name)).toEqual(["gmail.create_draft", "gmail.send", "gmail.create_reply_draft", "gmail.reply"]);
    const requests: Array<{ tools: Array<{ function: { name: string; parameters: Record<string, unknown>; strict?: boolean } }> }> = [];
    const urls: string[] = [];
    const usesAzure = provider === "Azure";
    // Only the remote model is doubled. The real harness builds the plugin,
    // runs Bind's sanitizer and root repair, then serializes the HTTP request.
    const outcome = await runHarness({
      config: {
        apiKey: "test-key", primaryModel: usesAzure ? "openai/gpt-5.6-sol" : "test/schema-contract",
        maxIterations: 1, maxToolCalls: 1,
        ...(usesAzure ? { azure: { endpoint: "https://schema-probe.openai.azure.com", apiKey: "test-azure-key" } } : {}),
        // Ambient budgets, not the subject of this test.
        maxWallClockMs: 120_000, toolTimeoutMs: 30_000, maxWebResults: 1,
        fetch: async (input, init) => {
          urls.push(String(input));
          requests.push(providerRequestView<typeof requests[number]>(JSON.parse(String(init?.body))));
          return providerStreamResponse(input, [
            { choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
          ]);
        },
      },
      resolveAzureModelPricing: async () => new Map([["openai/gpt-5.6-sol", {
        inputUsdPerM: 5, cachedInputUsdPerM: 0.5, outputUsdPerM: 25,
        overrides: [], sourceFingerprint: "schema-contract-test",
      }]]),
      workspaceId: `schema-contract-${provider}`, workstreamId: "schema-contract-workstream",
      loopId: "schema-contract-run", harnessRunId: "schema-contract-run",
      executionPrincipal: { type: "user", userId: asUserId("00000000-0000-4000-8000-000000000001") },
      systemPrompt: "Describe the available tools without calling them.",
      messages: [{ role: "user", content: "Describe the available tools." }],
      corePlugins: [{
        canonicalId: "rally:google", modelId: "rally_google", shortWireName: "google",
        description: "Google Mail", preload: true, explicit: false,
        tools: mailWrites.map((definition) => ({
          definition,
          execute: async () => { throw new Error("This schema probe must never execute a mail tool"); },
        })),
      }],
      onAssistantTurnReserved: ({ modelTurnIndex }) => ({ transcriptSequence: modelTurnIndex }),
      onStepSettled: () => ({ transitions: [], stop: false }),
      onEvent: () => {},
    });
    expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
    expect(urls).toEqual([usesAzure
      ? "https://schema-probe.openai.azure.com/openai/v1/chat/completions"
      : "https://openrouter.ai/api/v1/responses"]);
    expect(requests).toHaveLength(1);
    // Zod's fromJSONSchema ignores maxProperties. A JSON Schema validator must
    // judge the actual payload, or a closure regression can pass unnoticed.
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    for (const tool of mailWrites) {
      const authoredSchema = ajv.compile(tool.inputSchema);
      const wireTool = requests[0]!.tools.find((candidate) => candidate.function.name === `google_${tool.name.replaceAll(".", "_")}`)!.function;
      // These are ordinary Chat Completions tools, not strict structured output.
      expect(wireTool.strict).toBeUndefined();
      const wireSchema = ajv.compile(wireTool.parameters);
      // Target exclusivity is an executor refinement, as required by the
      // cross-provider plain-object schema contract. Unknown-key closure must
      // agree in both authored and serialized schemas.
      for (const { label, args, accepted, schemaAccepted = accepted } of casesForTool(tool.name)) {
        expect(adapter.validateToolInput?.(tool.name, args) === null, `${tool.name}: ${label}, executor`).toBe(accepted);
        expect(authoredSchema(args), `${tool.name}: ${label}, authored`).toBe(schemaAccepted);
        expect(wireSchema(args), `${tool.name}: ${label}, ${provider} HTTP payload`).toBe(schemaAccepted);
      }

    }
  });

  it("walks every authored surface, including the conditional and hand-assembled ones", () => {
    // `everyAuthoredToolSchema` throws when the walk stops reaching a surface,
    // so every check below carries the completeness guarantee too; this names
    // it, so a failure there reads as coverage rather than schema.
    expect(everyAuthoredToolSchema().length).toBeGreaterThan(60);
  });

  it("leaves no tool whose root union has a branch xAI cannot read as an object", () => {
    const rejected = everyAuthoredToolSchema().flatMap(({ name, schema }) =>
      nonObjectRootUnionBranches(schema).map((path) => `${name}: ${path}`));

    expect(rejected).toEqual([]);
  });

  it("leaves no tool whose root is not a plain object schema", () => {
    const rejected = everyAuthoredToolSchema().flatMap(({ name, schema }) =>
      nonObjectRootSchema(schema).map((path) => `${name}: ${path}`));

    expect(rejected).toEqual([]);
  });

  it("delivers the null branch every connector cursor authors, in the one spelling that survives", () => {
    // The fix these carry is that "no cursor" is expressible as a value. It is
    // expressible only if the cursor authors a null branch AND that branch
    // reaches the model, so both halves are asserted here.
    //
    // `droppedNullableBranches` alone covers only the second. It reports a
    // declaration whose authored null the sanitizer dropped, so a cursor
    // rewritten to a plain `{ type: "string" }` reports nothing at all and
    // sails through: first-page `null` forbidden outright, guard green. The
    // authored check below is what closes that, and it is the failure mode this
    // suite exists to catch rather than a hypothetical one.
    //
    // The sanitizer half stays even though `@juno-ai/bind` 14 delivers both
    // spellings. Under bind 13 it collapsed `type: ["string", "null"]` to
    // `type: "string"` and moved the nullability into the description, a
    // schema forbidding the value beside prose permitting it, which is the
    // conflict the fix exists to end, and a bind release that went back to
    // that would put the conflict on the wire again with nothing else changed
    // here. Written as an assertion because two automated reviews read the two
    // spellings as equivalent, which is what a reviewer's head is bad at and a
    // test is good at.
    //
    // Every connector, not Google's four: a cursor is a cursor whichever
    // adapter serves it, and the assertion this widened from could pass while
    // eighteen cursors on five other connectors stayed collapsed.
    //
    // Which properties are cursors, and how one is read, come from
    // `helpers/connector-cursors.ts` — shared with the sweep that guards the
    // other half of the contract, because two copies kept in step by hand
    // diverged on the first edit that touched only one.
    const cursors = everyConnectorCursor();
    // The exact population, per connector. A floor was the first shape of this
    // and it had three cursors of slack in it: one connector could lose its
    // coverage entirely while the total still cleared the bound. An exact map
    // costs one edit when a paginated tool is added, which is the point — that
    // edit is where somebody states the new tool is meant to be covered.
    expect(Object.fromEntries(
      [...new Set(cursors.map(({ connector }) => connector))].sort()
        .map((connector) => [connector, cursors.filter((c) => c.connector === connector).length]),
    )).toEqual({ google: 5, granola: 2, linear: 4, notion: 3, slack: 5, x: 4 });
    expect(cursors.flatMap(({ connector, tool, cursor }) => {
      const where = `${connector}.${tool.name}.${cursor}`;
      if (!authorsNullBranch(tool, cursor)) return [`${where}: authors no null branch`];
      // Filtered to the cursor itself, because this assertion is the cursor
      // contract and names a cursor when it fails. Every other property on
      // every tool is the registry-wide assertion below.
      return droppedNullableBranches(tool.inputSchema as Record<string, unknown>)
        .filter((finding) => finding.startsWith(`${cursor}: `))
        .map((finding) => `${where.slice(0, where.lastIndexOf("."))}.${finding}`);
    })).toEqual([]);
  });

  it("delivers every authored null branch, on every tool, in either spelling", () => {
    // Every declaration of every authored tool, not only the cursors. Until
    // `@juno-ai/bind` 14 this could not hold: the sanitizer collapsed the flat
    // `type: ["string", "null"]` to `type: "string"`, 28 parameters across four
    // connectors were declared that way, and the guard above was filtered to
    // cursors so it would not fail for them. What that cost is on record:
    // `send_message.thread_ts` was one of the 28, and a scheduled Sidekick
    // invented values for it for thousands of refused calls or replied to its
    // own previous post (the 2026-09-11 entry in `docs/agent-tools.md`, and
    // the Sidekick delivery PRD's `research.md`). Bind 14 rewrites that
    // declaration to `anyOf` with a null branch,
    // so the whole registry is now asserted, nested declarations included
    // (`droppedNullableBranches` walks `items`, `$defs` and composition
    // branches and names each finding by its dotted path), and a bind release
    // that collapsed again fails here naming the tool and the parameter rather
    // than in a channel.
    //
    // The residue is asserted exactly rather than as zero. Bind 14 rewrites a
    // nullable SINGLE type; a genuine multi-type union with `null` still
    // collapses, because no union of scalar branches has been measured
    // accepted by every provider. Three authored declarations are that shape
    // and are listed by name: a Sheets cell is a string, number, boolean or
    // null, and an artifact query parameter is a string, number or null. A
    // new entry here is a new parameter the model cannot say "none" to, and
    // it needs a spelling of its own or a measured union shape; an entry that
    // disappears is one Bind started delivering, and the list shrinks with it.
    const dropped = everyAuthoredToolSchema().flatMap(({ name, schema }) =>
      droppedNullableBranches(schema).map((finding) => `${name}: ${finding}`));

    expect(dropped).toEqual([
      "workstream.artifacts.query:query_artifact_data: params.items: authored-null-branch-not-delivered",
      "google.sheets.update_values: values.items.items: authored-null-branch-not-delivered",
      "google.sheets.append_values: values.items.items: authored-null-branch-not-delivered",
    ]);
  });

  it("leaves no tool with a composition branch the sanitizer strips a constraint from", () => {
    const weakened = everyAuthoredToolSchema().flatMap(({ name, schema }) =>
      weakenedCompositionBranches(schema).map((path) => `${name}: ${path}`));

    expect(weakened).toEqual([]);
  });
});

/**
 * The schemas Avalon does not author, and the only ones a build-time guard can
 * never see: a hosted MCP server's `inputSchema` arrives at run time and reaches
 * the model verbatim. The blast radius is worse than a first-party mistake,
 * because xAI rejects the whole request — one bad schema from one remote server
 * takes down a run's every other tool, Avalon's core tools included — and the
 * person who connected that server did nothing wrong.
 *
 * So the rule the guard above reports on is applied here as a repair, at
 * Avalon's own host-side gate over dynamic tools rather than inside a connector
 * adapter, and every dynamic source (Slack, Granola, Notion) funnels through it.
 */
describe("dynamic connector tool schemas", () => {
  const dynamicAdapter = () => {
    const registry = createTestConnectorRegistry();
    const adapter = registry.get("notion");
    const capability = adapter.dynamicAgentTools?.capabilities[0];
    if (!capability) throw new Error("expected Notion to declare a dynamic capability");
    return { adapter, capability };
  };

  const validate = (inputSchema: Record<string, unknown>) => {
    const { adapter, capability } = dynamicAdapter();
    return __integrationTesting.validateDynamicConnectorTools(
      createTestEnv({}),
      adapter,
      "personal",
      [capability],
      "notion",
      [{
        name: "remote_tool",
        description: "A tool served by a third-party MCP server.",
        capability,
        mode: "write",
        idempotency: "record_before_execute",
        inputSchema,
      }],
    )[0]!.inputSchema as Record<string, unknown>;
  };

  it("lets nothing a remote server serves reach the wire in a shape Grok rejects", () => {
    // Asserted as an outcome rather than a mechanism, because the mechanism has
    // already moved once. Under bind 11 and 12 this gate had to drop the
    // composition itself; under bind 13 it defers, because the sanitizer
    // repairs the shape into readable branches and *keeps* the constraint,
    // which dropping it would have thrown away. What must hold either way is
    // that the schema reaching the provider has no unreadable root branch.
    for (const remote of [
      // The ordinary "exactly one of these" idiom.
      {
        type: "object",
        properties: { pageId: { type: "string" }, discussionId: { type: "string" } },
        oneOf: [{ required: ["pageId"] }, { required: ["discussionId"] }],
      },
      // Annotation-only branches.
      {
        type: "object",
        properties: { a: { type: "string" } },
        anyOf: [{ description: "choose a" }, { description: "or not" }],
      },
      // A branch whose own `type` contradicts its `properties`.
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        oneOf: [
          { type: "string", properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      },
      // A branch carrying its own composition.
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        oneOf: [
          { type: "object", anyOf: [{ properties: { a: { type: "string" } } }] },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      },
    ]) {
      expect(nonObjectRootUnionBranches(validate(remote))).toEqual([]);
    }
  });

  it("flattens an object-branched root union rather than leaving it, because Azure rejects it too", () => {
    // This case inverted. An object-branched root union satisfies xAI's rule
    // and was deliberately left alone; Azure OpenAI rejects a root combinator
    // whatever its branches look like, so it now has to be merged. Every
    // property survives — deleting the union, which is what the corrector used
    // to do, would leave a tool with no parameters at all.
    const schema = {
      anyOf: [
        { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] },
        { type: "object", properties: { cursor: { type: "string" } }, required: ["cursor"] },
      ],
    };

    expect(validate(schema)).toEqual({
      type: "object",
      properties: { pageId: { type: "string" }, cursor: { type: "string" } },
    });
  });

  it("lets nothing a remote server serves reach the wire in a shape Azure rejects", () => {
    for (const remote of [
      { anyOf: [{ type: "object", properties: { a: { type: "string" } } }] },
      { type: "object", properties: { a: { type: "string" } }, oneOf: [{ required: ["a"] }] },
      { type: "object", properties: { a: { type: "string" } }, allOf: [{ required: ["a"] }] },
      { properties: { a: { type: "string" } } },
      { type: "string" },
    ]) {
      expect(nonObjectRootSchema(validate(remote))).toEqual([]);
    }
  });

  it("leaves an ordinary remote object schema untouched", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };

    expect(validate(schema)).toEqual(schema);
  });
});
