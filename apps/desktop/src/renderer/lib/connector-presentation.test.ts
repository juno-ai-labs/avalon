import { describe, expect, it } from 'vitest';
import {
  connectorAggregateStatus,
  connectorPresentation,
  connectorScopeStates,
  connectorStatusLabel,
} from './connector-presentation';
import type { WorkstreamConnection } from './types';

describe('connectorPresentation', () => {
  it('distinguishes the two Google capability bundles without inventing a connector type', () => {
    expect(connectorPresentation('google', '@Gmail')).toMatchObject({
      name: 'Gmail',
      mark: 'google',
      capabilityPrefixes: ['gmail.', 'calendar.'],
    });
    expect(connectorPresentation('google', '@Google Drive')).toMatchObject({
      name: 'Google Drive',
      mark: 'google-drive',
      capabilityPrefixes: ['drive.', 'docs.', 'sheets.'],
    });
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
      capabilities: ['gmail.read'],
    },
    {
      id: '2',
      modelPluginId: 'google:ws',
      connectorType: 'google',
      displayName: 'Gmail',
      scope: 'workspace',
      status: 'reconnect_required',
      capabilities: ['gmail.read'],
    },
  ];
  const personalConnection = connections[0]!;

  it('always returns personal and workspace rows', () => {
    expect(connectorScopeStates('google', connections)).toEqual([
      {
        scope: 'you',
        status: 'healthy',
        connections: [personalConnection],
        capabilities: ['gmail.read'],
      },
      {
        scope: 'workspace',
        status: 'reconnect_required',
        connections: [connections[1]],
        capabilities: ['gmail.read'],
      },
    ]);
    expect(connectorScopeStates('slack', [])).toEqual([
      { scope: 'you', status: 'missing', connections: [], capabilities: [] },
      { scope: 'workspace', status: 'missing', connections: [], capabilities: [] },
    ]);
  });

  it('aggregates to healthy when either scope is healthy', () => {
    expect(connectorAggregateStatus(connectorScopeStates('google', connections))).toBe('healthy');
    expect(connectorStatusLabel('healthy')).toBe('Connected');
  });

  it('aggregates every same-scope credential independently of response order', () => {
    const reconnecting: WorkstreamConnection = {
      ...personalConnection,
      id: 'reconnecting',
      status: 'reconnect_required',
      capabilities: ['gmail.read'],
    };
    const healthy: WorkstreamConnection = {
      ...personalConnection,
      id: 'healthy',
      modelPluginId: 'google:you:2',
      status: 'healthy',
      capabilities: ['calendar.write'],
    };
    const first = connectorScopeStates('google', [reconnecting, healthy], ['gmail.', 'calendar.'])[0];
    const reversed = connectorScopeStates('google', [healthy, reconnecting], ['gmail.', 'calendar.'])[0];

    expect(first.status).toBe('healthy');
    expect(reversed.status).toBe('healthy');
    expect(first.capabilities).toEqual(['calendar.write', 'gmail.read']);
    expect(reversed.capabilities).toEqual(first.capabilities);
  });

  it('does not let the opposite Google authorization bundle claim readiness', () => {
    const mail = connectorPresentation('google', '@Gmail');
    const drive = connectorPresentation('google', '@Google Drive');
    const mailOnly: WorkstreamConnection = {
      ...personalConnection,
      capabilities: ['gmail.read', 'calendar.read'],
    };
    const driveOnly: WorkstreamConnection = {
      ...personalConnection,
      id: 'drive',
      modelPluginId: 'google:drive',
      capabilities: ['drive.read', 'docs.read'],
    };

    expect(connectorScopeStates('google', [mailOnly], drive.capabilityPrefixes)[0].status).toBe('missing');
    expect(connectorScopeStates('google', [driveOnly], mail.capabilityPrefixes)[0].status).toBe('missing');
    expect(connectorScopeStates('google', [driveOnly], drive.capabilityPrefixes)[0].status).toBe('healthy');
  });
});
