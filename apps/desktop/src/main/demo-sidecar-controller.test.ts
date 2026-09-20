import { expect, it, vi } from 'vitest';
import { DemoSidecarController, type DemoBinding } from './demo-sidecar-controller';
const one: DemoBinding = { userId: 'operator', workspaceId: 'demo1', region: 'global' };
const two: DemoBinding = { ...one, workspaceId: 'demo2' };
it('focuses the same demo, pins separate demos, and closes all on regular organization navigation', async () => {
  const created: { owner: DemoBinding; close: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }[] = [];
  const controller = new DemoSidecarController(async binding => binding.workspaceId !== 'regular', async owner => {
    const win = { owner, close: vi.fn(), focus: vi.fn() }; created.push(win); return win;
  });
  await controller.observe(one);
  await controller.open(one);
  await controller.open(one);
  expect(created).toHaveLength(1);
  expect(created[0]?.focus).toHaveBeenCalled();
  await controller.observe(two);
  await controller.open(two);
  expect(created.map(window => window.owner.workspaceId)).toEqual(['demo1', 'demo2']);
  await controller.observe({ ...one, workspaceId: 'regular' });
  expect(created.every(window => window.close.mock.calls.length === 1)).toBe(true);
});
it('does not open a stale launch after sign-out during eligibility lookup', async () => {
  let resolve!: (value: boolean) => void;
  const eligible = vi.fn().mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done; }));
  const create = vi.fn();
  const controller = new DemoSidecarController(eligible, create);
  await controller.observe(one);
  const opening = controller.open(one);
  await controller.observe(null);
  resolve(true);
  await expect(opening).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});
it('waits for an already pending navigation decision before treating the binding as available', async () => {
  let resolve!: (value: boolean) => void;
  const controller = new DemoSidecarController(() => new Promise<boolean>(done => { resolve = done; }), vi.fn());
  const first = controller.observe(one);
  let completed = false;
  const second = controller.observe(one).then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);
  resolve(true);
  await Promise.all([first, second]);
  expect(controller.mayUse(one)).toBe(true);
});
it('can retry eligibility after a transient navigation failure', async () => {
  const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const controller = new DemoSidecarController(check, async () => ({ close: vi.fn(), focus: vi.fn() }));
  await controller.observe(one);
  expect(controller.mayUse(one)).toBe(false);
  await controller.observe(one);
  await expect(controller.open(one)).resolves.toBeUndefined();
});
