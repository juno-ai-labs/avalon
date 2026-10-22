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
    // ModelsView debounces validation behind a 400ms window.setTimeout; the tests below drive
    // that clock rather than waiting it out in real time.
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

  it('reads the current default variation and falls back to the checked-in route when malformed', () => {
    expect(routingFromFlag(workstreamFlag({ model: 'custom/current', fallbackModels: ['custom/backup'] }), 'workstream'))
      .toMatchObject({ source: 'flagship', routing: { model: 'custom/current', fallbackModels: ['custom/backup'] } });
    expect(routingFromFlag(workstreamFlag({ model: '', fallbackModels: [] }), 'workstream'))
      .toMatchObject({ source: 'checked-in', routing: { model: 'openai/gpt-6.1-sol', fallbackModels: ['google/gemini-3.8-flash'] } });
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
    // Explicit budgets throughout: vi.waitFor's 1s default has no config knob,
    // and these renders sit behind debounced fetches on a possibly loaded
    // machine (docs/testing.md, "Timeouts and waiting").
    await vi.waitFor(() => expect(container.textContent).toContain('Flagship connected'), { timeout: 5_000 });
    expect(container.textContent).toContain('Runs the main participant-visible work stream and the structured attachment-summary pass');
    expect(container.textContent).toContain('Targeted rules may still serve a different variation');
    const modelButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.models > button'));
    expect(modelButtons).toHaveLength(10);
    expect(modelButtons.map((button) => button.querySelector('strong')?.textContent)).toEqual([
      '1Work-stream agent',
      '2Inline subagent',
      '3Work-stream description',
      '4Work-stream naming',
      '5Suggested-work admission',
      '6Suggested-work ranking',
      '7Conversation import',
      '8Suggestion draft',
      '9Memory sweep',
      '10Sidekick wizard',
    ]);

    const save = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Save route')!;
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    await vi.waitFor(() => expect(container.textContent).toContain('All model IDs are available for this role.'), { timeout: 5_000 });
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
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    await vi.waitFor(() => expect(container.textContent).toContain('All model IDs are available for this role.'), { timeout: 5_000 });
    expect(save.disabled).toBe(false);
    const effort = container.querySelector('select')!;
    await act(async () => {
      effort.value = 'medium';
      effort.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => save.click());

    await vi.waitFor(() => expect(fetch.mock.calls.some(([input, init]) => (
      String(input) === '/api/models/workstream' && init?.method === 'PUT'
    ))).toBe(true), { timeout: 5_000 });
    const [, init] = fetch.mock.calls.find(([input, requestInit]) => (
      String(input) === '/api/models/workstream' && requestInit?.method === 'PUT'
    ))!;
    expect(JSON.parse(String(init?.body))).toEqual({
      role: 'workstream',
      routing: {
        model: 'x-ai/grok-4.3',
        reasoningEffort: 'medium',
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
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    await vi.waitFor(() => expect(container.textContent).toContain('All model IDs are available for this role.'), { timeout: 5_000 });
    const primary = container.querySelector<HTMLInputElement>('.model-route-card input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(primary, 'missing/model');
      primary.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    await vi.waitFor(() => expect(container.textContent).toContain('The model catalog does not recognize or currently route: missing/model'), { timeout: 5_000 });
    expect(primary.getAttribute('aria-invalid')).toBe('true');
    const save = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Save route')!;
    expect(save.disabled).toBe(true);
    expect(fetch.mock.calls.some(([input]) => String(input) === '/api/models/workstream')).toBe(false);
  });

  it('shows Sol only for a fully Azure-routed role and blocks it elsewhere without provider validation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === '/api/models' && !init) return Response.json({ flags: [] });
      if (String(input) === '/api/models/validate' && init?.method === 'POST') {
        const { modelIds } = JSON.parse(String(init.body)) as { modelIds: string[] };
        return Response.json({ models: modelIds.map((modelId) => ({ modelId, valid: true })) });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    await act(async () => root.render(<ModelsView />));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    await vi.waitFor(() => expect(container.textContent).toContain('Flagship connected'), { timeout: 5_000 });
    const choices = (): string[] => Array.from(
      container.querySelectorAll<HTMLOptionElement>('#ace-model-choices option'),
    ).map((option) => option.value);
    expect(choices()).not.toContain('openai/gpt-5.6-sol');

    const inlineChild = Array.from(container.querySelectorAll<HTMLButtonElement>('.models > button'))
      .find((button) => button.textContent?.includes('Inline subagent'))!;
    await act(async () => inlineChild.click());
    expect(choices()).toContain('openai/gpt-5.6-sol');

    const workstream = Array.from(container.querySelectorAll<HTMLButtonElement>('.models > button'))
      .find((button) => button.textContent?.includes('Work-stream agent'))!;
    await act(async () => workstream.click());
    const primary = container.querySelector<HTMLInputElement>('.model-route-card input')!;
    const validationCallsBefore = fetch.mock.calls.filter(([input]) => String(input) === '/api/models/validate').length;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(primary, 'openai/gpt-5.6-sol');
      primary.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(400);
    });
    await vi.waitFor(() => expect(container.textContent).toContain(
      'This role cannot use the Azure-only model: openai/gpt-5.6-sol',
    ), { timeout: 5_000 });
    expect(fetch.mock.calls.filter(([input]) => String(input) === '/api/models/validate')).toHaveLength(validationCallsBefore);
  });
});
