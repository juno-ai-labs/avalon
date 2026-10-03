import {
  AbandonDemoOperationInputSchema,
  AdvertisedDemoScenarioRefSchema,
  BUILTIN_DEMO_SCENARIO_ID,
  CreateDemoOrganizationInputSchema,
  DemoOperationRefSchema,
  ListDemoOperationsInputSchema,
  RetireDemoOrganizationInputSchema,
  RetryDemoOperationInputSchema,
  type DemoAdministrationActor,
  type DemoAdministrationResult,
} from "@rally/contracts/demo-administration";
import { DemoCastEntrySchema, IdSchema } from "@rally/contracts";
import { DemoPackShapeSchema } from "@rally/contracts/demo-pack";
import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AccessPrincipal } from "./access";
import type { Env } from "./env";

type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

const RoleSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u);
const CastSchema = z.record(RoleSchema, DemoCastEntrySchema).describe(
  "Who plays each part but the presenter: a colleague's userId from list_demo_cast_candidates, or { name } for a typed name played by a persona.",
);

/**
 * A tool's input as this server advertises it and accepts it.
 *
 * The SDK would otherwise validate arguments against the advertised Zod schema
 * and answer a mismatch with Zod's own messages, which can quote what the
 * caller sent (an unknown key's name, for one). This hands the SDK the JSON
 * Schema to advertise and lets every argument through untouched; the
 * `DemoAdministration` entrypoint parses it and refuses by code, with a
 * sentence that quotes nothing.
 */
function advertised(schema: z.ZodType): StandardSchemaWithJSON<Record<string, unknown>> {
  const jsonSchema = (options: { target: string }) => z.toJSONSchema(schema, {
    target: options.target === "draft-07" ? "draft-7" : options.target === "openapi-3.0" ? "openapi-3.0" : "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return {
    "~standard": {
      version: 1,
      vendor: "rally",
      validate: (value: unknown) => ({
        value: value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {},
      }),
      jsonSchema: { input: jsonSchema, output: jsonSchema },
    },
  };
}

function actorOf(principal: AccessPrincipal): DemoAdministrationActor {
  return { subject: principal.subject, email: principal.email };
}

/**
 * Run one tool through the entrypoint and render its envelope. A refusal is an
 * MCP error result whose text is the code, the sentence and any pack issues;
 * the log carries the actor, the tool, the ids it targeted and the code, never
 * the pack, the cast, a preview or a message.
 */
async function tool<T>(
  principal: AccessPrincipal,
  name: string,
  target: Record<string, string | undefined>,
  call: () => Promise<DemoAdministrationResult<T>>,
): Promise<ToolResult> {
  let result: DemoAdministrationResult<T>;
  try {
    result = await call();
  } catch (error) {
    // The binding itself failed: the API did not answer.
    console.error(JSON.stringify({
      event: "demo_mcp_tool_failed",
      actor_subject: principal.subject,
      actor_email: principal.email,
      tool: name,
      ...target,
      error_name: error instanceof Error ? error.name : typeof error,
      error_code: "regional_unavailable",
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ code: "regional_unavailable", message: "Rally's API did not answer. Try again in a moment." }, null, 2) }],
      isError: true,
    };
  }
  if (!result.ok) {
    console.error(JSON.stringify({
      event: "demo_mcp_tool_failed",
      actor_subject: principal.subject,
      actor_email: principal.email,
      tool: name,
      ...target,
      error_code: result.code,
    }));
    const failure = { code: result.code, message: result.message, ...(result.issues ? { issues: result.issues } : {}) };
    return { content: [{ type: "text", text: JSON.stringify(failure, null, 2) }], isError: true };
  }
  console.log(JSON.stringify({
    event: "demo_mcp_tool_succeeded",
    actor_subject: principal.subject,
    actor_email: principal.email,
    tool: name,
    ...target,
  }));
  return { content: [{ type: "text", text: JSON.stringify(result.value, null, 2) }] };
}

