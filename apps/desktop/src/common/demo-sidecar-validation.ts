import { IdSchema, RegionSchema } from '@rally/contracts';
import { z } from 'zod';
export const DemoBindingSchema = z.strictObject({ userId: IdSchema, workspaceId: IdSchema, region: RegionSchema });
