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
  // WorkspaceDO's two membership refusals, on the first authoring send and on
  // the sidebar list. Without rows they matched `SAFE_CODE` and answered 409 —
  // the status a client retries, for the one condition retrying never resolves.
  automation_author_access_denied: {
    status: 403,
    message: "You do not have access to this workspace's automations.",
  },
  automation_directory_access_denied: {
    status: 403,
    message: "You do not have access to this workspace's automations.",
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
  automation_activation_fenced: {
    status: 409,
    message: "This automation changed while it was being created. Reload and try again.",
  },
  automation_recurrence_has_no_future: {
    status: 422,
    message: "That schedule has no future run. Choose a different time.",
  },
  automation_timezone_invalid: { status: 422, message: "That time zone is not one Rally recognizes." },
  // The five below are what remains once acceptance derives its bindings from
  // the draft instead of taking them in a request. Each was reachable before
  // and none had a row, so each reached a member as `SAFE_CODE`'s generic
  // "This automation could not complete that request." — a sentence with no
  // next step, on the one button the proposal card offers.
  automation_activity_source_unbound: {
    status: 422,
    message: "This automation's trigger is missing the connection it watches. Ask Rally to set it up again.",
  },
  automation_plugin_unavailable: {
    status: 409,
    message: "A connection this automation needs is unavailable. Reconnect it and try again.",
  },
  // Thrown when a derived plugin resolves to a connection the caller may not
  // bind. It fell to the `SAFE_CODE` net and answered "This automation could not
  // complete that request.", which under a Create button reads as the automation
  // having broken rather than as a connection the person could go and share.
  automation_workspace_connection_required: {
    status: 409,
    message: "A workspace automation can only use connections shared with the whole workspace.",
  },
  automation_cutover_in_progress: {
    status: 503,
    message: "Rally is finishing an update to automations. Try again in a moment.",
  },
  // A draft written outside a work stream has no room to belong to, and one
  // cannot be supplied: the request carries no room by design.
  automation_workstream_scope_requires_authoring_room: {
    status: 422,
    message: "Only an automation drafted inside a work stream can belong to one.",
  },
  // 403 rather than 422: the request is well formed and was valid when the
  // draft was proposed. What changed is the caller's standing in the room.
  automation_workstream_participation_required: {
    status: 403,
    message: "Only a participant of this work stream can create an automation that belongs to it.",
  },
} satisfies Readonly<Record<string, AutomationErrorResponse>>;

/**
 * A code the table above answers for.
 *
 * A misspelling is not catastrophic — every plausible typo keeps the
 * `automation_` prefix, so `SAFE_CODE` below catches it and answers a generic
 * 409 rather than a 500. What the union buys is that the specific status and
 * sentence cannot be lost silently at a call site nobody wrote a test for.
 */
type AutomationRefusalCode = keyof typeof AUTOMATION_ERROR_RESPONSES;

/**
 * The same object, widened for the lookup that starts from a code an object
 * threw rather than from a key the compiler checked. One table, two views: the
 * `| undefined` is what `satisfies` leaves room for, and it is also what keeps
 * a thrown `"constructor"` or `"toString"` from finding an `Object.prototype`
 * member and building an `ApiError` with no status.
 */
const RESPONSE_BY_CODE: Readonly<Record<string, AutomationErrorResponse | undefined>> =
  AUTOMATION_ERROR_RESPONSES;

/**
 * An `ApiError` that has crossed a Durable Object RPC boundary.
 *
 * The object throws snake_case codes, but the collaborators it calls inside a
 * request do not: `WorkstreamEmailRoutingService.reserveAutomation`, which
 * `acceptDraft` reaches to claim the automation's address, throws `ApiError`
 * — including the 503 an EU region raises when the Global address registry is
 * unreachable. Cloudflare preserves an error's `name`, `message` and own
 * properties across RPC but not its class, so `instanceof` misses, the message
 * is a human sentence rather than a code, and both the table and `SAFE_CODE`
 * step over the status and code sitting on the object. Every one of those
 * deliberate refusals reached the member as `500 internal_error`.
 *
 * Recognised by shape, which is what survives: `ApiError` is the only error in
 * this tree carrying both a numeric `status` and a string `code`.
 *
 * Honest about its own coverage: the workers test pool preserves the class, so
 * `automation-agent.test.ts`'s "answers an ApiError raised inside the object"
 * passes with this rebuild removed. That test guards the outcome — the member
 * gets the author's 503, not a 500 — and this rebuild is what makes the outcome
 * hold where the class does not survive, which review reported for a deployed
 * RPC hop and which no suite here can reproduce. It cannot change behaviour
 * where `instanceof` already matched: that branch returns above this one.
 */
function apiErrorAcrossRpc(error: unknown): ApiError | null {
  if (!(error instanceof Error) || error.name !== "ApiError") return null;
  const { status, code, details } = error as Error & {
    status?: unknown;
    code?: unknown;
    details?: unknown;
  };
  if (typeof status !== "number" || typeof code !== "string") return null;
  return new ApiError(
    status as ConstructorParameters<typeof ApiError>[0],
    code,
    error.message,
    details === undefined ? undefined : details as Record<string, unknown>,
  );
}

/** Codes that are safe to return verbatim with a generic sentence. */
const SAFE_CODE = /^(automation|memory|email)_[a-z0-9_]+$/u;

/**
 * Re-raise an AutomationAgent failure as the API's own error contract.
 *
 * Anything unrecognised keeps its 500: an unmapped code is a fault we have not
 * reasoned about, and quietly answering 409 for it would hide a real defect
 * behind a retry.
 */
function automationApiError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const rebuilt = apiErrorAcrossRpc(error);
  if (rebuilt) throw rebuilt;
  const code = error instanceof Error ? error.message : "";
  const mapped = RESPONSE_BY_CODE[code];
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
 * `withAutomationErrors` maps what an AutomationAgent throws, but three
 * refusals on the create path are decided in `AutomationAgentService` before or
 * between its RPCs: a request carrying no draft id, a draft the compiler has
 * not compiled yet, and a submitted draft that no longer matches the stored
 * definition. The first and third were raised as bare `Error`s outside that
 * wrapper, so the sentences written for them here were never read — `POST
 * /automations` answered `500 internal_error` / "An unexpected error occurred",
 * logged at error severity, for a person whose only fault was reviewing a draft
 * the compiler had since revised.
 */
export function automationRefusal(code: AutomationRefusalCode): never {
  const mapped = AUTOMATION_ERROR_RESPONSES[code];
  throw new ApiError(mapped.status, code, mapped.message);
}
