/**
 * `DemoAdministration`: the Demo MCP's door into demo preparation.
 *
 * A named `WorkerEntrypoint` with no HTTP route, reachable only by a Worker
 * holding the Service Binding — the same shape as `EngineeringInspectionBridge`,
 * and chosen for the same reason: no bearer secret to set, rotate or leak. The
 * actor every call carries is the Access identity the MCP Worker verified; this
 * side cannot verify it and trusts the binding, so the operator recorded on an
 * operation is only as trustworthy as that one Worker.
 *
 * It calls the same service functions the `/internal/demos` routes call, and
 * every answer is a result envelope rather than a throw: a Worker RPC reduces a
 * thrown error to a bare `Error`, and every refusal here has a code a model is
 * told to act on. `docs/demo-mcp.md` owns this surface.
 */
import {
  AbandonDemoOperationInputSchema,
  BUILTIN_DEMO_SCENARIO_ID,
  CheckDemoScenarioInputSchema,
  CreateDemoOrganizationInputSchema,
  DemoAdministrationActorSchema,
  DemoCastCandidatesInputSchema,
  DemoOperationRefSchema,
  GetDemoScenarioInputSchema,
  ListDemoOperationsInputSchema,
  ListDemoScenariosInputSchema,
  RetireDemoOrganizationInputSchema,
  RetryDemoOperationInputSchema,
  demoOperationIdForRequest,
  type DemoAdministrationCall,
  type DemoAdministrationOperation,
  type DemoAdministrationResult,
  type DemoAdministrationRpc,
  type DemoCastCandidates,
  type DemoScenario,
  type DemoScenarioCheck,
  type DemoScenarioList,
  type DemoScenarioRef,
  type RetireDemoOrganizationResult,
} from "@rally/contracts/demo-administration";
import type { DemoOperationStatus } from "@rally/contracts";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { z } from "zod";

import { boundParameterChunks } from "./durable-objects/bound-parameters";
import type { Env } from "./env";
import { ApiError } from "./lib/api-error";
import { logInfo, logWarn } from "./observability/logger";
import { resolveClientFeatureFlagsForSubject } from "./services/client-feature-flags";
import type { DemoPack } from "./services/demo-pack";
import {
  abandonDemoOperation,
  checkDemoCastEntries,
  demoOperationStatus,
  demoTemplate,
  listDemoOperations,
  retryDemoOperation,
  startDemoOperation,
} from "./services/demo-preparation";
import {
  BUILTIN_SCENARIO_DESCRIPTION,
  BUILTIN_SCENARIO_NAME,
  builtinDemoPack,
  builtinScenarioSummary,
  checkDemoPack,
  demoPackContent,
  previewDemoPack,
  readDemoPackRevision,
} from "./services/demo-scenarios";
import { retireWorkspaceForOperator } from "./services/workspace-retirement-service";

/** The seeded-run failures a retry replays into the same failure: abandon and start again. */
const ABANDON_ONLY_CODES = new Set(["demo_seed_run_failed", "demo_seed_run_outcome_mismatch", "demo_pack_changed"]);

function refused(code: string, message: string, issues?: { path: string; code: string; message: string }[]) {
  return { ok: false as const, code, message, ...(issues ? { issues } : {}) };
}

/**
 * Run one call: parse what it carries, run it, and turn whatever stopped it
 * into a code. An `ApiError` names its own cause; a schema rejection names its
 * paths; anything else is an internal fault whose text stays in the log.
 */
async function administered<I, T>(
  env: Env,
  method: string,
  call: DemoAdministrationCall<unknown>,
  schema: z.ZodType<I>,
  run: (input: I, actor: z.infer<typeof DemoAdministrationActorSchema>) => Promise<T | DemoAdministrationResult<T>>,
): Promise<DemoAdministrationResult<T>> {
  try {
    // Demos are prepared where the template lives; the other regions export
    // this entrypoint too and refuse every call, as their routes do.
    if (env.AVALON_REGION !== "global") return refused("demo_region_unsupported", "Demos are prepared only in Global.");
    const actor = DemoAdministrationActorSchema.parse(call.actor);
    const parsed = schema.safeParse(call.input);
    if (!parsed.success) {
      return refused(
        zodDiagnosticCode(parsed.error, `demo_${method}_input`) ?? "invalid_input",
        "The input does not match this tool's schema. Fix the fields the code names and call again.",
      );
    }
    const value = await run(parsed.data, actor);
    if (value !== null && typeof value === "object" && "ok" in value && (value as { ok: unknown }).ok === false) {
      return value as DemoAdministrationResult<T>;
    }
    return { ok: true, value: value as T };
  } catch (error) {
    if (error instanceof ApiError) return refused(error.code, error.message.slice(0, 1200));
    const schemaCode = zodDiagnosticCode(error, `demo_${method}`);
    logWarn(env, "demo_administration_failed", {
      method,
      error_code: schemaCode ?? "demo_administration_internal_error",
      error: error instanceof Error ? error.message : String(error),
    });
    return refused(
      schemaCode ?? "demo_administration_internal_error",
      "Rally's API failed while handling this call. The log has the detail; try again, and report it if it repeats.",
    );
  }
}

