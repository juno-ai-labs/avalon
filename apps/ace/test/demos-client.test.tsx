// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemosView, currentPhase, defaultCast, operationHeadline } from '../src/client/demos';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const OPERATION_ID = '00000000-0000-7000-8000-0000000000e2';
const WORKSPACE_ID = '00000000-0000-7000-8000-0000000000f1';
const PRESENTER_ID = '00000000-0000-7000-8000-0000000000a1';
const PRIYA_ID = '00000000-0000-7000-8000-0000000000a2';
const MARCUS_ID = '00000000-0000-7000-8000-0000000000a3';
const DANA_ID = '00000000-0000-7000-8000-0000000000a4';

function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: OPERATION_ID,
    companyName: 'Alto Capital',
    presenterUserId: PRESENTER_ID,
    presenterName: 'Adam',
    packVersion: 'placeholder-2026-09',
    cast: { presenter: PRESENTER_ID },
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Alto Capital-demo',
    status: 'running',
    attempt: 1,
    failedPhase: null,
    error: null,
    createdAt: '2026-09-07T12:00:00.000Z',
    updatedAt: '2026-09-07T12:01:00.000Z',
    readyAt: null,
    retiredAt: null,
    phases: [
      { phase: 'checking_template', status: 'completed', attempt: 1, detail: { templateConnections: 2 }, error: null, startedAt: '2026-09-07T12:00:00.000Z', finishedAt: '2026-09-07T12:00:05.000Z' },
      { phase: 'creating_workspace', status: 'completed', attempt: 1, detail: { members: 4 }, error: null, startedAt: '2026-09-07T12:00:05.000Z', finishedAt: '2026-09-07T12:00:10.000Z' },
      { phase: 'copying_connections', status: 'completed', attempt: 1, detail: { copied: [{ connectorType: 'google' }], skipped: [] }, error: null, startedAt: '2026-09-07T12:00:10.000Z', finishedAt: '2026-09-07T12:00:12.000Z' },
      { phase: 'seeding_conversations', status: 'completed', attempt: 1, detail: { confirmed: 9, total: 9 }, error: null, startedAt: '2026-09-07T12:00:12.000Z', finishedAt: '2026-09-07T12:01:00.000Z' },
      { phase: 'waiting_for_workspace', status: 'running', attempt: 1, detail: { gaps: [{ room: 'northgate-renewal', code: 'mentioned', detail: 'the mention has not arrived' }] }, error: null, startedAt: '2026-09-07T12:01:00.000Z', finishedAt: null },
    ],
    seeding: { confirmed: 9, total: 9 },
    ...overrides,
  };
}

const template = {
  workspaceId: '01a06d5d-4624-751e-8269-e7950b51a835',
  pack: { version: 'placeholder-2026-09', roles: ['presenter', 'priya', 'marcus', 'dana'] },
  members: [
    { userId: PRESENTER_ID, name: 'Adam', email: 'adam@example.com', role: 'owner' },
    { userId: PRIYA_ID, name: 'Priya Raman', email: 'priya@example.com', role: 'member' },
    { userId: MARCUS_ID, name: 'Marcus Hale', email: 'marcus@example.com', role: 'member' },
    { userId: DANA_ID, name: 'Dana Okafor', email: 'dana@example.com', role: 'member' },
  ],
};

function respond(operations: unknown[], options: { template?: Response | (() => Response) } = {}): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/api/demos/template')) {
      const custom = options.template;
      return custom ? (typeof custom === 'function' ? custom() : custom) : Response.json(template);
    }
    if (url.endsWith('/api/demos') && (init?.method ?? 'GET') === 'GET') return Response.json({ operations });
    if (url.endsWith('/api/demos') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { operationId: string; companyName: string };
      return Response.json(operation({ operationId: body.operationId, companyName: body.companyName, phases: [], seeding: { confirmed: 0, total: 9 }, workspaceId: null, workspaceName: null }));
    }
    if (url.endsWith('/retry')) return Response.json(operation({ status: 'running', attempt: 2, failedPhase: null, error: null }));
    if (url.endsWith('/abandon')) return Response.json(operation({ status: 'abandoned' }));
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
}

