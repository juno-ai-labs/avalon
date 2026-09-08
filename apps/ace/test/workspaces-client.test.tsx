// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacesView } from '../src/client/workspaces';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const WORKSPACE_ID = '00000000-0000-7000-8000-0000000000f1';

function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function buttonContaining(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`no button containing ${text}`);
  return button;
}

describe('the workspaces tab', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('retires only once the operator has typed the workspace id, in the region that owns it, and shows what closed', async () => {
    const receipt = { workspaceId: WORKSPACE_ID, complete: true, remaining: 0, retiredParents: 3, retiredChildren: 4, retainedOutbox: 1, failed: [] };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/directory/workspaces')) {
        return Response.json({ results: [{ id: WORKSPACE_ID, name: 'Alto Capital-demo', slug: 'alto-capital-demo', region: 'eu' }] });
      }
      if (url.endsWith('/retire') && init?.method === 'POST') return Response.json(receipt);
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    await act(async () => { root.render(<WorkspacesView />); });

    await act(async () => { type(container.querySelector<HTMLInputElement>('input[placeholder="Alto Capital-demo"]')!, 'Alto'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await act(async () => { buttonContaining('Alto Capital-demo').click(); });

    const retire = buttonContaining('Retire workspace');
    // A click beside the name does nothing: the button is disabled until the
    // typed id matches, a near miss keeps it disabled, and the field does not
    // print the answer.
    expect(retire.disabled).toBe(true);
    const confirmation = container.querySelector<HTMLInputElement>('input[placeholder="Paste the workspace id"]')!;
    expect(confirmation.placeholder).not.toContain(WORKSPACE_ID);
    await act(async () => { type(confirmation, WORKSPACE_ID.slice(0, -1)); });
    expect(retire.disabled).toBe(true);
    await act(async () => { type(confirmation, WORKSPACE_ID); });
    expect(retire.disabled).toBe(false);

    await act(async () => { retire.click(); });
    await act(async () => { await Promise.resolve(); });
    const call = fetchMock.mock.calls.find((candidate) => String(candidate[0]).endsWith('/retire'));
    expect(String(call?.[0])).toBe(`/api/workspaces/${WORKSPACE_ID}/retire`);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ region: 'eu', confirmWorkspaceId: WORKSPACE_ID });
    // The aftermath names what closed, the form is gone, and the row is marked.
    expect(container.textContent).toContain('Retired');
    expect(container.textContent).toContain('Closed 3 work streams and automations and 4 conversations under them. 1 queued effect will never publish.');
    expect(container.querySelector('.demo-receipt')?.textContent).toContain(WORKSPACE_ID);
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('Retire workspace'))).toBe(false);
    expect(container.querySelector('.workspaces > button.retired')).not.toBeNull();
  });

  it('shows a failed search as a failure, never as no matches', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: 'directory_unavailable', message: 'The EU directory did not answer' }, { status: 502 }));
    await act(async () => { root.render(<WorkspacesView />); });
    await act(async () => { type(container.querySelector<HTMLInputElement>('input[placeholder="Alto Capital-demo"]')!, 'Alto'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(container.textContent).toContain('The EU directory did not answer');
    expect(container.textContent).toContain('Directory search failed');
    expect(container.textContent).not.toContain('No workspaces match');
    expect(container.textContent).not.toContain('Both regions searched');
  });
});
