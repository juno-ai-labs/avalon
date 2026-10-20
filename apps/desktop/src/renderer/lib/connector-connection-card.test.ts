import { describe, expect, it } from 'vitest';
import {
  connectorConnectionCardDisplayInputFromToolEvent,
  isUnrecognizedConnectorConnectionCard,
} from './connector-connection-card';

describe('connection card display compatibility', () => {
  it('recognizes future connectors from completed input and output under both wire names', () => {
    for (const name of ['show_connector_connection', 'core_show_connector_connection']) {
      for (const facts of [
        { input: { connectorId: 'future-crm', scope: 'personal' } },
        { output: { connectorId: 'future-crm', scope: 'personal' } },
      ]) {
        const toolEvent = { name, status: 'completed', ...facts };
        expect(connectorConnectionCardDisplayInputFromToolEvent(toolEvent))
          .toEqual({ connectorId: 'future-crm', scope: 'personal' });
        expect(isUnrecognizedConnectorConnectionCard({ toolEvent })).toBe(true);
      }
    }
  });

  it('recognizes a newly offered scope on a known connector as an update requirement', () => {
    const toolEvent = { name: 'show_connector_connection', status: 'completed',
      input: { connectorId: 'apollo', scope: 'workspace' } };
    expect(connectorConnectionCardDisplayInputFromToolEvent(toolEvent))
      .toEqual({ connectorId: 'apollo', scope: 'workspace' });
    expect(isUnrecognizedConnectorConnectionCard({ toolEvent })).toBe(true);
  });

  it('leaves known summary recovery to the shared parser', () => {
    expect(connectorConnectionCardDisplayInputFromToolEvent({
      name: 'show_connector_connection', status: 'completed',
      summary: 'Presented the slack personal connection card',
    })).toEqual({ connectorId: 'slack', scope: 'personal' });
    expect(isUnrecognizedConnectorConnectionCard({ toolEvent: {
      name: 'show_connector_connection', status: 'completed',
      input: { connectorId: 'slack', scope: 'personal' },
    } })).toBe(false);
  });

  it('requires structured unknown requests and rejects malformed envelopes', () => {
    for (const toolEvent of [
      { name: 'another_tool', status: 'completed', input: { connectorId: 'future-crm', scope: 'personal' } },
      { name: 'show_connector_connection', status: 'failed', input: { connectorId: 'future-crm', scope: 'personal' } },
      { name: 'show_connector_connection', status: 'completed', input: { connectorId: 'future-crm', scope: 'invalid' } },
      { name: 'show_connector_connection', status: 'completed', summary: 'Presented the future-crm personal connection card' },
    ]) {
      expect(connectorConnectionCardDisplayInputFromToolEvent(toolEvent)).toBeNull();
      expect(isUnrecognizedConnectorConnectionCard({ toolEvent })).toBe(false);
    }
  });
});