/** The pack a scenario reference names, checked; or the issues that refuse it. */
async function resolveScenario(
  env: Env,
  ref: DemoScenarioRef,
): Promise<{ ok: true; pack: DemoPack | undefined } | { ok: false; issues: { path: string; code: string; message: string }[] }> {
  if ("scenarioId" in ref) return { ok: true, pack: undefined };
  if ("revisionId" in ref) {
    const stored = await readDemoPackRevision(env.DB, ref.revisionId);
    if (!stored) throw new ApiError(404, "demo_scenario_not_found", "No scenario has this revision. Call list_demo_scenarios for the current ones.");
    return { ok: true, pack: stored.pack };
  }
  const checked = await checkDemoPack(ref.pack);
  return checked.ok ? { ok: true, pack: checked.pack } : { ok: false, issues: checked.issues };
}

interface OperationExtras {
  operation_id: string;
  request_key: string | null;
  requested_by_subject: string | null;
  requested_by_email: string | null;
  scenario_revision_id: string | null;
  content_hash: string | null;
}

/**
 * The shipped status of each operation, with what only the Demo MCP reads:
 * the request key, the stored pack, who asked, the tool that recovers a
 * failure, and — for one operation the caller is following — whether the
 * presenter can actually see a Ready demo.
 */
async function administrationOperations(
  env: Env,
  statuses: DemoOperationStatus[],
  options: { notices: boolean },
): Promise<DemoAdministrationOperation[]> {
  const extras = new Map<string, OperationExtras>();
  for (const chunk of boundParameterChunks(statuses.map((status) => status.operationId))) {
    const rows = await env.DB.prepare(
      `SELECT op.operation_id, op.request_key, op.requested_by_subject, op.requested_by_email,
              op.scenario_revision_id, revision.content_hash
         FROM demo_operations op
         LEFT JOIN demo_scenario_revisions revision ON revision.id = op.scenario_revision_id
        WHERE op.operation_id IN (${chunk.map(() => "?").join(", ")})`,
    ).bind(...chunk).all<OperationExtras>();
    for (const row of rows.results ?? []) extras.set(row.operation_id, row);
  }
  return Promise.all(statuses.map(async (status) => {
    const extra = extras.get(status.operationId);
    const notices: { code: string; message: string }[] = [];
    if (options.notices && status.status === "ready" && status.retiredAt === null) {
      const flags = await resolveClientFeatureFlagsForSubject(env, { userId: status.presenterUserId });
      if (!flags.multipleWorkspacesEnabled) {
        notices.push({
          code: "presenter_cannot_see_organizations",
          message: "The presenter's account menu lists Organizations only while multiple-workspaces-enabled is on for them. Turn it on in Ace's Feature flags tab, or the presenter cannot switch to this demo.",
        });
      }
    }
    return {
      ...status,
      requestKey: extra?.request_key ?? null,
      scenario: {
        source: extra?.scenario_revision_id ? (status.packVersion.startsWith("stored:") ? "stored" : "builtin") : "legacy",
        revisionId: extra?.scenario_revision_id ?? null,
        contentHash: extra?.content_hash ?? null,
      },
      requestedBy: extra?.requested_by_email ?? extra?.requested_by_subject ?? null,
      recovery: status.status === "failed"
        ? (ABANDON_ONLY_CODES.has(status.error?.code ?? "") ? "abandon_demo_operation" : "retry_demo_operation")
        : null,
      notices,
    };
  }));
}

