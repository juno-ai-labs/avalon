import { ApiError } from "../lib/api-error";

/**
 * The public shape of a failure raised inside AutomationAgent.
 *
 * The object throws bare `Error`s whose message is a stable snake_case code —
 * that is the right thing for a durable object, whose callers are typed RPC
 * rather than HTTP. But `errorHandler` maps anything that is not an `ApiError`
 * to `500 internal_error`, so without this table a permission denial, a
 * "someone else is compiling, retry" and a genuine server fault are one
 * indistinguishable response, every one of them logged at error severity and
 * retried by any client backing off on 5xx.
 *
 * The code stays the stable identifier on both sides; only the status and the
 * sentence a person reads are added here.
 */
type AutomationErrorStatus = 403 | 404 | 409 | 422 | 503;

interface AutomationErrorResponse {
  status: AutomationErrorStatus;
  message: string;
}

const AUTOMATION_ERROR_RESPONSES = {
  automation_access_denied: { status: 403, message: "You do not have access to this automation." },
  automation_authority_mismatch: { status: 403, message: "You do not have access to this automation." },
  automation_identity_mismatch: { status: 404, message: "This automation could not be found." },
  automation_identity_missing: { status: 404, message: "This automation could not be found." },
  automation_workspace_scope_requires_admin: {
    status: 403,
    message: "Only a workspace owner or admin can create an automation for the whole workspace.",
  },
  automation_personal_connection_access_denied: {
    status: 403,
    message: "This automation uses a connection you do not have access to.",
  },
  automation_compiler_busy: {
    status: 409,
    message: "Rally is still working on the previous message. Wait for it to finish, then try again.",
  },
  automation_compiler_run_not_active: { status: 409, message: "That turn has already finished." },
  automation_compiler_run_not_found: { status: 404, message: "That turn could not be found." },
  automation_compiler_run_not_retryable: { status: 409, message: "That turn cannot be retried." },
  automation_acceptance_conflict: {
    status: 409,
    message: "This automation was already created with different settings. Reload and try again.",
  },
  automation_definition_not_ready: {
    status: 409,
    message: "This automation is not ready yet. Answer Rally's outstanding question first.",
  },
  automation_definition_revision_stale: {
    status: 409,
    message: "This draft changed while you were reviewing it. Reload and try again.",
  },
  automation_pending_elicitation: {
    status: 409,
    message: "Answer Rally's outstanding question before creating this automation.",
  },
  automation_evaluator_rules_required: {
    status: 409,
    message: "This automation's trigger is not fully configured yet. Ask Rally to finish setting it up.",
  },
  automation_not_draft: { status: 409, message: "This automation has already been created." },
  automation_not_acceptable: { status: 409, message: "This automation cannot be created in its current state." },
  automation_not_active: { status: 409, message: "This automation is not running." },
  automation_not_accepted: { status: 409, message: "This automation has not been created yet." },
  automation_not_pausable: { status: 409, message: "This automation cannot be paused right now." },
  automation_not_resumable: { status: 409, message: "This automation cannot be resumed right now." },
  automation_not_configurable: { status: 409, message: "This automation's delivery cannot be changed right now." },
  automation_activation_fenced: {
    status: 409,
    message: "This automation changed while it was being created. Reload and try again.",
  },
  automation_recurrence_has_no_future: {
    status: 422,
    message: "That schedule has no future run. Choose a different time.",
  },
  automation_timezone_invalid: { status: 422, message: "That time zone is not one Rally recognizes." },
  automation_plugin_unavailable: {
    status: 409,
    message: "A connection this automation needs is unavailable. Reconnect it and try again.",
  },
  automation_delivery_connection_unavailable: {
    status: 409,
    message: "A delivery destination is unavailable. Reconnect it and try again.",
  },
  automation_delivery_identity_unavailable: {
    status: 409,
    message: "A delivery destination could not be resolved for your account.",
  },
  automation_cutover_in_progress: {
    status: 503,
    message: "Rally is finishing an update to automations. Try again in a moment.",
  },
  automation_draft_id_required: { status: 422, message: "This request is missing its draft." },
} as const satisfies Readonly<Record<string, AutomationErrorResponse>>;

/**
 * A code the table above answers for, so a refusal raised here rather than by
 * the object cannot be spelled wrong. A typo would fall through
 * `automationApiError` to the 500 this table exists to prevent, and nothing
 * would say so until somebody hit that branch in production.
 */
export type AutomationRefusalCode = keyof typeof AUTOMATION_ERROR_RESPONSES;

/**
 * The same table keyed by an arbitrary string, for the lookup that starts from a
 * code an object threw rather than one this module named.
 */
const RESPONSE_BY_CODE: ReadonlyMap<string, AutomationErrorResponse> = new Map(
  Object.entries(AUTOMATION_ERROR_RESPONSES),
);

/** Codes that are safe to return verbatim with a generic sentence. */
const SAFE_CODE = /^(automation|memory|email)_[a-z0-9_]+$/u;

/**
 * Re-raise an AutomationAgent failure as the API's own error contract.
 *
 * Anything unrecognised keeps its 500: an unmapped code is a fault we have not
 * reasoned about, and quietly answering 409 for it would hide a real defect
 * behind a retry.
 */
export function automationApiError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = error instanceof Error ? error.message : "";
  const mapped = RESPONSE_BY_CODE.get(code);
  if (mapped) throw new ApiError(mapped.status, code, mapped.message);
  if (SAFE_CODE.test(code)) {
    throw new ApiError(409, code, "This automation could not complete that request.");
  }
  throw error;
}

/** Run one AutomationAgent call, mapping its thrown code to the API contract. */
export async function withAutomationErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    automationApiError(error);
  }
}

/**
 * Refuse from the REST boundary itself, in the object's own vocabulary.
 *
 * `withAutomationErrors` maps what an AutomationAgent throws, but two refusals
 * on the create path are decided in `AutomationAgentService` before any RPC is
 * made: a request carrying no draft id, and a submitted draft that no longer
 * matches the stored definition. Both were raised as bare `Error`s outside that
 * wrapper, so the sentences written for them here were never read — `POST
 * /automations` answered `500 internal_error` / "An unexpected error occurred",
 * logged at error severity, for a person whose only fault was reviewing a draft
 * the compiler had since revised.
 */
export function automationRefusal(code: AutomationRefusalCode): never {
  const mapped = AUTOMATION_ERROR_RESPONSES[code];
  throw new ApiError(mapped.status, code, mapped.message);
}
