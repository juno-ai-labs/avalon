import type { DemoCatalog, DemoMessageRequest } from '@rally/contracts/demo-sidecar';
import type { ThemeChoice } from './themes';
export type DemoReply<T> = { ok: true; data: T } | { ok: false; kind: 'denied' | 'failed' | 'unknown' };
export interface DemoSidecarBridge {
  catalog(): Promise<DemoReply<DemoCatalog>>;
  send(input: DemoMessageRequest): Promise<DemoReply<{ turnId: string }>>;
  onThemeChanged(listener: (choice: ThemeChoice) => void): () => void;
}
declare global { interface Window { demoSidecar: DemoSidecarBridge } }
