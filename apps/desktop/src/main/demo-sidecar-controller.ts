import type { Region } from '@rally/contracts/regions';
export interface DemoBinding { userId: string; workspaceId: string; region: Region }
interface SidecarWindow { close(): void; focus(): void }
export function demoBindingKey(binding: DemoBinding): string { return JSON.stringify([binding.region, binding.workspaceId, binding.userId]); }

/** Session/navigation ownership. No renderer can retarget an existing window. */
export class DemoSidecarController {
  private current: DemoBinding | null = null;
  private generation = 0;
  private eligible = false;
  private observing = false;
  private observation: Promise<void> = Promise.resolve();
  private readonly windows = new Map<string, SidecarWindow>();
  private readonly openings = new Map<string, Promise<void>>();
  constructor(private readonly check: (binding: DemoBinding) => Promise<boolean>,
    private readonly create: (binding: DemoBinding) => Promise<SidecarWindow>) {}
  observe(binding: DemoBinding | null): Promise<void> {
    if (binding && this.current && demoBindingKey(binding) === demoBindingKey(this.current) && (this.eligible || this.observing)) return this.observation;
    const generation = ++this.generation;
    if (!binding || binding.userId !== this.current?.userId) this.closeAll();
    this.current = binding;
    this.eligible = false;
    this.observing = true;
    this.observation = (async () => {
      if (!binding) return;
      const eligible = await this.check(binding).catch(() => false);
      if (generation !== this.generation) return;
      this.eligible = eligible;
      if (!eligible) this.closeAll();
    })().finally(() => { if (generation === this.generation) this.observing = false; });
    return this.observation;
  }
  mayUse(binding: DemoBinding): boolean {
    return this.eligible && this.current?.userId === binding.userId;
  }
  async open(binding: DemoBinding): Promise<void> {
    const key = demoBindingKey(binding);
    const pending = this.openings.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const opening = (async () => {
      if (!await this.check(binding) || generation !== this.generation || !this.mayUse(binding)
        || !this.current || demoBindingKey(this.current) !== key) throw new Error('Demo sidecar is no longer available');
      const existing = this.windows.get(key);
      if (existing) { existing.focus(); return; }
      const window = await this.create({ ...binding });
      if (generation !== this.generation) { window.close(); throw new Error('Demo sidecar launch was superseded'); }
      this.windows.set(key, window);
      window.focus();
    })();
    this.openings.set(key, opening);
    try { await opening; } finally { this.openings.delete(key); }
  }
  forget(binding: DemoBinding): void { this.windows.delete(demoBindingKey(binding)); }
  private closeAll(): void {
    for (const window of this.windows.values()) window.close();
    this.windows.clear();
  }
}
