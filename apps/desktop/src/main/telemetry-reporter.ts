import {
  TELEMETRY_EVENTS,
  TelemetryEnvelopeSchema,
  type TelemetryCategory,
  type TelemetryEnvelope,
  type TelemetryEventName,
  type TelemetryIdentityScope,
  type TelemetrySource,
  TELEMETRY_ENVELOPE_SCHEMA,
} from '@rally/contracts';
import type { ApplicationIconId } from '../common/application-icons';
import type {
  DesktopTelemetryConnectorSetupIntent,
  DesktopTelemetryProductIntent,
  DesktopTelemetrySemanticIntent,
  DesktopTelemetryWorkstreamFeedVisibleIntent,
  DesktopTelemetryWorkstreamSendReadyIntent,
  DesktopTelemetryWorkstreamOpenLifecycleIntent,
  DesktopTelemetryWorkstreamSocketStartedIntent,
} from '../common/desktop';
import type { ApplicationOpenEntrypoint, ApplicationOpenPhase } from './application-open-observer';
import type { TelemetryIdentity } from './telemetry-identity';
import { uuidV7 } from './telemetry-identity';
import type { TelemetrySpool, TelemetrySpoolRow } from './telemetry-spool';

type WorkstreamOpenLifecycleProperties = DesktopTelemetryWorkstreamOpenLifecycleIntent extends infer Intent
  ? Intent extends { operationId: string } ? Omit<Intent, 'operationId'> : never
  : never;

export type TelemetryScreen =
  | 'onboarding_welcome'
  | 'onboarding_region'
  | 'onboarding_workspace'
  | 'workspace_home'
  | 'workstream'
  | 'application_settings'
  | 'developer_settings';
export type TelemetryEntrypoint = 'first_run' | 'settings' | 'invitation' | 'workspace_switcher' | 'composer';

interface ReporterRuntime {
  environment: 'development' | 'staging' | 'production';
  release: string;
  buildId: string;
  platform?: 'darwin' | 'win32' | 'linux';
  arch?: 'arm64' | 'x64';
  channel?: 'development' | 'alpha' | 'beta' | 'stable';
  launchId?: string;
  osVersion?: string;
  locale?: string;
  timezone?: string;
  screenWidth?: number;
  screenHeight?: number;
}

export interface TelemetryWindowContext {
  windowId: string;
  screenWidth: number;
  screenHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface ApplicationSettingsTelemetryState {
  launchAtLoginEnabled: boolean;
  launchAtLoginAvailable: boolean;
  lockdownModeEnabled: boolean;
  lockdownModeAvailable: boolean;
  menuBarEnabled: boolean;
  menuBarAvailable: boolean;
  menuBarPresent: boolean;
  applicationIcon: ApplicationIconId;
  applicationIconAutomatic: boolean;
  applicationIconAvailable: boolean;
}

interface AuthenticatedTelemetrySession {
  apiBaseUrl: string;
  accessToken: string;
  workspace: boolean;
  route: 'global' | 'eu';
}

interface AnonymousTelemetrySession {
  capability: string;
  journeyId: string;
  expiresAt: string;
}

export interface TelemetryReporterOptions {
  spool: TelemetrySpool;
  identity: () => TelemetryIdentity;
  route: () => 'global' | 'eu';
  productAnalyticsEnabled: () => boolean;
  crashReportingEligible?: () => boolean;
  authenticatedSession: () => Promise<AuthenticatedTelemetrySession | null>;
  anonymousSession: () => AnonymousTelemetrySession | null;
  refreshAnonymousSession?: () => Promise<AnonymousTelemetrySession | null>;
  fetch: typeof globalThis.fetch;
  now: () => Date;
  runtime: ReporterRuntime;
  globalApiBaseUrl?: string;
  eventId?: (now: Date) => string;
}

export interface TelemetryInspectorEntry {
  name: string;
  schemaVersion: number;
  policyClass: TelemetryCategory;
  propertyNames: string[];
  route: 'global' | 'eu';
  validation: 'accepted' | 'suppressed' | 'rejected' | 'delivered' | 'retrying' | 'terminal';
  queueState: 'none' | 'queued' | 'delivered' | 'retrying' | 'removed';
}

type ResultCode = 'accepted' | 'duplicate' | 'conflict' | 'suppressed' | 'route_mismatch';

/** Typed semantic facade. Renderer IPC maps to these methods; provider names,
 * arbitrary event names, and arbitrary property dictionaries never cross it. */
export class TelemetryReporter {
  private readonly entries: TelemetryInspectorEntry[] = [];
  private flushing: Promise<void> | null = null;

