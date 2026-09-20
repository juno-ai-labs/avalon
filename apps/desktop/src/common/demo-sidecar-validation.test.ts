import { expect, it } from 'vitest';
import { DemoMessageRequestSchema } from '@rally/contracts/demo-sidecar';
import { DemoBindingSchema } from './demo-sidecar-validation';
const id = '00000000-0000-4000-8000-000000000001';
it('refuses a missing launch binding and additional identity or transport fields', () => {
  expect(DemoBindingSchema.safeParse({}).success).toBe(false);
  const message = { representedUserId: id, workstreamId: id, substreamId: '0', clientMessageId: id, text: 'Hello' };
  expect(DemoMessageRequestSchema.safeParse(message).success).toBe(true);
  for (const patch of [{ operatorUserId: id }, { workspaceId: id }, { url: 'https://example.com' }, { role: 'owner' }, { text: '   ' }]) {
    expect(DemoMessageRequestSchema.safeParse({ ...message, ...patch }).success).toBe(false);
  }
});
