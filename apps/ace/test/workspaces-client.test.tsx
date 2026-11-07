import "../../../tests/isolated-region";
// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacesView, type RetiredWorkspace } from '../src/client/workspaces';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const WORKSPACE_ID = '00000000-0000-7000-8000-0000000000f1';
const OTHER_ID = '00000000-0000-7000-8000-0000000000f2';
const ROW = { id: WORKSPACE_ID, name: 'Alto Capital-demo', slug: 'alto-capital-demo', plan: 'starter' as const, region: 'enterprise' as const };
const OTHER_ROW = { id: OTHER_ID, name: 'Birch Partners', slug: 'birch', plan: 'growth' as const, region: 'global' as const };

/** The app holds the retired marks; the tab reports into it. */
function Harness(): React.JSX.Element {
  const [retired, setRetired] = useState<ReadonlyMap<string, RetiredWorkspace>>(new Map());
  return <WorkspacesView onRetired={(record) => setRetired((current) => new Map(current).set(record.workspace.id, record))} retired={retired} />;
}

function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function buttonContaining(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`no button containing ${text}`);
  return button;
}

async function search(text: string): Promise<void> {
  await act(async () => { type(container.querySelector<HTMLInputElement>('input[placeholder="Name, slug or workspace id"]')!, text); });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
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
    const receipt = { workspaceId: WORKSPACE_ID, complete: true, remaining: 0, parents: 3, retiredParents: 3, retiredChildren: 4, retainedOutbox: 1, failed: [] };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/directory/workspaces')) return Response.json({ results: [ROW], unavailableRegions: [] });
      if (url.endsWith('/retire') && init?.method === 'POST') return Response.json(receipt);
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    await act(async () => { root.render(<Harness />); });
    await search('Alto');
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
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ region: 'enterprise', confirmWorkspaceId: WORKSPACE_ID });
    // The aftermath names what closed, the form is gone, and the row is marked.
    expect(container.textContent).toContain('Retired');
    expect(container.textContent).toContain('All 3 Canvases, Sidekicks, Channels and Threads in the enterprise workspace are closed; this pass closed 3 of them, with 4 conversations under them. 1 queued effect will never publish.');
    expect(container.querySelector('.retire-receipt')?.textContent).toContain(WORKSPACE_ID);
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('Retire workspace'))).toBe(false);
    expect(container.querySelector('.workspaces > button.retired')).not.toBeNull();
    // The receipt is a result, so it takes focus rather than dropping it.
    expect(document.activeElement).toBe(container.querySelector('.retire-receipt'));
  });

  it('keeps the confirmation armed after an incomplete pass, with what remains, and scopes it to that workspace', async () => {
    const partial = {
      workspaceId: WORKSPACE_ID, complete: false, remaining: 1, parents: 3, retiredParents: 2, retiredChildren: 2, retainedOutbox: 0,
      failed: [{ parentKind: 'workstream', parentId: OTHER_ID, error: 'conversation_parent_identity_mismatch' }],
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/directory/workspaces')) return Response.json({ results: [ROW, OTHER_ROW], unavailableRegions: [] });
      if (url.endsWith('/retire') && init?.method === 'POST') return Response.json(partial);
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    await act(async () => { root.render(<Harness />); });
    await search('a');
    await search('al');
    await act(async () => { buttonContaining('Alto Capital-demo').click(); });
    await act(async () => { type(container.querySelector<HTMLInputElement>('input[placeholder="Paste the workspace id"]')!, WORKSPACE_ID); });
    await act(async () => { buttonContaining('Retire workspace').click(); });
    await act(async () => { await Promise.resolve(); });

    // Not retired: no receipt, no mark. The pass is reported with its counts
    // and the failed node, the id stays typed, and the button asks again.
    expect(container.querySelector('.retire-receipt')).toBeNull();
    expect(container.querySelector('.workspaces > button.retired')).toBeNull();
    expect(container.querySelector('.retire-incomplete')?.textContent).toContain('1 of 3 Canvases, Sidekicks, Channels and Threads is still open');
    expect(container.querySelector('.retire-incomplete')?.textContent).toContain('closed 2 of them and 2 conversations under them');
    expect(container.querySelector('.retire-incomplete li')?.textContent).toContain(`Thread ${OTHER_ID}`);
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Paste the workspace id"]')!.value).toBe(WORKSPACE_ID);
    expect(buttonContaining('Retire again').disabled).toBe(false);

    // Selecting another workspace shows nothing of the first one's pass.
    await act(async () => { buttonContaining('Birch Partners').click(); });
    expect(container.querySelector('.retire-incomplete')).toBeNull();
    expect(buttonContaining('Retire workspace').disabled).toBe(true);
  });

  it('shows a failed search as a failure, never as no matches', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: 'directory_unavailable', message: 'The enterprise directory did not answer' }, { status: 502 }));
    await act(async () => { root.render(<Harness />); });
    await search('Alto');
    expect(container.textContent).toContain('The enterprise directory did not answer');
    expect(container.textContent).toContain('Directory search failed');
    expect(container.textContent).not.toContain('No workspaces match');
    expect(container.textContent).not.toContain('Both regions searched');
  });

  it('says which region was not searched when only one directory answered', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ results: [OTHER_ROW], unavailableRegions: ['enterprise'] }));
    await act(async () => { root.render(<Harness />); });
    await search('bi');
    expect(container.textContent).toContain('Birch Partners');
    expect(container.textContent).toContain('The enterprise directory did not answer, so a workspace there would not be listed.');
    expect(container.textContent).toContain('enterprise directory did not answer');
    expect(container.textContent).not.toContain('Both regions searched');
  });

  it('moves a workspace to another plan in the region that owns it and shows the saved plan', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/directory/workspaces')) return Response.json({ results: [ROW], unavailableRegions: [] });
      if (url.endsWith('/plan') && init?.method === 'POST') return Response.json({ workspaceId: WORKSPACE_ID, plan: 'growth' });
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    await act(async () => { root.render(<Harness />); });
    await search('Alto');
    await act(async () => { buttonContaining('Alto Capital-demo').click(); });

    // The plan control is the tab's only select.
    const select = container.querySelector('select')!;
    expect(select.getAttribute('aria-label')).toBe('Plan');
    expect(select.value).toBe('starter');
    // Nothing to save until the plan differs from the current one.
    expect(buttonContaining('Save plan').disabled).toBe(true);
    await act(async () => {
      select.value = 'growth';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { buttonContaining('Save plan').click(); });
    await act(async () => { await Promise.resolve(); });

    const call = fetchMock.mock.calls.find((candidate) => String(candidate[0]).endsWith('/plan'));
    expect(String(call?.[0])).toBe(`/api/workspaces/${WORKSPACE_ID}/plan`);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ region: 'enterprise', plan: 'growth' });
    expect(container.querySelector('select')!.value).toBe('growth');
    expect(buttonContaining('Save plan').disabled).toBe(true);
  });
});
