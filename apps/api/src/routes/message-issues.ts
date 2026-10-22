import { CreateMessageIssueSchema, MessageIssueReceiptSchema } from '@rally/contracts/message-issues';
import { Hono } from 'hono';
import type { HonoAppEnv } from '../env';
import { getWorkspaceAuth, requireWorkspaceAuth } from '../middleware/auth';
import { zValidator } from '../middleware/validation';
import { MessageIssueService } from '../services/message-issue-service';

export const messageIssueRoutes = new Hono<HonoAppEnv>();
messageIssueRoutes.use('*', requireWorkspaceAuth);
messageIssueRoutes.post('/', zValidator('json', CreateMessageIssueSchema), async (c) =>
  c.json(MessageIssueReceiptSchema.parse(await new MessageIssueService(c.env, getWorkspaceAuth(c))
    .create(c.req.valid('json'))), 201));