async function render(): Promise<void> {
  await act(async () => { root.render(<DemosView />); });
  await act(async () => { await Promise.resolve(); });
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent === name);
  if (!button) throw new Error(`no button named ${name}`);
  return button;
}

function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('the Demos page', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('names the phase an operation is in, when it started, and lists what has not arrived', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(respond([operation()]));
    await render();
    expect(container.textContent).toContain('Alto Capital-demo');
    expect(container.textContent).toContain('Waiting for workspace');
    expect(container.textContent).toContain('In progress · started');
    expect(container.textContent).toContain('the mention has not arrived');
    expect(container.textContent).toContain('9 of 9 actions confirmed');
    // No invented progress.
    expect(container.textContent).not.toMatch(/\d+%/u);
  });

  it('shows a failed preparation with its phase, reason and operation id, keeps the last gaps, and retries it', async () => {
    const failed = operation({
      status: 'failed', failedPhase: 'waiting_for_workspace',
      error: { code: 'demo_projection_wait_exhausted', message: 'The workspace did not match the pack within 510 readiness checks' },
      phases: [{ phase: 'waiting_for_workspace', status: 'failed', attempt: 1, detail: { gaps: [{ room: 'northgate-renewal', code: 'mentioned', detail: 'the mention has not arrived' }] }, error: { code: 'demo_projection_wait_exhausted', message: 'The workspace did not match the pack within 510 readiness checks' }, startedAt: '2026-09-07T12:00:10.000Z', finishedAt: '2026-09-07T13:25:12.000Z' }],
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(respond([failed]));
    await render();
    expect(container.textContent).toContain('Failed: waiting for workspace');
    expect(container.textContent).toContain('demo_projection_wait_exhausted');
    expect(container.textContent).toContain(OPERATION_ID);
    // The explanation survives the failure: the gaps the last round recorded.
    expect(container.textContent).toContain('the mention has not arrived');
    // Once, not once per region of the page.
    expect(container.textContent.split('demo_projection_wait_exhausted')).toHaveLength(2);
    await act(async () => { buttonNamed('Retry').click(); });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith(`/api/demos/${OPERATION_ID}/retry`))).toBe(true);
    expect(container.textContent).toContain('Attempt 2');
  });

  it('abandons only once the operator has typed the operation id, and sends it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(respond([operation({ status: 'failed', failedPhase: 'copying_connections', error: { code: 'x', message: 'y' }, phases: [] })]));
    await render();
    await act(async () => { buttonNamed('Abandon…').click(); });
    const abandon = buttonNamed('Abandon preparation');
    expect(abandon.disabled).toBe(true);
    const confirmation = container.querySelector<HTMLInputElement>('input[placeholder="Paste the operation id"]')!;
    await act(async () => { type(confirmation, OPERATION_ID.slice(0, -1)); });
    expect(buttonNamed('Abandon preparation').disabled).toBe(true);
    await act(async () => { type(confirmation, OPERATION_ID); });
    expect(buttonNamed('Abandon preparation').disabled).toBe(false);
    await act(async () => { buttonNamed('Abandon preparation').click(); });
    await act(async () => { await Promise.resolve(); });
    const call = fetchMock.mock.calls.find((candidate) => String(candidate[0]).endsWith('/abandon'));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ confirmOperationId: OPERATION_ID });
    expect(container.textContent).toContain('Abandoned');
  });

  it('starts a new demo from the template with one operation id and a cast nobody plays twice', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(respond([]));
    await render();
    expect(container.textContent).toContain('No demos yet');
    await act(async () => { buttonNamed('New demo').click(); });
    const company = container.querySelector<HTMLInputElement>('input[placeholder="Alto Capital"]')!;
    await act(async () => { type(company, 'Alto Capital'); });
    // The defaults are the ones a person would pick: each non-presenter role
    // gets the next member, in order, and the labels are names, not keys.
    const selects = Array.from(container.querySelectorAll('select'));
    expect(selects.map((select) => select.value)).toEqual([PRESENTER_ID, PRIYA_ID, MARCUS_ID, DANA_ID]);
    expect(container.textContent).toContain('Cast: Priya');
    expect(container.textContent).not.toContain('Cast: priya');

    // Seating one member twice blocks Start and says who.
    const marcusSelect = selects[2]!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(marcusSelect, PRIYA_ID);
      marcusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(buttonNamed('Start preparation').disabled).toBe(true);
    expect(container.textContent).toContain('Priya Raman is cast in two roles');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(marcusSelect, MARCUS_ID);
      marcusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const start = buttonNamed('Start preparation');
    expect(start.disabled).toBe(false);
    await act(async () => { start.click(); });
    await act(async () => { await Promise.resolve(); });
    const startCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/api/demos') && call[1]?.method === 'POST');
    const body = JSON.parse(String(startCall?.[1]?.body)) as { operationId: string; companyName: string; presenterUserId: string; cast: Record<string, string> };
    expect(body.companyName).toBe('Alto Capital');
    expect(body.presenterUserId).toBe(PRESENTER_ID);
    expect(body.cast).toEqual({ presenter: PRESENTER_ID, priya: PRIYA_ID, marcus: MARCUS_ID, dana: DANA_ID });
    expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(container.textContent).toContain('Alto Capital-demo');
  });

  it('reads the template before judging it, and says why when it cannot be read', async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<Response>((resolve) => { release = () => resolve(Response.json({ error: 'regional_api_not_configured', message: 'The regional API base URL is not configured' }, { status: 503 })); });
    vi.spyOn(globalThis, 'fetch').mockImplementation(respond([], { template: () => pending as unknown as Response }));
    // While the template is on its way, the page does not claim it is missing.
    await act(async () => { root.render(<DemosView />); });
    expect(container.textContent).toContain('Reading the template');
    expect(container.textContent).not.toContain('Template unavailable');
    await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('Template unavailable: The regional API base URL is not configured');
    expect(buttonNamed('New demo').disabled).toBe(true);
  });

  it('keeps the last known state, dated, when the regional API stops answering', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(respond([operation()]));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await render();
      expect(container.textContent).toContain('Regional API connected');
      fetchMock.mockImplementation(async () => { throw new Error('offline'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
      const first = container.querySelector('.demo-stale')!.textContent;
      expect(first).toContain('Offline since');
      expect(container.textContent).toContain('Alto Capital-demo');
      // The banner dates the outage, not the latest failed poll.
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
      expect(container.querySelector('.demo-stale')!.textContent).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the operator what to do with a ready demo, and offers Refresh throughout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(respond([operation({ status: 'ready', readyAt: '2026-09-07T12:02:00.000Z', phases: [] })]));
    await render();
    expect(container.textContent).toContain('Tell the presenter to switch to Alto Capital-demo');
    expect(buttonNamed('Refresh')).toBeDefined();
  });
});

