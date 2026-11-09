import { z } from 'zod';
import type { MiddlewareHandler } from 'hono';
import type { HonoAppEnv } from '../env';
import { ApiError } from '../lib/api-error';
import { timingSafeEqualText } from '../lib/crypto';

/**
 * The operator credentials the regional API accepts, and the two secrets that
 * hold them.
 *
 * Both secrets have the same shape — a JSON map from opaque bearer token to a
 * fixed principal, operator UUID and role — and are parsed by the same code.
 * `TELEMETRY_OPERATORS_JSON` holds the telemetry roles, `support` and
 * `security`, for the restricted telemetry surface. `DEMO_OPERATORS_JSON`
 * holds the `demos` role, the credential Ace presents to retire a workspace,
 * to reconcile acquisition acknowledgements, and to apply reviewed connector
 * maintenance. Both names are stored ones: the secret and the role value were
 * named for the demo feature that first used them, which is retired, and
 * renaming either is a secret rotation in every region, so the code calls
 * them `requireAceOperator` and `ACE_OPERATOR_ROLE` instead
 * (`docs/rally-rebrand-inventory.md`). They are two secrets rather than
 * one map with three roles because they are set and rotated by different
 * people for different reasons, and a Worker secret cannot be read back once
 * set: adding a `demos` token to the telemetry map meant overwriting tokens
 * whose holders nobody could name. A leak of either now holds one surface
 * rather than both.
 *
 * Two layers apply, in order. `requireOperatorFrom(secret)` verifies the
 * presented token against one map and admits nothing by itself; each router
 * then narrows to the roles it admits with `requireOperatorRole`. So a token
 * that landed in the wrong map — a `demos` principal in the telemetry secret,
 * or a `support` principal in Ace's secret — is refused by the router even
 * when the credential verifies, and a role added to the enum reaches no
 * surface until a router names it.
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

/** The secrets an operator router may verify against; each is one map of the shape above. */
export type OperatorSecretName = 'TELEMETRY_OPERATORS_JSON' | 'DEMO_OPERATORS_JSON';

/** Verify the bearer token against one secret's map. Admits nothing by itself: the router names its roles. */
export function requireOperatorFrom(secret: OperatorSecretName): MiddlewareHandler<HonoAppEnv> {
  return async (c, next) => {
    const authorization = c.req.header('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new ApiError(401, 'operator_authentication_required', 'A valid operator credential is required');
    }
    let operators: z.infer<typeof OperatorConfigurationSchema>;
    try {
      operators = OperatorConfigurationSchema.parse(JSON.parse(c.env[secret] ?? '') as unknown);
    } catch {
      throw new ApiError(503, 'operator_authentication_unavailable', 'Operator access is not configured');
    }
    const presented = authorization.slice(7);
    const matched = Object.entries(operators).find(([token]) => timingSafeEqualText(token, presented));
    if (!matched) {
      throw new ApiError(401, 'operator_authentication_invalid', 'The operator credential is invalid');
    }
    c.set('operator', matched[1]);
    await next();
  };
}

/** The telemetry surface's credential: `support` and `security`, from `TELEMETRY_OPERATORS_JSON`. */
export const requireTelemetryOperator = requireOperatorFrom('TELEMETRY_OPERATORS_JSON');

/** Ace's operator role, under its stored name. */
export const ACE_OPERATOR_ROLE = 'demos' satisfies TelemetryOperatorPrincipal['role'];

/** Ace's credential: the `demos` role, from `DEMO_OPERATORS_JSON`. */
export const requireAceOperator = requireOperatorFrom('DEMO_OPERATORS_JSON');

/** Refuse every operator whose role is not one the router is for. */
export function requireOperatorRole(
  ...roles: readonly [TelemetryOperatorPrincipal['role'], ...TelemetryOperatorPrincipal['role'][]]
): MiddlewareHandler<HonoAppEnv> {
  return async (c, next) => {
    if (!roles.includes(getOperator(c).role)) {
      throw new ApiError(403, 'operator_role_forbidden', 'This operator role cannot use this surface');
    }
    await next();
  };
}

export function getOperator(c: Parameters<MiddlewareHandler<HonoAppEnv>>[0]): TelemetryOperatorPrincipal {
  const principal = c.get('operator');
  if (!principal) throw new Error('operator_context_missing');
  return principal;
}