  constructor(private readonly options: TelemetryReporterOptions) {}

  async applicationLifecycle(state: 'launch_started' | 'ready' | 'foreground' | 'background' | 'graceful_exit'): Promise<void> {
    await this.capture('application_lifecycle', 'desktop-main', 'installation', {
      state,
      crashReportingEligible: this.options.crashReportingEligible?.()
        ?? this.options.productAnalyticsEnabled(),
    });
  }

  applicationVersionChanged(
    transition: { state: 'installed' } | {
      state: 'updated';
      previousVersion: string;
      previousBuild: string;
    },
    eventId: string,
  ): Promise<boolean> {
    return this.capture('application_version_changed', 'desktop-main', 'installation', transition, undefined, eventId);
  }

  async desktopSession(state: 'started' | 'ended', continuouslyEligible: boolean): Promise<void> {
    await this.capture('desktop_session', 'desktop-main', 'installation', { state, continuouslyEligible });
  }

  crashUploadState(
    state: 'awaiting_restart' | 'rotated' | 'queued' | 'uploading' | 'accepted' | 'rejected'
      | 'retrying' | 'expired' | 'invalidated' | 'evicted' | 'corrupt' | 'lost',
  ): Promise<void> {
    return this.capture('crash_upload_state', 'desktop-main', 'installation', { state }).then(() => undefined);
  }

  telemetrySpoolState(
    state: 'accepted' | 'rejected' | 'evicted' | 'expired' | 'quarantined' | 'pressure' | 'delivered',
    count: number,
  ): Promise<void> {
    return this.capture('telemetry_spool_state', 'desktop-main', 'installation', {
      state,
      count: bucketCount(count),
    }).then(() => undefined);
  }

  screenViewed(screen: TelemetryScreen, windowContext?: TelemetryWindowContext): Promise<void> {
    return this.captureProduct('screen_viewed', 'desktop-renderer', { screen }, undefined, windowContext);
  }

  applicationSettingsState(properties: ApplicationSettingsTelemetryState): Promise<void> {
    return this.captureProduct('application_settings_state_v2', 'desktop-main', { ...properties });
  }

  applicationSettingChangeCompleted(
    setting: 'launch_at_login' | 'lockdown_mode' | 'menu_bar',
    previousEnabled: boolean,
    requestedEnabled: boolean,
    appliedEnabled: boolean,
  ): Promise<void> {
    const result = appliedEnabled === requestedEnabled ? 'success' : 'not_applied';
    return this.captureProduct('application_setting_change_completed_v2', 'desktop-main', {
      setting, previousEnabled, requestedEnabled, appliedEnabled, result,
    });
  }

  semanticProductIntent(
    intent: DesktopTelemetrySemanticIntent
      | Omit<DesktopTelemetryConnectorSetupIntent, 'operationId'>
      | Omit<DesktopTelemetryWorkstreamFeedVisibleIntent, 'operationId'>
      | Omit<DesktopTelemetryWorkstreamSendReadyIntent, 'operationId'>
      | WorkstreamOpenLifecycleProperties
      | Omit<DesktopTelemetryWorkstreamSocketStartedIntent, 'operationId'>,
    windowContext?: TelemetryWindowContext,
    operationId?: string,
  ): Promise<void> {
    const { kind, ...properties } = intent;
    return this.captureProduct(kind, 'desktop-renderer', properties, operationId, windowContext);
  }

