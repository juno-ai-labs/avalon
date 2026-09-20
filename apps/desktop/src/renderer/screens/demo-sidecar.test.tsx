import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { asSubstreamId } from '@rally/contracts';
import { DemoSidecarScreen } from './demo-sidecar';
import type { DemoSidecarBridge } from '../../common/demo-sidecar';
const person = '00000000-0000-4000-8000-000000000001';
const room = '00000000-0000-4000-8000-000000000002';
const organization = '00000000-0000-4000-8000-000000000003';
const catalog = { workspaceId: organization, workspaceName: 'Demo', operatorName: 'Operator', participants: [
  { userId: person, name: 'Ada', destinations: [{ workstreamId: room, substreamId: asSubstreamId('0'), label: 'Launch' }] },
] };
function select(label: string, option: string): void {
  fireEvent.keyDown(screen.getByRole('combobox', { name: label }), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: option }));
}
it('submits once, retries the immutable attempt, and creates a fresh empty card without polling', async () => {
  let resolve!: (result: Awaited<ReturnType<DemoSidecarBridge['send']>>) => void;
  const bridge: DemoSidecarBridge = { catalog: vi.fn<DemoSidecarBridge['catalog']>(async () => ({ ok: true, data: catalog })),
    send: vi.fn<DemoSidecarBridge['send']>(() => new Promise(done => { resolve = done; })), onThemeChanged: () => () => undefined };
  render(<DemoSidecarScreen bridge={bridge} />);
  await screen.findByRole('button', { name: 'New message' });
  select('Participant for message 1', 'Ada');
  select('Destination for message 1', 'Launch');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello team' } });
  const send = screen.getByRole('button', { name: 'Send message' });
  fireEvent.click(send); fireEvent.click(send);
  expect(bridge.send).toHaveBeenCalledTimes(1);
  const first = vi.mocked(bridge.send).mock.calls[0]?.[0];
  await act(async () => resolve({ ok: false, kind: 'unknown' }));
  expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
  fireEvent.click(screen.getByRole('button', { name: 'Retry same message' }));
  expect(vi.mocked(bridge.send).mock.calls[1]?.[0]).toEqual(first);
  await act(async () => resolve({ ok: true, data: { turnId: room } }));
  fireEvent.click(screen.getByRole('button', { name: 'New message' }));
  const next = screen.getByRole('region', { name: 'Message 2' });
  expect(within(next).getByRole('textbox')).toHaveValue('');
  expect(within(next).getByRole('combobox', { name: /Destination/ })).toHaveTextContent('Launch');
  expect(bridge.catalog).toHaveBeenCalledTimes(1);
});
it('shows denial without leaving an enabled composer', async () => {
  const bridge: DemoSidecarBridge = { catalog: vi.fn<DemoSidecarBridge['catalog']>(async () => ({ ok: false, kind: 'denied' })), send: vi.fn(), onThemeChanged: () => () => undefined };
  render(<DemoSidecarScreen bridge={bridge} />);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('unavailable'));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(bridge.send).not.toHaveBeenCalled();
});
