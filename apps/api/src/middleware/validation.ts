import { zValidator as honoZValidator } from "@hono/zod-validator";
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
