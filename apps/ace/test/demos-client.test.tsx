// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemosView, currentPhase, emptyCast, operationHeadline } from '../src/client/demos';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const OPERATION_ID = '00000000-0000-7000-8000-0000000000e2';
const WORKSPACE_ID = '00000000-0000-7000-8000-0000000000f1';
const PRESENTER_ID = '00000000-0000-7000-8000-0000000000a1';
const COLLEAGUE_ID = '00000000-0000-7000-8000-0000000000a5';
// The cast are colleagues on the company's domain, seated in the demo.
const PRIYA_ID = '00000000-0000-7000-8000-0000000000a2';
const MARCUS_ID = '00000000-0000-7000-8000-0000000000a3';
const DANA_ID = '00000000-0000-7000-8000-0000000000a4';
// A second colleague whose display name is somebody else's: two of them in one
// demo is a mention nobody watching can attribute.
const NAMESAKE_ID = '00000000-0000-7000-8000-0000000000a6';

function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: OPERATION_ID,
    companyName: 'Alto Capital',
    presenterUserId: PRESENTER_ID,
    presenterName: 'Adam',
    packVersion: 'canvases-2026-11',
    cast: { presenter: PRESENTER_ID, priya: PRIYA_ID, marcus: MARCUS_ID, dana: DANA_ID },
    castNames: { presenter: 'Adam', priya: 'Priya Raman', marcus: 'Sam Burton', dana: 'Ben Diaz' },
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
      { phase: 'copying_connections', status: 'completed', attempt: 1, detail: { copied: [{ connectorType: 'google' }], skipped: [{ sourceConnectionId: 'c-linear', connectorType: 'linear', displayName: 'Linear', reason: 'shared_grant' }, { sourceConnectionId: 'c-slack', connectorType: 'slack', displayName: 'Slack', reason: 'personal_scope' }] }, error: null, startedAt: '2026-09-07T12:00:10.000Z', finishedAt: '2026-09-07T12:00:12.000Z' },
      { phase: 'seeding_conversations', status: 'completed', attempt: 1, detail: { confirmed: 9, total: 9 }, error: null, startedAt: '2026-09-07T12:00:12.000Z', finishedAt: '2026-09-07T12:01:00.000Z' },
      { phase: 'waiting_for_workspace', status: 'running', attempt: 1, detail: { gaps: [{ viewerUserId: PRESENTER_ID, room: 'northgate-renewal', code: 'mentioned', detail: 'the mention has not arrived' }] }, error: null, startedAt: '2026-09-07T12:01:00.000Z', finishedAt: null },
    ],
    seeding: { confirmed: 9, total: 9 },
    ...overrides,
  };
}