  applicationIconChanged(properties: {
    previousIcon: ApplicationIconId;
    previousAutomatic: boolean;
    selectedIcon: ApplicationIconId;
    automatic: boolean;
  }): Promise<void> {
    return this.captureProduct('application_icon_changed', 'desktop-main', properties);
  }

  applicationOpened(entrypoint: ApplicationOpenEntrypoint, phase: ApplicationOpenPhase): Promise<void> {
    return this.captureProduct('application_opened', 'desktop-main', { entrypoint, phase });
  }

  menuBarOpened(properties: {
    signedIn: boolean;
    suggestionCount: number;
    recentCount: number;
    pinnedCount: number;
  }): Promise<void> {
    return this.captureProduct('menu_bar_opened', 'desktop-main', properties);
  }

  menuBarActionSelected(
    action: 'new_meeting_note' | 'new_workstream' | 'new_automation' | 'suggested_work'
      | 'recent_workstream' | 'pinned_workstream' | 'open_rally' | 'quit_rally',
  ): Promise<void> {
    return this.captureProduct('menu_bar_action_selected', 'desktop-main', { action });
  }

  commandShortcutsRevealed(availableCount: number, windowContext?: TelemetryWindowContext): Promise<void> {
    return this.captureProduct(
      'command_shortcuts_revealed', 'desktop-renderer', { availableCount }, undefined, windowContext,
    );
  }

  commandShortcutUsed(
    shortcutNumber: number,
    destinationType: 'pinned_workstream' | 'recent_workstream' | 'recent_note',
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct(
      'command_shortcut_used', 'desktop-renderer', { shortcutNumber, destinationType }, undefined, windowContext,
    );
  }

  workstreamOpened(
    properties: Omit<Extract<DesktopTelemetryProductIntent, { kind: 'workstream_opened' }>, 'kind'>,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct('workstream_opened', 'desktop-renderer', properties, undefined, windowContext);
  }

  workstreamActionCompleted(
    properties: Omit<Extract<DesktopTelemetryProductIntent, { kind: 'workstream_action_completed' }>, 'kind'>,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct('workstream_action_completed', 'desktop-renderer', properties, undefined, windowContext);
  }

  automationCreated(
    properties: Omit<Extract<DesktopTelemetryProductIntent, { kind: 'automation_created' }>, 'kind'>,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct('automation_created', 'desktop-renderer', properties, undefined, windowContext);
  }

  automationActionCompleted(
    properties: Omit<Extract<DesktopTelemetryProductIntent, { kind: 'automation_action_completed' }>, 'kind'>,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct('automation_action_completed', 'desktop-renderer', properties, undefined, windowContext);
  }

  messageSent(
    properties: Omit<Extract<DesktopTelemetryProductIntent, { kind: 'message_sent' }>, 'kind'>,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct('message_sent', 'desktop-renderer', properties, undefined, windowContext);
  }

  contentCopied(
    properties: Omit<Extract<DesktopTelemetryProductIntent, { kind: 'content_copied' }>, 'kind'>,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct('content_copied', 'desktop-renderer', properties, undefined, windowContext);
  }

  noteOpened(
    properties: Omit<Extract<DesktopTelemetryProductIntent, { kind: 'note_opened' }>, 'kind'>,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct('note_opened', 'desktop-renderer', properties, undefined, windowContext);
  }

  noteCreated(
    properties: Omit<Extract<DesktopTelemetryProductIntent, { kind: 'note_created' }>, 'kind'>,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct('note_created', 'desktop-renderer', properties, undefined, windowContext);
  }

  noteActionCompleted(
    properties: Omit<Extract<DesktopTelemetryProductIntent, { kind: 'note_action_completed' }>, 'kind'>,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct('note_action_completed', 'desktop-renderer', properties, undefined, windowContext);
  }

  transcriptionStateChanged(
    properties: Omit<Extract<DesktopTelemetryProductIntent, { kind: 'transcription_state_changed' }>, 'kind'>,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct('transcription_state_changed', 'desktop-renderer', properties, undefined, windowContext);
  }

