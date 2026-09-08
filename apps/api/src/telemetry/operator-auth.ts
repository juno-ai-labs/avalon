import { z } from 'zod';
import type { MiddlewareHandler } from 'hono';
import type { HonoAppEnv } from '../env';
import { ApiError } from '../lib/api-error';
import { timingSafeEqualText } from '../lib/crypto';

/**
 * Every operator credential the regional API accepts, by role.
 *
 * `support` and `security` are the telemetry roles. `demos` is Ace's: it may
 * retire a workspace and nothing else, which is why it is a role of its own
 * rather than a widening of `security`. The configuration is
 * still `TELEMETRY_OPERATORS_JSON` — one secret holding every operator token —
 * because a second secret with the same shape is a second thing to rotate for
 * no isolation gained: the role is what isolates, and only if every surface
 * names the roles it admits. `requireTelemetryOperator` verifies the
 * credential; it admits nothing by itself. Each router narrows to its roles
 * with `requireOperatorRole`, so a role added to this enum reaches no surface
 * until a router names it.
 */
const OperatorPrincipalSchema = z.strictObject({
  operatorId: z.string().uuid(),
  role: z.enum(['support', 'security', 'demos']),
});

const OperatorConfigurationSchema = z.record(
  z.string().min(32).max(256),
  OperatorPrincipalSchema,
).refine((operators) => Object.keys(operators).length <= 25);

export type TelemetryOperatorPrincipal = z.infer<typeof OperatorPrincipalSchema>;

export const requireTelemetryOperator: MiddlewareHandler<HonoAppEnv> = async (c, next) => {
  const authorization = c.req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new ApiError(401, 'operator_authentication_required', 'A valid operator credential is required');
  }
  let operators: z.infer<typeof OperatorConfigurationSchema>;
  try {
    operators = OperatorConfigurationSchema.parse(JSON.parse(c.env.TELEMETRY_OPERATORS_JSON ?? '') as unknown);
  } catch {
    throw new ApiError(503, 'operator_authentication_unavailable', 'Operator access is not configured');
  }
  const presented = authorization.slice(7);
  const matched = Object.entries(operators).find(([token]) => timingSafeEqualText(token, presented));
  if (!matched) {
    throw new ApiError(401, 'operator_authentication_invalid', 'The operator credential is invalid');
  }
  c.set('telemetryOperator', matched[1]);
  await next();
};

/** Refuse every operator whose role is not one the router is for. */
export function requireOperatorRole(
  ...roles: readonly [TelemetryOperatorPrincipal['role'], ...TelemetryOperatorPrincipal['role'][]]
): MiddlewareHandler<HonoAppEnv> {
  return async (c, next) => {
    if (!roles.includes(getTelemetryOperator(c).role)) {
      throw new ApiError(403, 'operator_role_forbidden', 'This operator role cannot use this surface');
    }
    await next();
  };
}

export function getTelemetryOperator(c: Parameters<MiddlewareHandler<HonoAppEnv>>[0]): TelemetryOperatorPrincipal {
  const principal = c.get('telemetryOperator');
  if (!principal) throw new Error('telemetry_operator_context_missing');
  return principal;
}