describe('what an operation says about itself', () => {
  it('reads the running phase first, then a failure, then the last recorded one', () => {
    expect(currentPhase(operation() as never)?.phase).toBe('waiting_for_workspace');
    expect(operationHeadline(operation() as never)).toBe('Waiting for workspace');
    expect(operationHeadline(operation({ status: 'ready', readyAt: '2026-09-07T12:02:00.000Z' }) as never)).toBe('Ready');
    expect(operationHeadline(operation({ status: 'ready', retiredAt: '2026-09-07T13:00:00.000Z' }) as never)).toBe('Retired');
    expect(operationHeadline(operation({ status: 'failed', failedPhase: 'seeding_conversations' }) as never)).toBe('Failed: seeding conversations');
    expect(operationHeadline(operation({ phases: [] }) as never)).toBe('Starting');
  });

  it('deals the default cast out in order, never seating the presenter twice', () => {
    expect(defaultCast(template as never, PRESENTER_ID)).toEqual({ presenter: PRESENTER_ID, priya: PRIYA_ID, marcus: MARCUS_ID, dana: DANA_ID });
    // Another presenter: the others shift to fill the roles in order.
    expect(defaultCast(template as never, MARCUS_ID)).toEqual({ presenter: MARCUS_ID, priya: PRESENTER_ID, marcus: PRIYA_ID, dana: DANA_ID });
  });
});
