import { Hono } from 'hono';
import { z } from 'zod';
import type { HonoAppEnv } from '../env';
import { zValidator } from '../middleware/validation';
import { ACE_OPERATOR_ROLE, getOperator, requireAceOperator, requireOperatorRole } from '../telemetry/operator-auth';
import { ConnectorMaintenanceSelectionSchema, ConnectorMaintenanceOperationSchema,
  previewConnectorMaintenance, applyConnectorMaintenance, connectorMaintenanceStatus, cancelConnectorMaintenance,
} from '../services/connector-maintenance-service';

/** Explicit operator write authority; never inferred from a read-only inspection tool. */
export const connectorMaintenanceOperatorRoutes = new Hono<HonoAppEnv>();
connectorMaintenanceOperatorRoutes.use('*', requireAceOperator, requireOperatorRole(ACE_OPERATOR_ROLE));
const OperationParamSchema = z.strictObject({ id: z.string().uuid() });
connectorMaintenanceOperatorRoutes.post('/preview', zValidator('json', ConnectorMaintenanceSelectionSchema), async (c) =>
  c.json(ConnectorMaintenanceOperationSchema.parse(await previewConnectorMaintenance(c.env, c.req.valid('json'), getOperator(c).operatorId))));
connectorMaintenanceOperatorRoutes.get('/:id', zValidator('param', OperationParamSchema), async (c) =>
  c.json(ConnectorMaintenanceOperationSchema.parse(await connectorMaintenanceStatus(c.env, c.req.valid('param').id))));
connectorMaintenanceOperatorRoutes.post('/:id/apply', zValidator('param', OperationParamSchema), async (c) =>
  c.json(ConnectorMaintenanceOperationSchema.parse(await applyConnectorMaintenance(c.env, c.req.valid('param').id, false, getOperator(c).operatorId))));
connectorMaintenanceOperatorRoutes.post('/:id/resume', zValidator('param', OperationParamSchema), async (c) =>
  c.json(ConnectorMaintenanceOperationSchema.parse(await applyConnectorMaintenance(c.env, c.req.valid('param').id, true, getOperator(c).operatorId))));
connectorMaintenanceOperatorRoutes.post('/:id/cancel', zValidator('param', OperationParamSchema), async (c) =>
  c.json(ConnectorMaintenanceOperationSchema.parse(await cancelConnectorMaintenance(c.env, c.req.valid('param').id, getOperator(c).operatorId))));
