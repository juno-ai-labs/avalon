import { MESSAGE_MAX_CHARACTERS, MESSAGE_TOO_LONG_MESSAGE } from "@rally/contracts";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { zValidator as honoZValidator } from "@hono/zod-validator";
import type { MiddlewareHandler } from "hono";

import { ApiError } from "../lib/api-error";

interface RequestValidationIssue {
  path: string;
  code: string;
}

/**
 * Preserve a parsed JSON body's structure without retaining any terminal
 * member value. Numbers keep a numeric sentinel so an operator can distinguish
 * a numeric field from every other JSON leaf; object keys, array positions,
 * and empty containers remain visible as the rejected request's shape.
 */
function redactJsonBodyShape(value: unknown): unknown {
  if (typeof value === "number") return -1;
  if (Array.isArray(value)) return value.map(redactJsonBodyShape);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, redactJsonBodyShape(item)]),
    );
  }
  return "***";
}

/**
 * An input rejection with an operator-only, value-free diagnostic.
 *
 * `ApiError.details` is public response data, so validation paths cannot ride
 * there. This subtype keeps the public envelope generic while allowing the
 * error middleware to record only schema paths and Zod issue codes — never the
 * rejected values, messages, regexes, or schema internals.
 */
export class RequestValidationError extends ApiError {
  readonly validationIssues: RequestValidationIssue[];
  readonly requestBody: unknown | undefined;

  constructor(
    readonly validationTarget: string,
    issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string }>,
    input: unknown,
    /** The public code and message, for a route that names its rejection (`namedZValidator`). */
    named?: { code: string; message: string },
  ) {
    super(400, named?.code ?? "invalid_request", named?.message ?? "The request is invalid");
    this.name = "RequestValidationError";
    this.validationIssues = issues.slice(0, 25).map((issue) => ({
      path: issue.path.map(String).join(".") || "(root)",
      code: issue.code,
    }));
    this.requestBody = validationTarget === "json"
      ? redactJsonBodyShape(input)
      : undefined;
  }
}

function validator(named: { label: string; message: string } | null): typeof honoZValidator {
  return ((
    target: Parameters<typeof honoZValidator>[0],
    schema: Parameters<typeof honoZValidator>[1],
    hook: Parameters<typeof honoZValidator>[2],
    options: Parameters<typeof honoZValidator>[3],
  ) =>
    honoZValidator(
      target,
      schema,
      async (result, c) => {
        if (!result.success) {
          if (result.error.issues.some((issue) => issue.code === 'custom' && issue.message === 'annotations_too_large')) {
            throw new ApiError(422, 'annotations_too_large', 'These pins are too large to send together');
          }
          const code = named === null ? null : zodDiagnosticCode(result.error, named.label);
          throw new RequestValidationError(target, result.error.issues, result.data,
            code === null || named === null ? undefined : { code, message: named.message });
        }
        return hook?.(result, c);
      },
      options,
    )) as typeof honoZValidator;
}

/**
 * Avalon-safe Zod validator.
 *
 * The upstream validator returns its full Zod failure object by default. That
 * object includes schema paths, regexes, and other implementation details that
 * must not become part of the public API. Keep the upstream generic signature
 * for route inference while translating every validation failure into the
 * standard API error pipeline.
 */
export const zValidator: typeof honoZValidator = validator(null);

/**
 * `zValidator` for a route whose refusal names what it refused: the code is
 * `<label>_invalid:<path>:<issue>` (`zodDiagnosticCode`, so declared field
 * names and issue codes only, never a value or a caller's unknown key), and
 * the message is the route's own sentence, which a client may show the person.
 * For a route a person's input reaches, where "The request is invalid" leaves
 * them nothing to fix (`docs/naming-a-schema-failure.md`).
 */
export function namedZValidator(label: string, message: string): typeof honoZValidator {
  return validator({ label, message });
}

/**
 * Refuses an over-long composed message in the words of the person who typed it.
 *
 * Registered **ahead of** `zValidator` on the routes that carry one. The schemas
 * bound the same field at the same `MESSAGE_MAX_CHARACTERS`, and deliberately
 * still do — a caller that reaches the validator with more is refused either
 * way. But the generic translation above is what makes that refusal useless
 * here: "The request is invalid" is the correct answer to a malformed request
 * and the wrong one to a person holding a long paste, who is the only party who
 * can fix this and needs to be told what to fix. Length is the one bound on
 * these routes whose remedy is in the caller's hands, so it is the one bound
 * that answers for itself.
 *
 * Running first also means an over-long create is refused before it reserves
 * anything. The create path writes a receipt, an email address and its D1 rows
 * before the message reaches the object that validates it, so a rejection later
 * than this one leaves all three behind for a work stream that will never exist.
 *
 * Reading the body here costs nothing: Hono caches it, so the validator behind
 * this parses the cached text rather than a consumed stream. A body that is not
 * JSON, or that carries no string there, is passed through untouched for the
 * validator to reject in its own words.
 */
export function requireSendableMessageLength(
  /**
   * Where the message sits in the body. `opening.text` is one level down
   * because a substream is created with the message that starts it, and the
   * caller of that route deserves the same answer as the caller of every other
   * route that carries composed text — not the validator's generic refusal for
   * a bound they can act on.
   */
  field: "openingMessage" | "text" | "message" | "body" | "opening.text",
): MiddlewareHandler {
  return async (c, next) => {
    const body: unknown = await c.req.json().catch(() => null);
    const value = field.split(".").reduce<unknown>(
      (current, key) => current !== null && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined,
      body,
    );
    if (typeof value === "string" && value.length > MESSAGE_MAX_CHARACTERS) {
      throw new ApiError(400, "message_too_long", MESSAGE_TOO_LONG_MESSAGE);
    }
    await next();
  };
}
