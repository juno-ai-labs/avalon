import { MESSAGE_MAX_CHARACTERS, MESSAGE_TOO_LONG_MESSAGE } from "@avalon/contracts";
import { zValidator as honoZValidator } from "@hono/zod-validator";
import type { MiddlewareHandler } from "hono";

import { ApiError } from "../lib/api-error";

/**
 * Avalon-safe Zod validator.
 *
 * The upstream validator returns its full Zod failure object by default. That
 * object includes schema paths, regexes, and other implementation details that
 * must not become part of the public API. Keep the upstream generic signature
 * for route inference while translating every validation failure into the
 * standard API error pipeline.
 */
export const zValidator: typeof honoZValidator = ((
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
        throw new ApiError(400, "invalid_request", "The request is invalid");
      }
      return hook?.(result, c);
    },
    options,
  )) as typeof honoZValidator;

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
export function requireSendableMessageLength(field: "openingMessage" | "text"): MiddlewareHandler {
  return async (c, next) => {
    const body: unknown = await c.req.json().catch(() => null);
    const value = body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)[field]
      : undefined;
    if (typeof value === "string" && value.length > MESSAGE_MAX_CHARACTERS) {
      throw new ApiError(400, "message_too_long", MESSAGE_TOO_LONG_MESSAGE);
    }
    await next();
  };
}
