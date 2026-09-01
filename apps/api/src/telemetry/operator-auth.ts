import { STRICT_UUID_PATTERN } from "@rally/contracts/uuid-validation";
import { z } from 'zod/v3';
import type { MiddlewareHandler } from 'hono';
import type { HonoAppEnv } from '../env';
import { ApiError } from '../lib/api-error';
import { timingSafeEqualText } from '../lib/crypto';

const OperatorPrincipalSchema = z.object({
  operatorId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
  role: z.enum(['support', 'security']),
}).strict();

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

export function getTelemetryOperator(c: Parameters<MiddlewareHandler<HonoAppEnv>>[0]): TelemetryOperatorPrincipal {
  const principal = c.get('telemetryOperator');
  if (!principal) throw new Error('telemetry_operator_context_missing');
  return principal;
}