  onboardingRegionSelected(
    selectedRegion: 'global' | 'eu',
    entrypoint: TelemetryEntrypoint,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct(
      'onboarding_region_selected', 'desktop-renderer', { selectedRegion, entrypoint }, undefined, windowContext,
    );
  }

  workspaceCreateRequested(
    selectedRegion: 'global' | 'eu',
    entrypoint: TelemetryEntrypoint,
    operationId: string,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct(
      'workspace_create_requested', 'desktop-renderer', { selectedRegion, entrypoint }, operationId, windowContext,
    );
  }

  workspaceActivationRequested(
    selectedRegion: 'global' | 'eu',
    entrypoint: TelemetryEntrypoint,
    operationId: string,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct(
      'workspace_activation_requested', 'desktop-renderer', { selectedRegion, entrypoint }, operationId, windowContext,
    );
  }

  workstreamCreateRequested(
    entrypoint: TelemetryEntrypoint,
    operationId: string,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct('workstream_create_requested', 'desktop-renderer', { entrypoint }, operationId, windowContext);
  }

  runRequested(
    entrypoint: TelemetryEntrypoint,
    operationId: string,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    return this.captureProduct('run_requested', 'desktop-renderer', { entrypoint }, operationId, windowContext);
  }

  processHealth(
    process: 'main' | 'preload' | 'renderer' | 'utility' | 'gpu',
    state: 'gone' | 'unresponsive' | 'responsive' | 'exception' | 'rejection' | 'unclean_exit',
    reasonClass: 'crashed' | 'killed' | 'oom' | 'launch_failure' | 'unknown',
  ): Promise<void> {
    return this.capture('process_health', 'desktop-main', 'installation', { process, state, reasonClass })
      .then(() => undefined);
  }

  updateOutcome(
    phase: 'check' | 'download' | 'apply' | 'rollback',
    result: 'available' | 'current' | 'success' | 'failed' | 'cancelled',
    durationMs: number,
  ): Promise<void> {
    return this.capture('update_outcome', 'desktop-main', 'installation', {
      phase,
      result,
      duration: bucketDuration(durationMs),
    }).then(() => undefined);
  }

  async javascriptException(
    process: 'main' | 'preload' | 'renderer',
    errorCode: 'type_error' | 'range_error' | 'unhandled_rejection' | 'react_boundary' | 'network_error' | 'unknown',
    fingerprint: string,
    breadcrumbStatus: 'available' | 'stale' | 'unavailable',
    generatedFrames: string[],
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    const authenticated = await this.options.authenticatedSession().catch(() => null);
    if (!authenticated) return;
    await this.capture(
      'javascript_exception',
      'desktop-main',
      authenticated.workspace ? 'workspace-user' : 'platform-user',
      { process, errorCode, breadcrumbStatus, fingerprint, generatedFrames },
      { authenticated, anonymous: null, windowContext },
    );
  }

