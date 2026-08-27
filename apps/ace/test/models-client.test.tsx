// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelsView, moveFallback, routingFromFlag } from '../src/client/models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function workstreamFlag(routing: { model: string; fallbackModels: string[] }): object {
  return {
    key: 'agent-model-workstream',
    enabled: true,
    default_variation: 'current',
    variations: { current: routing },
  };
}

describe('Ace Models client', () => {
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

  it('reads the current default variation and falls back to the checked-in route when malformed', () => {
    expect(routingFromFlag(workstreamFlag({ model: 'custom/current', fallbackModels: ['custom/backup'] }), 'workstream'))
      .toMatchObject({ source: 'flagship', routing: { model: 'custom/current', fallbackModels: ['custom/backup'] } });
    expect(routingFromFlag(workstreamFlag({ model: '', fallbackModels: [] }), 'workstream'))
      .toMatchObject({ source: 'checked-in', routing: { model: 'x-ai/grok-4.3', fallbackModels: ['google/gemini-3.6-flash'] } });
    expect(routingFromFlag({
      ...workstreamFlag({ model: 'ignored', fallbackModels: [] }),
      variations: { current: { model: 'custom/without-fallbacks' } },
    }, 'workstream')).toMatchObject({
      source: 'flagship', routing: { model: 'custom/without-fallbacks', fallbackModels: [] },
    });
  });

  it('moves fallbacks without changing their order otherwise', () => {
    expect(moveFallback(['first', 'second', 'third'], 2, -1)).toEqual(['first', 'third', 'second']);
    expect(moveFallback(['first', 'second'], 0, -1)).toEqual(['first', 'second']);
  });

  it('shows the hard-coded usage and saves a validated free-text fallback in array order', async () => {
    const initialRouting = { model: 'x-ai/grok-4.3', fallbackModels: ['google/gemini-3.6-flash'] };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === '/api/models' && !init) return Response.json({ flags: [workstreamFlag(initialRouting)] });
      if (String(input) === '/api/models/validate' && init?.method === 'POST') {
        const { modelIds } = JSON.parse(String(init.body)) as { modelIds: string[] };
        return Response.json({ models: modelIds.map((modelId) => ({ modelId, valid: true })) });
      }
      if (String(input) === '/api/models/workstream' && init?.method === 'PUT') {
        const update = JSON.parse(String(init.body)) as { routing: { model: string; fallbackModels: string[] } };
        return Response.json({ flag: workstreamFlag(update.routing) });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    await act(async () => root.render(<ModelsView />));
    await vi.waitFor(() => expect(container.textContent).toContain('Flagship connected'));
    expect(container.textContent).toContain('Runs the main participant-visible work stream and the structured attachment-summary pass');
    expect(container.textContent).toContain('Targeted rules may still serve a different variation');
    const modelButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.models > button'));
    expect(modelButtons).toHaveLength(11);
    expect(modelButtons.map((button) => button.querySelector('strong')?.textContent)).toEqual([
      '1Work-stream agent',
      '2Addressing classifier',
      '3Inline subagent',
      '4Work-stream description',
      '5Work-stream naming',
      '6Automation architect',
      '7Meeting notes',
      '8Activity classifier',
      '9Suggested-work admission',
      '10Suggested-work ranking',
      '11HyperSight block',
    ]);

    const save = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Save route')!;
    await vi.waitFor(() => expect(container.textContent).toContain('All model IDs are available through OpenRouter.'));
    expect(save.disabled).toBe(true);

    const addFallback = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Add fallback'))!;
    await act(async () => addFallback.click());
    const freeTextInput = container.querySelector<HTMLInputElement>('input[aria-label="Fallback 2 model"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        freeTextInput,
        'new-provider/new-model',
      );
      freeTextInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await vi.waitFor(() => expect(container.textContent).toContain('All model IDs are available through OpenRouter.'));
    expect(save.disabled).toBe(false);
    await act(async () => save.click());

    await vi.waitFor(() => expect(fetch.mock.calls.some(([input, init]) => (
      String(input) === '/api/models/workstream' && init?.method === 'PUT'
    ))).toBe(true));
    const [, init] = fetch.mock.calls.find(([input, requestInit]) => (
      String(input) === '/api/models/workstream' && requestInit?.method === 'PUT'
    ))!;
    expect(JSON.parse(String(init?.body))).toEqual({
      role: 'workstream',
      routing: {
        model: 'x-ai/grok-4.3',
        fallbackModels: ['google/gemini-3.6-flash', 'new-provider/new-model'],
      },
    });
    expect(save.disabled).toBe(true);
  });

  it('marks a typed unavailable model invalid and keeps save disabled', async () => {
    const initialRouting = { model: 'x-ai/grok-4.3', fallbackModels: [] };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === '/api/models' && !init) return Response.json({ flags: [workstreamFlag(initialRouting)] });
      if (String(input) === '/api/models/validate' && init?.method === 'POST') {
        const { modelIds } = JSON.parse(String(init.body)) as { modelIds: string[] };
        return Response.json({
          models: modelIds.map((modelId) => ({ modelId, valid: modelId !== 'missing/model' })),
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    await act(async () => root.render(<ModelsView />));
    await vi.waitFor(() => expect(container.textContent).toContain('All model IDs are available through OpenRouter.'));
    const primary = container.querySelector<HTMLInputElement>('.model-route-card input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(primary, 'missing/model');
      primary.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await vi.waitFor(() => expect(container.textContent).toContain('OpenRouter does not recognize or currently route: missing/model'));
    expect(primary.getAttribute('aria-invalid')).toBe('true');
    const save = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Save route')!;
    expect(save.disabled).toBe(true);
    expect(fetch.mock.calls.some(([input]) => String(input) === '/api/models/workstream')).toBe(false);
  });
});