async function oneOperation(env: Env, operationId: string, notices: boolean): Promise<DemoAdministrationOperation> {
  const status = await demoOperationStatus(env, operationId);
  if (!status) throw new ApiError(404, "demo_operation_not_found", "No demo operation has this ID. Call list_demo_operations.");
  return (await administrationOperations(env, [status], { notices }))[0]!;
}

export class DemoAdministration extends WorkerEntrypoint<Env> implements DemoAdministrationRpc {
  async listScenarios(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoScenarioList>> {
    return administered(this.env, "list_scenarios", call, ListDemoScenariosInputSchema, async () => {
      const pack = builtinDemoPack();
      return {
        scenarios: [{
          scenarioId: BUILTIN_DEMO_SCENARIO_ID,
          source: "builtin" as const,
          name: BUILTIN_SCENARIO_NAME,
          description: BUILTIN_SCENARIO_DESCRIPTION,
          revision: pack.version,
          summary: builtinScenarioSummary(pack),
        }],
      };
    });
  }

  async getScenario(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoScenario>> {
    return administered(this.env, "get_scenario", call, GetDemoScenarioInputSchema, async (input) => {
      if ("scenarioId" in input) {
        const pack = builtinDemoPack();
        return {
          scenarioId: BUILTIN_DEMO_SCENARIO_ID,
          revisionId: null,
          name: BUILTIN_SCENARIO_NAME,
          description: BUILTIN_SCENARIO_DESCRIPTION,
          revision: pack.version,
          contentHash: (await demoPackContent(pack)).contentHash,
          pack,
        };
      }
      const stored = await readDemoPackRevision(this.env.DB, input.revisionId);
      if (!stored) throw new ApiError(404, "demo_scenario_not_found", "No scenario has this revision. Call list_demo_scenarios for the current ones.");
      return {
        scenarioId: null,
        revisionId: input.revisionId,
        name: null,
        description: null,
        revision: null,
        contentHash: stored.contentHash,
        pack: stored.pack,
      };
    });
  }

  async checkScenario(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoScenarioCheck>> {
    return administered(this.env, "check_scenario", call, CheckDemoScenarioInputSchema, async (input) => {
      const checked = await checkDemoPack(input.pack);
      if (!checked.ok) return { ok: false as const, issues: checked.issues };
      const names = input.cast
        ? (await checkDemoCastEntries(this.env, checked.pack, input.cast, null)).names
        : {};
      return {
        ok: true as const,
        contentHash: checked.contentHash,
        pack: checked.pack,
        summary: checked.summary,
        derived: checked.derived,
        preview: previewDemoPack(checked.pack, names),
      };
    });
  }

  async castCandidates(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoCastCandidates>> {
    return administered(this.env, "cast_candidates", call, DemoCastCandidatesInputSchema, async (input) => {
      const template = await demoTemplate(this.env);
      let parts: { role: string; label: string }[] | undefined;
      if (input.scenario) {
        const resolved = await resolveScenario(this.env, input.scenario);
        if (!resolved.ok) {
          return refused("demo_scenario_invalid", "The scenario has problems listed in issues. Fix every issue, check it with check_demo_scenario, and call again.", resolved.issues);
        }
        const pack = resolved.pack ?? builtinDemoPack();
        parts = Object.entries(pack.roleLabels).map(([role, label]) => ({ role, label }));
      }
      return {
        presenters: template.members.map(({ userId, name, email }) => ({ userId, name, email })),
        colleagues: template.castCandidates,
        ...(parts ? { parts } : {}),
      };
    });
  }

  async createOrganization(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoAdministrationOperation>> {
    return administered(this.env, "create_organization", call, CreateDemoOrganizationInputSchema, async (input, actor) => {
      const operationId = await demoOperationIdForRequest(actor.subject, input.requestKey);
      // Replay first, before the scenario is resolved, checked or stored and
      // before the cast is read: the shipped rule, for its shipped reason — a
      // repeat checked against a directory that has moved since would refuse a
      // retry of a preparation that is running fine.
      if (await demoOperationStatus(this.env, operationId)) return oneOperation(this.env, operationId, true);
      const resolved = await resolveScenario(this.env, input.scenario);
      if (!resolved.ok) {
        return refused("demo_scenario_invalid", "The scenario has problems listed in issues. Fix every issue, check it with check_demo_scenario, and call again.", resolved.issues);
      }
      await startDemoOperation(this.env, {
        operationId,
        companyName: input.companyName,
        presenterUserId: input.presenterUserId,
        cast: input.cast,
        ...(resolved.pack ? { pack: resolved.pack } : {}),
        requestKey: input.requestKey,
        requester: actor,
      }, { operatorId: actor.email ?? actor.subject });
      logInfo(this.env, "demo_mcp_operation_created", {
        operation_id: operationId,
        actor_subject: actor.subject,
        scenario: "pack" in input.scenario ? "inline" : "revisionId" in input.scenario ? "revision" : "builtin",
      });
      return oneOperation(this.env, operationId, true);
    });
  }

  async listOperations(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<{ operations: DemoAdministrationOperation[] }>> {
    return administered(this.env, "list_operations", call, ListDemoOperationsInputSchema, async (input) => {
      const all = await listDemoOperations(this.env);
      const statuses = input.status ? all.filter((status) => status.status === input.status) : all;
      return { operations: await administrationOperations(this.env, statuses, { notices: false }) };
    });
  }

  async getOperation(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoAdministrationOperation>> {
    return administered(this.env, "get_operation", call, DemoOperationRefSchema, async (input) =>
      oneOperation(this.env, input.operationId, true));
  }

  async retryOperation(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoAdministrationOperation>> {
    return administered(this.env, "retry_operation", call, RetryDemoOperationInputSchema, async (input) => {
      const current = await demoOperationStatus(this.env, input.operationId);
      if (!current) throw new ApiError(404, "demo_operation_not_found", "No demo operation has this ID. Call list_demo_operations.");
      // A retry repeated after a lost response names the attempt it read, which
      // the first retry has already moved past: it starts nothing rather than
      // superseding the driver the first one launched.
      if (current.attempt !== input.expectedAttempt) {
        throw new ApiError(409, "demo_operation_changed", "The operation changed after you read it. Read it again with get_demo_operation before retrying.");
      }
      await retryDemoOperation(this.env, input.operationId);
      return oneOperation(this.env, input.operationId, false);
    });
  }

  async abandonOperation(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<DemoAdministrationOperation>> {
    return administered(this.env, "abandon_operation", call, AbandonDemoOperationInputSchema, async (input, actor) => {
      await abandonDemoOperation(this.env, input.operationId, {
        confirmOperationId: input.confirmOperationId,
        operatorId: actor.email ?? actor.subject,
      });
      return oneOperation(this.env, input.operationId, false);
    });
  }

  async retireOrganization(call: DemoAdministrationCall<unknown>): Promise<DemoAdministrationResult<RetireDemoOrganizationResult>> {
    return administered(this.env, "retire_organization", call, RetireDemoOrganizationInputSchema, async (input, actor) => {
      // Only what demo preparation made, and only once it was published: this
      // door is for a wider circle than Ace's workspaces tab, which can close
      // anything. An unfinished candidate is abandoned instead.
      const demo = await this.env.DB.prepare(
        `SELECT op.operation_id, op.ready_at, workspace.name AS name
           FROM demo_operations op JOIN workspaces workspace ON workspace.id = op.workspace_id
          WHERE op.workspace_id = ? AND workspace.region = ?`,
      ).bind(input.organizationId, this.env.AVALON_REGION)
        .first<{ operation_id: string; ready_at: string | null; name: string }>();
      if (!demo) {
        throw new ApiError(404, "demo_not_a_demo_organization", "This Organization was not created by demo preparation and cannot be retired here.");
      }
      if (demo.ready_at === null) {
        throw new ApiError(409, "demo_operation_unpublished", "This demo never became Ready. Close it with abandon_demo_operation instead.");
      }
      if (input.confirmName !== demo.name) {
        throw new ApiError(409, "demo_retire_unconfirmed", "The confirmation does not match. Repeat the Organization's exact name to confirm.");
      }
      const receipt = await retireWorkspaceForOperator(this.env, input.organizationId, {
        operatorId: actor.email ?? actor.subject,
      });
      const retired = await this.env.DB.prepare("SELECT retired_at FROM demo_operations WHERE operation_id = ?")
        .bind(demo.operation_id).first<{ retired_at: string | null }>();
      return { organizationId: input.organizationId, retiredAt: retired?.retired_at ?? null, complete: receipt.complete };
    });
  }
}
