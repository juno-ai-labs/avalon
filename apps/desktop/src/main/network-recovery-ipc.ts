import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { describeZodIssues } from '@rally/contracts/zod-diagnostics';
import { NETWORK_RECOVERY_IPC } from '../common/network-recovery';
import type { NetworkRecovery } from './network-recovery';

const observationSchema = z.object({
  generation: z.number().int().nonnegative(),
  // Ticket identities, never credentials, query values or arbitrary URLs.
  target: z.string().regex(/^\/workspace\/socket$|^\/conversations\/[0-9a-f-]+\/substreams\/[0-9a-f-]+\/socket$/),
  outcome: z.enum(['timeout', 'accepted', 'failed', 'live']),
}).strict();

export function registerNetworkRecoveryIpc(dependencies: {
  ipc: Pick<IpcMain, 'handle'>;
  assertSender: (event: IpcMainInvokeEvent) => void;
  recovery: Pick<NetworkRecovery, 'observe' | 'state'>;
}): void {
  dependencies.ipc.handle(NETWORK_RECOVERY_IPC.state, (event) => {
    dependencies.assertSender(event);
    return dependencies.recovery.state;
  });
  dependencies.ipc.handle(NETWORK_RECOVERY_IPC.observe, (event, raw: unknown) => {
    dependencies.assertSender(event);
    const parsed = observationSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`network_ticket_observation:${describeZodIssues(parsed.error)}`);
    dependencies.recovery.observe(parsed.data);
    return dependencies.recovery.state;
  });
}
