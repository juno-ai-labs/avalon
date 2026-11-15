import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { usePreparedCanvases } from '../../../../mobile/src/prepared-canvases';
import type { MobileCommand, MobileSnapshot } from '../../../../mobile/src/protocol';

// Run the native hook with the DOM harness's React instance (mobile uses SDK 58's React).
vi.mock('../../../../mobile/node_modules/react', async () => import('react'));
vi.mock('../../../../mobile/node_modules/expo-crypto', () => ({ randomUUID: () => crypto.randomUUID() }));

it('fences prepared descriptors and pending access replies to the signed-in organization', async () => {
  const directory = { userId: 'alice', workspaceId: 'work', pins: ['shopping'], loading: false } as MobileSnapshot;
  const descriptor = { canvasId: 'shopping', resourceId: 'site', version: 1, title: 'Shopping' };
  const artifact = { canvasId: 'shopping', resourceId: 'site', version: 1, openUrl: 'https://site.rallyusercontent.com/open#one', canonicalUrl: 'https://site.rallyusercontent.com/' };
  const sent: MobileCommand[] = [];
  const send = (command: MobileCommand) => { sent.push(command); };
  const hook = renderHook(({ directory }) => usePreparedCanvases(directory, send, () => undefined), { initialProps: { directory } });
  act(() => { hook.result.current.receive({ type: 'snapshot', snapshot: directory }); });
  act(() => { hook.result.current.receive({ type: 'prepared-canvas', userId: 'alice', workspaceId: 'work', canvasId: 'shopping', canvas: descriptor }); });
  expect(hook.result.current.canvases.shopping).toEqual(descriptor);
  act(() => hook.result.current.rememberSession('alice:work', artifact));
  expect(hook.result.current.sessions.shopping).toEqual({ ...artifact, openUrl: 'https://site.rallyusercontent.com/' });
  let opening!: Promise<unknown>;
  act(() => { opening = hook.result.current.open(descriptor); });
  const request = sent[0];
  if (request?.type !== 'open-prepared-artifact') throw new Error('Expected an artifact request');
  act(() => hook.rerender({ directory: { ...directory, workspaceId: 'other' } }));
  expect(hook.result.current.canvases).toEqual({});
  expect(hook.result.current.sessions).toEqual({});
  act(() => hook.result.current.rememberSession("alice:work", artifact));
  expect(hook.result.current.sessions).toEqual({});
  await expect(opening).resolves.toBeNull();
  act(() => { hook.result.current.receive({ type: 'prepared-artifact', requestId: request.requestId, artifact }); });
  expect(hook.result.current.canvases).toEqual({});
  act(() => { hook.result.current.receive({ type: 'prepared-canvas', userId: 'alice', workspaceId: 'work', canvasId: 'shopping', canvas: descriptor }); });
  expect(hook.result.current.canvases).toEqual({});
  hook.unmount();
});

it('holds opens while the shared browser reloads and re-sends them once it is authenticated', async () => {
  const directory = { userId: 'alice', workspaceId: 'work', pins: ['shopping'], loading: false } as MobileSnapshot;
  const descriptor = { canvasId: 'shopping', resourceId: 'site', version: 1, title: 'Shopping' };
  const artifact = { canvasId: 'shopping', resourceId: 'site', version: 1, openUrl: 'https://site.rallyusercontent.com/open#one', canonicalUrl: 'https://site.rallyusercontent.com/' };
  const sent: MobileCommand[] = [];
  const send = (command: MobileCommand) => { sent.push(command); };
  const wake = vi.fn();
  const hook = renderHook(() => usePreparedCanvases(directory, send, wake));
  let opening!: Promise<unknown>;
  act(() => { opening = hook.result.current.open(descriptor); });
  expect(wake).toHaveBeenCalledOnce();
  expect(sent).toHaveLength(0);
  act(() => { hook.result.current.receive({ type: 'snapshot', snapshot: directory }); });
  expect(sent).toHaveLength(1);
  const request = sent[0];
  if (request?.type !== 'open-prepared-artifact') throw new Error('Expected an artifact request');
  act(() => hook.result.current.reset());
  act(() => { hook.result.current.receive({ type: 'ready' }); }); // The sign-in/picker page is not a business API host.
  expect(sent).toHaveLength(1);
  act(() => { hook.result.current.receive({ type: 'snapshot', snapshot: directory }); });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(request);
  act(() => { hook.result.current.receive({ type: 'prepared-artifact', requestId: request.requestId, artifact }); });
  await expect(opening).resolves.toEqual(artifact);
  let failing!: Promise<unknown>;
  act(() => { failing = hook.result.current.open(descriptor); });
  act(() => hook.result.current.fail());
  await expect(failing).resolves.toBeNull();
  hook.unmount();
});
