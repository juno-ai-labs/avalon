import { zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { z } from 'zod';
import type { Env } from './env';
import {
  FlagChangeNotificationError,
  FlagshipRequestError,
  listManagedFlags,
  listManagedModelFlags,
  updateManagedFlag,
  updateManagedModelRouting,
} from './flagship';
import { validateRouting } from './openrouter';
import {
  MANAGED_FLAGS,
  MANAGED_MODELS,
  ManagedFlagUpdateSchema,
  ManagedModelUpdateSchema,
  type FlagAdministrationActor,
  type FlagAdministrationResult,
  type FlagAdministrationRpc,
  type ManagedModelFlagState,
  type ManagedProductFlagState,
} from './protocol';

function flagsByKey(flags: unknown[]): Map<string, unknown> {
  return new Map(flags.map((flag) => [String((flag as { key?: unknown }).key), flag]));
}

/**
 * A failure Ace can name becomes a refusal the caller logs by its code; the
 * message goes back to the engineer who asked. Anything else is a defect and
 * crosses the RPC as itself.
 */
async function named<T>(operation: () => Promise<FlagAdministrationResult<T>>): Promise<FlagAdministrationResult<T>> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof FlagshipRequestError) {
      // Flagship's own error text stays in Ace; only its status crosses.
      return {
        ok: false,
        code: `flagship_request_failed_${error.status}`,
        message: `Flagship refused the request with HTTP ${error.status}. Nothing was changed by this call.`,
      };
    }
    if (error instanceof FlagChangeNotificationError) {
      return { ok: false, code: 'flag_change_notification_failed', message: error.message };
    }
    const schema = zodDiagnosticCode(error, 'flagship_response');
    if (schema) return { ok: false, code: schema, message: 'Flagship returned a flag definition Ace cannot read.' };
    throw error;
  }
}

/** Returned to the engineer only; the log carries the code. */
function issuesMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ');
}

function logWrite(event: string, actor: FlagAdministrationActor, target: Record<string, string>): void {
  console.log(JSON.stringify({ event, actor_subject: actor.subject, via: 'engineering_mcp', ...target }));
}

/**
 * The engineering MCP's way to read and change the flags Ace manages. It runs
 * the same validation and write functions as the Ace pages; see
 * `FlagAdministrationRpc` in `protocol.ts` for the trust boundary.
 */
export class FlagAdministration extends WorkerEntrypoint<Env> implements FlagAdministrationRpc {
  listProductFlags(): Promise<FlagAdministrationResult<ManagedProductFlagState[]>> {
    return named(async () => {
      const live = flagsByKey(await listManagedFlags(this.env));
      return {
        ok: true,
        value: MANAGED_FLAGS.map((definition) => ({ ...definition, flag: live.get(definition.key) ?? null })),
      };
    });
  }

  updateProductFlag(input: { actor: FlagAdministrationActor; update: unknown }): Promise<FlagAdministrationResult<unknown>> {
    return named(async () => {
      const update = ManagedFlagUpdateSchema.safeParse(input.update);
      if (!update.success) {
        return {
          ok: false,
          code: zodDiagnosticCode(update.error, 'flag_update')!,
          message: `The flag definition is not valid: ${issuesMessage(update.error)}`,
        };
      }
      let flag: unknown;
      try {
        flag = await updateManagedFlag(this.env, update.data.key, update.data);
      } catch (error) {
        // Flagship already changed; only the client notification failed.
        if (error instanceof FlagChangeNotificationError) {
          logWrite('ace_product_flag_updated', input.actor, { flag_key: update.data.key });
        }
        throw error;
      }
      logWrite('ace_product_flag_updated', input.actor, { flag_key: update.data.key });
      return { ok: true, value: flag };
    });
  }

  listModelFlags(): Promise<FlagAdministrationResult<ManagedModelFlagState[]>> {
    return named(async () => {
      const live = flagsByKey(await listManagedModelFlags(this.env));
      return {
        ok: true,
        value: MANAGED_MODELS.map((definition) => ({ ...definition, flag: live.get(definition.key) ?? null })),
      };
    });
  }

  updateModelRouting(input: { actor: FlagAdministrationActor; update: unknown }): Promise<FlagAdministrationResult<unknown>> {
    return named(async () => {
      const update = ManagedModelUpdateSchema.safeParse(input.update);
      if (!update.success) {
        return {
          ok: false,
          code: zodDiagnosticCode(update.error, 'model_update')!,
          message: `The model route is not valid: ${issuesMessage(update.error)}`,
        };
      }
      const validation = await validateRouting(update.data.routing);
      if (!validation.ok) return { ok: false, code: validation.code, message: validation.message };
      const flag = await updateManagedModelRouting(this.env, update.data.role, update.data);
      logWrite('ace_agent_model_updated', input.actor, { agent_role: update.data.role });
      return { ok: true, value: flag };
    });
  }
}
