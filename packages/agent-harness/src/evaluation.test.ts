import { describe, expect, it } from 'vitest';
import { asUserId } from '@rally/contracts';
import { parseRallyCheckpoint, runRallyEvaluation, type RallyCheckpoint } from './evaluation';
import type { RunHarnessInput } from './index';

const bindings = { configuration: { model: 'eval/model' }, environment: { writes: 0 } };
function stream(delta: unknown, finish_reason: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}

describe('Rally evaluation host', () => {
  it('uses the production runtime from a scenario and forks after a settled tool without repeating its effect', async () => {
    let writes = 0;
    const checkpoints: RallyCheckpoint[] = [];
    const requests: { messages: { role: string; content?: unknown }[] }[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as typeof requests[number];
      requests.push(request);
      return request.messages.some((message) => message.role === 'tool')
        ? stream({ content: 'Saved the document.' }, 'stop')
        : stream({ tool_calls: [{ index: 0, id: 'save-1', type: 'function', function: { name: 'save', arguments: '{}' } }] }, 'tool_calls');
    };
    const host = {
      restore: async (_saved: typeof bindings, executionId: string): Promise<RunHarnessInput> => ({
        config: { apiKey: 'test', primaryModel: 'eval/model', fetch: fetcher, toolTimeoutMs: 30_000, maxWebResults: 4 },
        workspaceId: 'eval-workspace', workstreamId: 'eval-workstream', loopId: `eval-loop:${executionId}`, harnessRunId: executionId,
        executionPrincipal: { type: 'user', userId: asUserId('00000000-0000-4000-8000-000000000001') },
        systemPrompt: 'Use the save tool.', messages: [],
        corePlugins: [{ canonicalId: 'avalon:core', modelId: 'rally_core', shortWireName: 'core', description: 'Core', preload: true,
          tools: [{ definition: { name: 'save', description: 'Save a document', inputSchema: { type: 'object', additionalProperties: false },
            capability: 'save.run', mode: 'write', idempotency: 'provider_key' },
            execute: async () => { writes++; return { output: { saved: true }, summary: 'Saved' }; } }] }],
        onAssistantTurnReserved: ({ modelTurnIndex }) => ({ transcriptSequence: modelTurnIndex }),
        onStepSettled: () => ({ transitions: [], stop: false }), onEvent: () => {},
      }),
      captureBindings: async () => ({ ...bindings, environment: { writes } }),
      commit: async (checkpoint: RallyCheckpoint) => { checkpoints.push(parseRallyCheckpoint(JSON.parse(JSON.stringify(checkpoint)))); },
    };
    const first = await runRallyEvaluation({ executionId: 'initial', maxIterations: 4,
      start: { kind: 'scenario', content: { messages: [{ role: 'user', text: 'Save this.' }] }, bindings }, host });
    expect(first).toMatchObject({ status: 'completed', content: 'Saved the document.' });
    expect(writes).toBe(1);
    const afterTool = checkpoints.find((checkpoint) => checkpoint.loop.position.kind === 'ready' && checkpoint.loop.state.messages.some((message) => message.role === 'tool'));
    expect(afterTool).toBeDefined();
    const fork = await runRallyEvaluation({ executionId: 'fork', maxIterations: 4,
      start: { kind: 'checkpoint', checkpoint: afterTool! }, host });
    expect(fork).toMatchObject({ status: 'completed', content: 'Saved the document.' });
    expect(writes).toBe(1);
    expect(requests.at(-1)?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool' })]));
    expect(checkpoints.at(-1)?.loop.executionId).toBe('fork');
  });
});