  inspector(): TelemetryInspectorEntry[] {
    return this.entries.map((entry) => ({ ...entry, propertyNames: [...entry.propertyNames] }));
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushUnlocked().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async captureProduct(
    name: TelemetryEventName,
    source: TelemetrySource,
    properties: Record<string, unknown>,
    operationId?: string,
    windowContext?: TelemetryWindowContext,
  ): Promise<void> {
    const authenticated = await this.options.authenticatedSession().catch(() => null);
    const route = this.options.route();
    // A signed-in user without a workspace still belongs to the provisional
    // onboarding route. Never carry that platform identity across regions;
    // use the route-bound anonymous epoch until an authoritative workspace is
    // available.
    const provisionalRoute = authenticated !== null
      && !authenticated.workspace
      && authenticated.route !== route;
    const effectiveAuthenticated = provisionalRoute ? null : authenticated;
    const anonymous = effectiveAuthenticated ? null : this.options.anonymousSession();
    const scope: TelemetryIdentityScope = effectiveAuthenticated
      ? effectiveAuthenticated.workspace ? 'workspace-user' : 'platform-user'
      : 'anonymous-epoch';
    await this.capture(name, source, scope, properties, {
      authenticated: effectiveAuthenticated,
      anonymous,
      operationId,
      windowContext,
    });
  }

  private async capture(
    name: TelemetryEventName,
    source: TelemetrySource,
    identityScope: TelemetryIdentityScope,
    properties: Record<string, unknown>,
    resolved?: {
      authenticated: AuthenticatedTelemetrySession | null;
      anonymous: AnonymousTelemetrySession | null;
      operationId?: string;
      windowContext?: TelemetryWindowContext;
    },
    eventId?: string,
  ): Promise<boolean> {
    const registry = TELEMETRY_EVENTS[name];
    const route = this.options.route();
    const inspected: TelemetryInspectorEntry = {
      name,
      schemaVersion: registry.schemaVersion,
      policyClass: registry.category,
      propertyNames: Object.keys(properties).sort(),
      route,
      validation: 'rejected',
      queueState: 'none',
    };
    if (registry.category !== 'essential' && !this.options.productAnalyticsEnabled()) {
      inspected.validation = 'suppressed';
      this.record(inspected);
      return false;
    }
    try {
      const authenticated = resolved?.authenticated ?? await this.options.authenticatedSession().catch(() => null);
      const anonymous = resolved?.anonymous ?? (authenticated ? null : this.options.anonymousSession());
      if (identityScope === 'anonymous-epoch' && !anonymous) {
        this.record(inspected);
        return false;
      }
      if ((identityScope === 'platform-user' || identityScope === 'workspace-user') && !authenticated) {
        this.record(inspected);
        return false;
      }
      const now = this.options.now();
      const identity = this.options.identity();
      const event = TelemetryEnvelopeSchema.parse({
        schema: TELEMETRY_ENVELOPE_SCHEMA,
        schemaVersion: 1,
        contextSchemaVersion: 2,
        eventId: eventId ?? (this.options.eventId ?? uuidV7)(now),
        name,
        source,
        category: registry.category,
        identityScope,
        originalTimestamp: now.toISOString(),
        sentAt: now.toISOString(),
        context: {
          ...this.options.runtime,
          region: route,
          deviceId: identity.installationId,
          ...resolved?.windowContext,
          ...(anonymous && identityScope === 'anonymous-epoch'
            ? { onboardingJourneyId: anonymous.journeyId }
            : {}),
          ...(resolved?.operationId ? { operationId: resolved.operationId } : {}),
        },
        properties,
      }) as TelemetryEnvelope;
      await this.options.spool.enqueue({
        route,
        accountEpochId: identityScope === 'anonymous-epoch' ? identity.anonymousEpochId : identity.accountEpochId,
        installationId: identity.installationId,
        event,
        acceptedAt: now,
      });
      inspected.validation = 'accepted';
      inspected.queueState = 'queued';
      this.record(inspected);
      return true;
    } catch {
      this.record(inspected);
      return false;
    }
  }

  private async flushUnlocked(): Promise<void> {
    const now = this.options.now();
    const rows = await this.options.spool.ready(now).catch(() => []);
    for (const row of rows) await this.deliver(row, now);
  }

  private async deliver(row: TelemetrySpoolRow, now: Date): Promise<void> {
    try {
      row = await this.options.spool.prepareSend(row.event.eventId, now);
      const anonymous = row.event.identityScope === 'anonymous-epoch';
      const authenticated = anonymous ? null : await this.options.authenticatedSession();
      const capabilityDelivery = anonymous || (row.event.identityScope === 'installation' && !authenticated);
      let anonymousSession = capabilityDelivery ? this.options.anonymousSession() : null;
      if (capabilityDelivery && (!anonymousSession || Date.parse(anonymousSession.expiresAt) <= now.getTime())) {
        anonymousSession = await this.options.refreshAnonymousSession?.().catch(() => null) ?? null;
        if (!anonymousSession || Date.parse(anonymousSession.expiresAt) <= now.getTime()) {
          await this.retry(row, now);
          return;
        }
      }
      if (!capabilityDelivery && (!authenticated || authenticated.route !== row.route)) {
        await this.retry(row, now);
        return;
      }
      const endpoint = capabilityDelivery
        ? `${this.options.globalApiBaseUrl ?? 'https://api.rallywith.ai'}/telemetry/anonymous`
        : `${authenticated!.apiBaseUrl}/telemetry/events`;
      const response = await this.options.fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(!capabilityDelivery ? { Authorization: `Bearer ${authenticated!.accessToken}` } : {}),
        },
        body: JSON.stringify(capabilityDelivery
          ? {
              capability: anonymousSession!.capability,
              installationId: row.installationId,
              events: [row.event],
            }
          : { installationId: row.installationId, events: [row.event] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        if (capabilityDelivery && response.status >= 400 && response.status < 500) {
          const refreshed = await this.options.refreshAnonymousSession?.().catch(() => null) ?? null;
          if (refreshed && refreshed.capability !== anonymousSession?.capability) {
            await this.retry(row, now, 0);
            return;
          }
        }
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          await this.retry(row, now, retryAfter(response, now));
        } else {
          await this.options.spool.acknowledge(row.event.eventId);
          this.recordDelivery(row, 'terminal', 'removed');
        }
        return;
      }
      const body = await response.json() as { results?: Array<{ result?: ResultCode; eventId?: string }> };
      const result = body.results?.find((candidate) => candidate.eventId === row.event.eventId)?.result;
      if (!result) {
        await this.retry(row, now);
        return;
      }
      await this.options.spool.acknowledge(row.event.eventId);
      this.recordDelivery(row, result === 'accepted' || result === 'duplicate' ? 'delivered' : 'terminal', 'delivered');
    } catch {
      await this.retry(row, now);
    }
  }