/** A target id for the log, only when the argument is one. */
function idOf(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && IdSchema.safeParse(value).success ? value : undefined;
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;

export function createDemoMcpServer(env: Env, principal: AccessPrincipal): McpServer {
  const server = new McpServer({ name: "Rally demos", version: "1.0.0" });
  const api = env.DEMO_ADMINISTRATION;
  const actor = actorOf(principal);

  server.registerTool("list_demo_scenarios", {
    description: "List the demo scenarios that can be used to create a demo Organization, with what each contains and how many seeded runs preparing it waits on. Use get_demo_scenario to read one's full content before editing it.",
    inputSchema: advertised(z.strictObject({})),
    annotations: READ,
  }, () => tool(principal, "list_demo_scenarios", {}, () => api.listScenarios({ actor, input: {} })));

  server.registerTool("get_demo_scenario", {
    description: `Read the full content of one scenario as a pack. Pass exactly one of scenarioId ("${BUILTIN_DEMO_SCENARIO_ID}") or revisionId (from a check, a create, or get_demo_operation's scenario). Edit the returned pack — rename the customer, change figures, drop or add rooms, Breakouts, documents or Sidekicks — and pass it to check_demo_scenario.`,
    inputSchema: advertised(z.strictObject({
      scenarioId: z.literal(BUILTIN_DEMO_SCENARIO_ID).optional(),
      revisionId: IdSchema.optional(),
    })),
    annotations: READ,
  }, (args) => tool(principal, "get_demo_scenario", { revision_id: idOf(args, "revisionId") }, () =>
    api.getScenario({ actor, input: args })));

  server.registerTool("check_demo_scenario", {
    description: "Check a pack without writing anything, and show it as the presenter will read it. Returns ok with the normalized pack (the presenter's expect derived when they never act), a summary and a Markdown preview; or ok false with every issue's path, code and what to change. Fix every issue and check again before creating a demo. Rally's seeded turns make no tool calls, so every fact Rally states must already be in that conversation's messages. Pass cast to preview with real names; the cast is checked as create would check it.",
    inputSchema: advertised(z.strictObject({
      pack: DemoPackShapeSchema,
      cast: CastSchema.optional(),
    })),
    annotations: READ,
  }, (args) => tool(principal, "check_demo_scenario", {}, () => api.checkScenario({ actor, input: args })));

  server.registerTool("list_demo_cast_candidates", {
    description: "List who can present a demo (members of the demo template), who can play a part (signed-in colleagues on the company's domain), and, given a scenario, the parts it needs cast. Use the userIds in create_demo_organization's presenterUserId and cast, or a { name } for somebody who is not a colleague.",
    inputSchema: advertised(z.strictObject({ scenario: AdvertisedDemoScenarioRefSchema.optional() })),
    annotations: READ,
  }, (args) => tool(principal, "list_demo_cast_candidates", {}, () => api.castCandidates({ actor, input: args })));

  server.registerTool("create_demo_organization", {
    description: "Create a new demo Organization (named <companyName>-demo) from a scenario and start preparing it. Returns at once with the operation's status; call get_demo_operation to follow it to Ready. Choose a requestKey (lower-case letters, digits, hyphens) per demo you mean: calling again with the same requestKey returns the same operation and never creates a second Organization, even after a lost response. The new Organization is owned by the presenter, seats the cast, and receives copies of the template's Google connections.",
    inputSchema: advertised(CreateDemoOrganizationInputSchema.extend({
      scenario: AdvertisedDemoScenarioRefSchema,
      cast: CastSchema,
    })),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args) => tool(principal, "create_demo_organization", { presenter_user_id: idOf(args, "presenterUserId") }, () =>
    api.createOrganization({ actor, input: args })));

  server.registerTool("list_demo_operations", {
    description: "List demo operations, newest first, with their status. Use it to find a demo you started earlier.",
    inputSchema: advertised(ListDemoOperationsInputSchema),
    annotations: READ,
  }, (args) => tool(principal, "list_demo_operations", {}, () => api.listOperations({ actor, input: args })));

  server.registerTool("get_demo_operation", {
    description: "Read one demo operation's progress. While it is running, call again to follow it; the waiting_for_workspace phase's gaps say what has not arrived yet. When it fails, recovery names the tool that recovers it. When it is Ready, workspaceName is the Organization to switch to, and notices say whether the presenter can see it.",
    inputSchema: advertised(DemoOperationRefSchema),
    annotations: READ,
  }, (args) => tool(principal, "get_demo_operation", { operation_id: idOf(args, "operationId") }, () =>
    api.getOperation({ actor, input: args })));

  server.registerTool("retry_demo_operation", {
    description: "Start the next attempt of a failed or stalled operation; every phase resumes from what the last attempt finished. Pass the attempt you read as expectedAttempt. A failed seeded run cannot be retried into success: when recovery says abandon_demo_operation, abandon and create a new demo.",
    inputSchema: advertised(RetryDemoOperationInputSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args) => tool(principal, "retry_demo_operation", { operation_id: idOf(args, "operationId") }, () =>
    api.retryOperation({ actor, input: args })));

  server.registerTool("abandon_demo_operation", {
    description: "Abandon an unfinished demo and retire its candidate Organization. Cannot be undone. Repeat the operation ID in confirmOperationId. Calling again resumes a retirement that did not finish.",
    inputSchema: advertised(AbandonDemoOperationInputSchema),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, (args) => tool(principal, "abandon_demo_operation", { operation_id: idOf(args, "operationId") }, () =>
    api.abandonOperation({ actor, input: args })));

  server.registerTool("retire_demo_organization", {
    description: "Retire a published demo Organization permanently: it closes for everyone in it and cannot be reopened. Only Organizations created by demo preparation can be retired here. Repeat the Organization's exact name in confirmName. Calling again resumes a retirement that did not finish.",
    inputSchema: advertised(RetireDemoOrganizationInputSchema),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, (args) => tool(principal, "retire_demo_organization", { organization_id: idOf(args, "organizationId") }, () =>
    api.retireOrganization({ actor, input: args })));

  return server;
}
