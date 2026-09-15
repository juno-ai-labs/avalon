import { isConfiguredRegion } from "@rally/contracts/regions";
import { TELEMETRY_EVENTS } from '@rally/contracts/telemetry';

import type { DesktopTelemetryProductIntent } from '../common/desktop';

/**
 * The one gate between a renderer's telemetry call and the reporter.
 *
 * It lives here rather than in `index.ts` so it can be exercised directly: the
 * entry point cannot be imported by a test — it starts Electron on import — and
 * a test that asserts on its source text proves the strings are present, not
 * that a malformed intent is refused or a well-formed one survives. Every event
 * a renderer can produce passes through this function, so that difference is
 * the whole IPC surface's coverage.
 */
export const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseTelemetryProductIntent(value: unknown): DesktopTelemetryProductIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid telemetry intent');
  const candidate = value as Record<string, unknown>;
  const exact = (...keys: string[]): boolean => {
    const actual = Object.keys(candidate).sort();
    return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
  };
  const region = candidate['selectedRegion'];
  const entrypoint = candidate['entrypoint'];
  const operationId = candidate['operationId'];
  switch (candidate['kind']) {
    case 'onboarding_region_selected':
      if (exact('kind', 'selectedRegion', 'entrypoint')
        && isConfiguredRegion(region)
        && (entrypoint === 'first_run' || entrypoint === 'settings' || entrypoint === 'invitation')) {
        return { kind: 'onboarding_region_selected', selectedRegion: region, entrypoint };
      }
      break;
    case 'workspace_create_requested':
      if (exact('kind', 'selectedRegion', 'entrypoint', 'operationId')
        && isConfiguredRegion(region)
        && (entrypoint === 'first_run' || entrypoint === 'settings')
        && typeof operationId === 'string' && UUID_V7_PATTERN.test(operationId)) {
        return { kind: 'workspace_create_requested', selectedRegion: region, entrypoint, operationId };
      }
      break;
    case 'workspace_activation_requested':
      if (exact('kind', 'selectedRegion', 'entrypoint', 'operationId')
        && isConfiguredRegion(region)
        && (entrypoint === 'invitation' || entrypoint === 'workspace_switcher')
        && typeof operationId === 'string' && UUID_V7_PATTERN.test(operationId)) {
        return { kind: 'workspace_activation_requested', selectedRegion: region, entrypoint, operationId };
      }
      break;
    case 'workstream_create_requested':
    case 'run_requested':
      if (exact('kind', 'entrypoint', 'operationId') && entrypoint === 'composer'
        && typeof operationId === 'string' && UUID_V7_PATTERN.test(operationId)) {
        return { kind: candidate['kind'], entrypoint, operationId };
      }
      break;
    case 'connector_setup_requested_v2': {
      const hasOperationId = operationId !== undefined;
      if (!(hasOperationId
        ? exact('kind', 'connector', 'scope', 'method', 'capabilityCount', 'operationId')
        : exact('kind', 'connector', 'scope', 'method', 'capabilityCount'))
        || (hasOperationId && (typeof operationId !== 'string' || !UUID_V7_PATTERN.test(operationId)))) break;
      const properties = { ...candidate };
      delete properties['kind'];
      delete properties['operationId'];
      const parsed = TELEMETRY_EVENTS.connector_setup_requested_v2.properties.safeParse(properties);
      if (parsed.success) return {
        kind: 'connector_setup_requested_v2',
        ...parsed.data,
        ...(typeof operationId === 'string' ? { operationId } : {}),
      };
      break;
    }
    case 'workstream_feed_visible': {
      const hasSocketLeaseId = candidate['socketLeaseId'] !== undefined;
      if (typeof operationId !== 'string' || !UUID_V7_PATTERN.test(operationId)
        || !(hasSocketLeaseId ? exact(
          'kind', 'operationId', 'workstreamId', 'socketLeaseId', 'durationMs', 'dataReadyDurationMs',
          'sidebarSection', 'cacheState', 'socketPoolState', 'feedSource', 'messageCount',
        ) : exact(
          'kind', 'operationId', 'workstreamId', 'durationMs', 'dataReadyDurationMs',
          'sidebarSection', 'cacheState', 'socketPoolState', 'feedSource', 'messageCount',
        ))) break;
      const properties = { ...candidate };
      delete properties['kind'];
      delete properties['operationId'];
      const parsed = TELEMETRY_EVENTS.workstream_feed_visible.properties.safeParse(properties);
      if (parsed.success) return {
        kind: 'workstream_feed_visible',
        operationId,
        ...parsed.data,
      };
      break;
    }
    case 'workstream_send_ready': {
      if (typeof operationId !== 'string' || !UUID_V7_PATTERN.test(operationId)
        || !exact('kind', 'operationId', 'workstreamId', 'durationMs', 'workspaceSocketState')) break;
      const properties = { ...candidate };
      delete properties['kind'];
      delete properties['operationId'];
      const parsed = TELEMETRY_EVENTS.workstream_send_ready.properties.safeParse(properties);
      if (parsed.success) return {
        kind: 'workstream_send_ready',
        operationId,
        ...parsed.data,
      };
      break;
    }
    case 'workstream_socket_started': {
      const hasOpenAttemptId = candidate['openAttemptId'] !== undefined;
      if (typeof operationId !== 'string' || !UUID_V7_PATTERN.test(operationId)
        || !(hasOpenAttemptId
          ? exact(
            'kind', 'operationId', 'workstreamId', 'socketLeaseId', 'openAttemptId',
            'socket', 'reason', 'attempts',
          )
          : exact('kind', 'operationId', 'workstreamId', 'socketLeaseId', 'socket', 'reason', 'attempts'))) break;
      const properties = { ...candidate };
      delete properties['kind'];
      delete properties['operationId'];
      const parsed = TELEMETRY_EVENTS.workstream_socket_started.properties.safeParse(properties);
      if (parsed.success) return {
        kind: 'workstream_socket_started',
        operationId,
        ...parsed.data,
      };
      break;
    }
    case 'renderer_perf_flow': {
      if (typeof operationId !== 'string' || !UUID_V7_PATTERN.test(operationId)) break;
      const properties = { ...candidate };
      delete properties['kind'];
      delete properties['operationId'];
      const parsed = TELEMETRY_EVENTS.renderer_perf_flow.properties.safeParse(properties);
      if (parsed.success) return {
        kind: 'renderer_perf_flow',
        operationId,
        ...parsed.data,
      };
      break;
    }
    case 'command_shortcuts_revealed':
      if (exact('kind', 'availableCount')
        && typeof candidate['availableCount'] === 'number'
        && Number.isInteger(candidate['availableCount'])
        && candidate['availableCount'] >= 0 && candidate['availableCount'] <= 9) {
        return { kind: 'command_shortcuts_revealed', availableCount: candidate['availableCount'] };
      }
      break;
    case 'command_shortcut_used':
      if (exact('kind', 'shortcutNumber', 'destinationType')
        && typeof candidate['shortcutNumber'] === 'number'
        && Number.isInteger(candidate['shortcutNumber'])
        && candidate['shortcutNumber'] >= 1 && candidate['shortcutNumber'] <= 9
        && (candidate['destinationType'] === 'pinned_workstream'
          || candidate['destinationType'] === 'recent_workstream'
          || candidate['destinationType'] === 'recent_note')) {
        return {
          kind: 'command_shortcut_used',
          shortcutNumber: candidate['shortcutNumber'],
          destinationType: candidate['destinationType'],
        };
      }
      break;
    case 'workstream_open_started':
    case 'workstream_open_outcome': {
      if (typeof operationId !== 'string' || !UUID_V7_PATTERN.test(operationId)) break;
      const optionalKeys = candidate['kind'] === 'workstream_open_started'
        ? ['socketLeaseId']
        : ['socketLeaseId', 'supersedingWorkstreamId'];
      const requiredKeys = candidate['kind'] === 'workstream_open_started'
        ? ['kind', 'operationId', 'workstreamId', 'sidebarSection', 'socketPoolState']
        : ['kind', 'operationId', 'workstreamId', 'outcome', 'durationMs'];
      const actualKeys = Object.keys(candidate);
      if (!requiredKeys.every((key) => actualKeys.includes(key))
        || actualKeys.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))) break;
      const properties = { ...candidate };
      delete properties['kind'];
      delete properties['operationId'];
      const kind = candidate['kind'];
      const parsed = TELEMETRY_EVENTS[kind].properties.safeParse(properties);
      if (parsed.success) return { kind, operationId, ...parsed.data } as DesktopTelemetryProductIntent;
      break;
    }
  }
  const semanticKind = candidate['kind'];
  if (typeof semanticKind === 'string' && (
    semanticKind === 'workstream_opened'
    || semanticKind === 'workstream_action_completed'
    || semanticKind === 'automation_created'
    || semanticKind === 'automation_action_completed'
    || semanticKind === 'message_sent'
    || semanticKind === 'content_copied'
    || semanticKind === 'surface_viewed'
    || semanticKind === 'automation_builder_started'
    || semanticKind === 'automation_opened'
    || semanticKind === 'workstream_resource_action_completed'
    || semanticKind === 'realtime_socket_state'
  )) {
    const properties = { ...candidate };
    delete properties['kind'];
    const parsed = TELEMETRY_EVENTS[semanticKind].properties.safeParse(properties);
    if (parsed.success) return { kind: semanticKind, ...parsed.data } as DesktopTelemetryProductIntent;
  }
  throw new Error('Invalid telemetry intent');
}