const template = {
  workspaceId: '01a06d5d-4624-751e-8269-e7950b51a835',
  pack: {
    version: 'canvases-2026-11',
    roles: ['presenter', 'priya', 'marcus', 'dana'],
    presenterRole: 'presenter',
    roleLabels: { priya: 'Solutions engineer / IT', marcus: 'Sales lead / business owner', dana: 'Manager / finance approver' },
  },
  members: [
    { userId: PRESENTER_ID, name: 'Adam', email: 'adam@rallywith.ai', role: 'owner' },
    { userId: COLLEAGUE_ID, name: 'Blake', email: 'blake@rallywith.ai', role: 'member' },
  ],
  // Ordered by address, as the regional API answers: the presenter is on the
  // company's domain too, so they are in this list as well as the members'.
  castCandidates: [
    { userId: PRESENTER_ID, name: 'Adam', email: 'adam@rallywith.ai' },
    { userId: COLLEAGUE_ID, name: 'Blake', email: 'blake@rallywith.ai' },
    { userId: DANA_ID, name: 'Ben Diaz', email: 'ben@rallywith.ai' },
    { userId: MARCUS_ID, name: 'Sam Burton', email: 'kb@rallywith.ai' },
    { userId: PRIYA_ID, name: 'Priya Raman', email: 'priya@rallywith.ai' },
    { userId: NAMESAKE_ID, name: 'Sam Burton', email: 'sam.burton@rallywith.ai' },
  ],
  castEmailDomain: 'rallywith.ai',
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
    // The gap names the person whose projection is behind, by the name the
    // demo carries, and the cast is on the page once the form is gone.
    expect(container.textContent).toContain('Adam: northgate-renewal');
    expect(container.textContent).toContain('the mention has not arrived');
    expect(container.textContent).toContain('Priya Raman, Sam Burton, Ben Diaz');
    expect(container.textContent).toContain('9 of 9 actions confirmed');
    // Retry is for a preparation that has stopped, not one that is working.
    expect(buttonNamed('Retry').disabled).toBe(true);
    // What was left behind, and why: one reason the template's owner can act
    // on, one they cannot.
    expect(container.textContent).toContain('1 connection copied · 2 left behind: Linear (grant not shareable), Slack (personal)');
    // No invented progress.
    expect(container.textContent).not.toMatch(/\d+%/u);
  });

  it('shows a failed preparation with its phase, reason and operation id, keeps the last gaps, and retries it', async () => {
    const failed = operation({
      status: 'failed', failedPhase: 'waiting_for_workspace',
      error: { code: 'demo_projection_wait_exhausted', message: 'The workspace did not match the pack within 510 readiness checks' },
      phases: [{ phase: 'waiting_for_workspace', status: 'failed', attempt: 1, detail: { gaps: [{ viewerUserId: PRESENTER_ID, room: 'northgate-renewal', code: 'mentioned', detail: 'the mention has not arrived' }] }, error: { code: 'demo_projection_wait_exhausted', message: 'The workspace did not match the pack within 510 readiness checks' }, startedAt: '2026-09-07T12:00:10.000Z', finishedAt: '2026-09-07T13:25:12.000Z' }],
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

  it('starts a new demo from typed names, seating a colleague only when the name is theirs alone', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(respond([]));
    await render();
    expect(container.textContent).toContain('No demos yet');
    await act(async () => { buttonNamed('New demo').click(); });
    const company = container.querySelector<HTMLInputElement>('input[placeholder="Alto Capital"]')!;
    await act(async () => { type(company, 'Alto Capital'); });
    const parts = Array.from(container.querySelectorAll<HTMLInputElement>('input[list="demo-cast-colleagues"]'));
    // Nobody is typed for the operator: a default could seat a real colleague.
    expect(parts.map((input) => input.value)).toEqual(['', '', '']);
    // Colleagues are suggested, but the presenter is in the demo already.
    const suggestions = container.querySelector('datalist')!.textContent;
    expect(suggestions).toContain('priya@rallywith.ai');
    expect(suggestions).not.toContain('adam@rallywith.ai');
    expect(container.textContent).toContain('Solutions engineer / IT');
    expect(container.textContent).toContain('Manager / finance approver');
    expect(buttonNamed('Start preparation').title).toBe('3 parts are still unnamed');

    await act(async () => { type(parts[0]!, 'priya raman'); });
    await act(async () => { type(parts[1]!, 'Jane Doe'); });
    // The presenter's own name is a collision like any other.
    await act(async () => { type(parts[2]!, 'Adam'); });
    expect(buttonNamed('Start preparation').disabled).toBe(true);
    expect(container.textContent).toContain('Two people in this demo are called');

    // Each field says what it will be, so a typo is not silently a placeholder.
    expect(container.textContent).toContain('Seats Priya Raman · priya@rallywith.ai');
    expect(container.textContent).toContain('Placeholder person: cannot sign in');
    // Two colleagues share this name, so it is played by a persona instead.
    await act(async () => { type(parts[2]!, 'Sam Burton'); });
    const start = buttonNamed('Start preparation');
    expect(start.disabled).toBe(false);
    await act(async () => { start.click(); });
    await act(async () => { await Promise.resolve(); });
    const startCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/api/demos') && call[1]?.method === 'POST');
    const body = JSON.parse(String(startCall?.[1]?.body)) as { presenterUserId: string; cast: Record<string, unknown> };
    expect(body.presenterUserId).toBe(PRESENTER_ID);
    expect(body.cast).toEqual({ priya: PRIYA_ID, marcus: { name: 'Jane Doe' }, dana: { name: 'Sam Burton' } });
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
    expect(container.textContent).toContain('account menu');
    expect(container.textContent).toContain('multiple-workspaces-enabled');
    expect(buttonNamed('Refresh')).toBeDefined();
  });

  it('keeps trying while offline even when nothing is running, so the banner tells the truth', async () => {
    // Every operation is ready, so no running poll exists; a failed Refresh
    // must still be followed by another read, or "the page keeps trying" is a lie.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(respond([operation({ status: 'ready', readyAt: '2026-09-07T12:02:00.000Z', phases: [] })]));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await render();
      fetchMock.mockImplementation(async () => { throw new Error('offline'); });
      await act(async () => { buttonNamed('Refresh').click(); });
      await act(async () => { await Promise.resolve(); });
      expect(container.querySelector('.demo-stale')!.textContent).toContain('keeps trying');
      const before = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/api/demos')).length;
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
      expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/api/demos')).length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a retried operation by its current attempt, not by a stale row from the last one', async () => {
    // Attempt 2 has re-run the first phase; attempt 1's wait row is still on
    // the operation, still "running", and must not read as where attempt 2 is.
    const retried = operation({
      attempt: 2,
      phases: [
        { phase: 'checking_template', status: 'running', attempt: 2, detail: {}, error: null, startedAt: '2026-09-07T13:00:00.000Z', finishedAt: null },
        { phase: 'waiting_for_workspace', status: 'running', attempt: 1, detail: { gaps: [] }, error: null, startedAt: '2026-09-07T12:01:00.000Z', finishedAt: null },
      ],
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(respond([retried]));
    await render();
    expect(currentPhase(retried as never)?.phase).toBe('checking_template');
    expect(container.querySelector('.queue-detail-header p')?.textContent).toBe('Checking template');
    expect(container.textContent).toContain('From attempt 1 · not reached yet by this attempt');
  });

  it('says why when the template seats nobody to present, instead of a form that cannot be submitted', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(respond([], { template: () => Response.json({ ...template, members: [] }) }));
    await render();
    expect(container.textContent).toContain('demo-template has no active members, and the presenter is cast from them.');
    // Not "the template could not be read": it read fine, and Refresh will not change it.
    expect(container.textContent).toContain('Nobody to present');
    expect(container.textContent).not.toContain('Template unavailable');
    expect(buttonNamed('New demo').disabled).toBe(true);
  });

  it('opens the form when the company has fewer people than parts, since names can be typed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(respond([], {
      template: () => Response.json({ ...template, castCandidates: template.castCandidates.slice(0, 1) }),
    }));
    await render();
    expect(buttonNamed('New demo').disabled).toBe(false);
    expect(container.textContent).not.toContain('Nobody to present');
  });
});

describe('what an operation says about itself', () => {
  it('reads the running phase first, then a failure, then the last recorded one', () => {
    expect(currentPhase(operation() as never)?.phase).toBe('waiting_for_workspace');
    expect(operationHeadline(operation() as never)).toBe('Waiting for workspace');
    expect(operationHeadline(operation({ status: 'ready', readyAt: '2026-09-07T12:02:00.000Z' }) as never)).toBe('Ready');
    expect(operationHeadline(operation({ status: 'ready', retiredAt: '2026-09-07T13:00:00.000Z' }) as never)).toBe('Retired');
    // An abandoned candidate that was then closed is still abandoned, not "Retired".
    expect(operationHeadline(operation({ status: 'abandoned', retiredAt: '2026-09-07T13:00:00.000Z' }) as never)).toBe('Abandoned · candidate closed');
    expect(operationHeadline(operation({ status: 'failed', failedPhase: 'seeding_conversations' }) as never)).toBe('Failed: seeding conversations');
    expect(operationHeadline(operation({ phases: [] }) as never)).toBe('Starting');
  });

  it('opens the form with every part uncast, and never asks for the presenter\'s', () => {
    expect(emptyCast(template as never)).toEqual({ priya: '', marcus: '', dana: '' });
  });
});