  private async retry(row: TelemetrySpoolRow, now: Date, explicitDelay?: number): Promise<void> {
    const delay = explicitDelay ?? Math.min(60 * 60 * 1_000, 60_000 * 2 ** Math.min(row.attempts, 6));
    await this.options.spool.retry(row.event.eventId, new Date(now.getTime() + delay)).catch(() => undefined);
    this.recordDelivery(row, 'retrying', 'retrying');
  }

  private recordDelivery(
    row: TelemetrySpoolRow,
    validation: TelemetryInspectorEntry['validation'],
    queueState: TelemetryInspectorEntry['queueState'],
  ): void {
    this.record({
      name: row.event.name,
      schemaVersion: row.event.schemaVersion,
      policyClass: row.event.category,
      propertyNames: Object.keys(row.event.properties).sort(),
      route: row.route,
      validation,
      queueState,
    });
  }

  private record(entry: TelemetryInspectorEntry): void {
    this.entries.push(entry);
    if (this.entries.length > 100) this.entries.splice(0, this.entries.length - 100);
  }
}

function bucketDuration(durationMs: number): 'lt_100ms' | '100ms_1s' | '1s_5s' | '5s_30s' | 'gte_30s' {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'gte_30s';
  if (durationMs < 100) return 'lt_100ms';
  if (durationMs < 1_000) return '100ms_1s';
  if (durationMs < 5_000) return '1s_5s';
  if (durationMs < 30_000) return '5s_30s';
  return 'gte_30s';
}

function bucketCount(count: number): 'one' | 'two_to_ten' | 'eleven_to_one_hundred' | 'over_one_hundred' {
  if (!Number.isSafeInteger(count) || count <= 1) return 'one';
  if (count <= 10) return 'two_to_ten';
  if (count <= 100) return 'eleven_to_one_hundred';
  return 'over_one_hundred';
}

function retryAfter(response: Response, now: Date): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60 * 60 * 1_000, Math.round(seconds * 1_000));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(60 * 60 * 1_000, Math.max(0, date - now.getTime())) : undefined;
}
