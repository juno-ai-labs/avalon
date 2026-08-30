import { describe, expect, it } from 'vitest';
import {
  connectorAggregateStatus,
  connectorPresentation,
  connectorScopeStates,
  connectorStatusLabel,
  connectorTypeFromHref,
} from './connector-presentation';
import type { WorkstreamConnection } from './types';

describe('connectorPresentation', () => {
  it('names Gmail from the google type with the settings catalog mark', () => {
    expect(connectorPresentation('google')).toMatchObject({
      name: 'Google Mail + Calendar',
      mark: 'google',
    });
    expect(connectorPresentation('google_drive').mark).toBe('google-drive');
  });
});

describe('connectorScopeStates', () => {
  const connections: WorkstreamConnection[] = [
    {
      id: '1',
      modelPluginId: 'google:you',
      connectorType: 'google',
      displayName: 'Gmail',
      scope: 'you',
      status: 'healthy',
    },
    {
      id: '2',
      modelPluginId: 'google:ws',
      connectorType: 'google',
      displayName: 'Gmail',
      scope: 'workspace',
      status: 'reconnect_required',
    },
  ];

  it('always returns personal and workspace rows', () => {
    expect(connectorScopeStates('google', connections)).toEqual([
      { scope: 'you', status: 'healthy', connection: connections[0] },
      { scope: 'workspace', status: 'reconnect_required', connection: connections[1] },
    ]);
    expect(connectorScopeStates('slack', [])).toEqual([
      { scope: 'you', status: 'missing' },
      { scope: 'workspace', status: 'missing' },
    ]);
  });

  it('aggregates to healthy when either scope is healthy', () => {
    expect(connectorAggregateStatus(connectorScopeStates('google', connections))).toBe('healthy');
    expect(connectorStatusLabel('healthy')).toBe('Connected');
  });
});

describe('connectorTypeFromHref', () => {
  it('reads embed and tokened spellings', () => {
    expect(connectorTypeFromHref('connector://google')).toBe('google');
    expect(connectorTypeFromHref('connector:google')).toBe('google');
    expect(connectorTypeFromHref('connector://tok:google')).toBe('google');
    expect(connectorTypeFromHref('connector://tok:google%20drive')).toBe('google drive');
    expect(connectorTypeFromHref('https://example.com')).toBeUndefined();
  });
});
