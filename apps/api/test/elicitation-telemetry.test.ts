import { asUserId, asWorkspaceId } from '@rally/contracts';
import { describe, expect, it } from 'vitest';
import { apiTelemetryEnvelope } from '../src/telemetry/api-emitter';
import { elicitationPresentedTelemetry } from '../src/telemetry/elicitation';
import { createTestEnv } from './helpers/cloudflare-test';

describe('elicitation_presented telemetry', () => {
  it('is admitted by the envelope though the question id is a deterministic UUIDv5 and the run an imported UUIDv8', () => {
    // A question's id is derived from its tool call's receipt key (v5); an imported run's id is v8.
    const event = elicitationPresentedTelemetry({
      workspaceId: asWorkspaceId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2'),
      userId: asUserId('018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1'),
      elicitationId: '6fa459ea-ee8a-5ca4-894e-db77e160355e',
      runId: '018f3f4e-7b5a-8cc1-9a6f-2aa0324b79d4',
      workstreamId: '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d3',
      responseType: 'radio',
      optionCount: 2,
    });
    const envelope = apiTelemetryEnvelope(createTestEnv({ AVALON_REGION: 'global' }), event.name, event.properties,
      event.operationId, 'workspace-user', 'global', event.eventId);
    expect(envelope).toMatchObject({
      name: 'elicitation_presented',
      eventId: '6fa459ea-ee8a-7ca4-894e-db77e160355f',
      context: { operationId: '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79db' },
      properties: { elicitationId: '6fa459ea-ee8a-5ca4-894e-db77e160355e', responseType: 'radio', optionCount: 'two_to_five', surface: 'workstream' },
    });
    // The same question replayed is the same event.
    expect(elicitationPresentedTelemetry({ ...event.properties, workspaceId: event.workspaceId, optionCount: 2,
      elicitationId: '6fa459ea-ee8a-5ca4-894e-db77e160355e', runId: '018f3f4e-7b5a-8cc1-9a6f-2aa0324b79d4', workstreamId: '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d3' }).eventId)
      .toBe(envelope.eventId);
  });
});
