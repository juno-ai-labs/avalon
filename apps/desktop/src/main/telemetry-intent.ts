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
        && (region === 'global' || region === 'eu')
        && (entrypoint === 'first_run' || entrypoint === 'settings' || entrypoint === 'invitation')) {
        return { kind: 'onboarding_region_selected', selectedRegion: region, entrypoint };
      }
      break;
    case 'workspace_create_requested':
      if (exact('kind', 'selectedRegion', 'entrypoint', 'operationId')
        && (region === 'global' || region === 'eu')
        && (entrypoint === 'first_run' || entrypoint === 'settings')
        && typeof operationId === 'string' && UUID_V7_PATTERN.test(operationId)) {
        return { kind: 'workspace_create_requested', selectedRegion: region, entrypoint, operationId };
      }
      break;
    case 'workspace_activation_requested':
      if (exact('kind', 'selectedRegion', 'entrypoint', 'operationId')
        && (region === 'global' || region === 'eu')
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
  }
  const semanticKind = candidate['kind'];
  if (typeof semanticKind === 'string' && (
    semanticKind === 'workstream_opened'
    || semanticKind === 'workstream_action_completed'
    || semanticKind === 'automation_created'
    || semanticKind === 'automation_action_completed'
    || semanticKind === 'message_sent'
    || semanticKind === 'content_copied'
    || semanticKind === 'note_opened'
    || semanticKind === 'note_created'
    || semanticKind === 'note_action_completed'
    || semanticKind === 'transcription_state_changed'
    || semanticKind === 'surface_viewed'
    || semanticKind === 'automation_builder_started'
    || semanticKind === 'automation_opened'
    || semanticKind === 'hypersight_opened'
    || semanticKind === 'workstream_resource_action_completed'
    || semanticKind === 'recording_start_completed'
    || semanticKind === 'recording_terminal'
    || semanticKind === 'note_opened_v2'
    || semanticKind === 'realtime_socket_state'
  )) {
    const properties = { ...candidate };
    delete properties['kind'];
    const parsed = TELEMETRY_EVENTS[semanticKind].properties.safeParse(properties);
    if (parsed.success) return { kind: semanticKind, ...parsed.data } as DesktopTelemetryProductIntent;
  }
  throw new Error('Invalid telemetry intent');
}
