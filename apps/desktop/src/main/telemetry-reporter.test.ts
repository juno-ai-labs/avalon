import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelemetryReporter } from './telemetry-reporter';
import { TelemetrySpool } from './telemetry-spool';

const roots: string[] = [];
const identity = {
  version: 1 as const,
  installationId: '018f0000-0000-7000-8000-000000000001',
  anonymousEpochId: '018f0000-0000-7000-8000-000000000002',
  accountEpochId: '018f0000-0000-7000-8000-000000000003',
};

async function harness(input: {
  enabled?: boolean;
  deliveryEnabled?: () => boolean;
  route?: 'global' | 'eu';
  auth?: { apiBaseUrl: string; accessToken: string; workspace: boolean; route: 'global' | 'eu' } | null;
  anonymous?: { capability: string; journeyId: string; expiresAt: string } | null;
  refreshAnonymous?: () => Promise<{ capability: string; journeyId: string; expiresAt: string } | null>;
  now?: () => Date;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rally-reporter-'));
  roots.push(directory);
  const spool = new TelemetrySpool({ rootDirectory: directory, maxRows: 50, maxBytes: 500_000 });
  const fetch = vi.fn<typeof globalThis.fetch>();
  let eventSequence = 0x10;
  const reporter = new TelemetryReporter({
    spool,
    identity: () => identity,
    route: () => input.route ?? 'global',
    productAnalyticsEnabled: () => input.enabled ?? true,
    productAnalyticsDeliveryEnabled: input.deliveryEnabled,
    authenticatedSession: async () => input.auth ?? null,
    anonymousSession: () => input.anonymous ?? null,
    refreshAnonymousSession: input.refreshAnonymous,
    fetch,
    now: input.now ?? (() => new Date('2026-08-12T20:00:00.000Z')),
    runtime: {
      environment: 'development', release: '1.96.0', buildId: 'test',
      platform: 'darwin', arch: 'arm64', channel: 'development', osVersion: '15.6.1',
      locale: 'en-US', timezone: 'America/Los_Angeles', screenWidth: 2560, screenHeight: 1440,
    },
    eventId: () => `018f0000-0000-7000-8000-${(eventSequence++).toString(16).padStart(12, '0')}`,
  });
  return { reporter, spool, fetch };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('TelemetryReporter', () => {
  it('keeps essential lifecycle signals while suppressing product signals after opt-out', async () => {
    const { reporter, spool } = await harness({ enabled: false });
    await reporter.applicationLifecycle('ready');
    await reporter.screenViewed('workspace_home');
    await reporter.applicationSettingsState({
      launchAtLoginEnabled: true,
      launchAtLoginAvailable: true,
      lockdownModeEnabled: false,
      lockdownModeAvailable: true,
      menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      applicationIcon: 'dark',
      applicationIconAutomatic: true,
      applicationIconAvailable: true,
    });
    await reporter.applicationOpened('user_launch', 'cold_start');
    const rows = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(rows.map((row) => row.event.name)).toEqual(['application_lifecycle']);
    expect(reporter.inspector()).toMatchObject([
      { name: 'application_lifecycle', validation: 'accepted' },
      { name: 'screen_viewed', validation: 'suppressed' },
      { name: 'application_settings_state_v2', validation: 'suppressed' },
      { name: 'application_opened', validation: 'suppressed' },
    ]);
  });

  it('records bounded menu, Command-shortcut, and suggested-work product signals', async () => {
    const { reporter, spool } = await harness({
      auth: { apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', workspace: true, route: 'global' },
    });
    await reporter.menuBarOpened({ signedIn: true, suggestionCount: 4, recentCount: 5, pinnedCount: 2 });
    await reporter.menuBarActionSelected('new_workstream');
    await reporter.commandShortcutsRevealed(9);
    await reporter.commandShortcutUsed(2, 'pinned_workstream');

    const rows = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(rows.map((row) => ({
      name: row.event.name,
      source: row.event.source,
      properties: row.event.properties,
    }))).toEqual([
      {
        name: 'menu_bar_opened',
        source: 'desktop-main',
        properties: { signedIn: true, suggestionCount: 4, recentCount: 5, pinnedCount: 2 },
      },
      {
        name: 'menu_bar_action_selected',
        source: 'desktop-main',
        properties: { action: 'new_workstream' },
      },
      {
        name: 'command_shortcuts_revealed',
        source: 'desktop-renderer',
        properties: { availableCount: 9 },
      },
      {
        name: 'command_shortcut_used',
        source: 'desktop-renderer',
        properties: { shortcutNumber: 2, destinationType: 'pinned_workstream' },
      },
    ]);
  });

  it('records applied application-settings state and successful changes', async () => {
    const { reporter, spool } = await harness({
      auth: { apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', workspace: true, route: 'global' },
    });
    await reporter.applicationSettingsState({
      launchAtLoginEnabled: true,
      launchAtLoginAvailable: true,
      lockdownModeEnabled: false,
      lockdownModeAvailable: true,
      menuBarEnabled: true,
      menuBarAvailable: true,
      menuBarPresent: true,
      applicationIcon: 'dark',
      applicationIconAutomatic: true,
      applicationIconAvailable: true,
    });
    await reporter.applicationSettingChangeCompleted('launch_at_login', false, true, false);
    await reporter.applicationSettingChangeCompleted('lockdown_mode', false, true, true);
    await reporter.applicationIconChanged({
      previousIcon: 'dark',
      previousAutomatic: true,
      selectedIcon: 'ruby',
      automatic: false,
    });
    await reporter.applicationOpened('system_start', 'cold_start');
    await reporter.applicationOpened('dock', 'activation');

    const rows = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(rows.map((row) => ({ name: row.event.name, properties: row.event.properties }))).toEqual([
      {
        name: 'application_settings_state_v2',
        properties: {
          launchAtLoginEnabled: true,
          launchAtLoginAvailable: true,
          lockdownModeEnabled: false,
          lockdownModeAvailable: true,
          menuBarEnabled: true,
          menuBarAvailable: true,
          menuBarPresent: true,
          applicationIcon: 'dark',
          applicationIconAutomatic: true,
          applicationIconAvailable: true,
        },
      },
      {
        name: 'application_setting_change_completed_v2',
        properties: {
          setting: 'launch_at_login', previousEnabled: false, requestedEnabled: true, appliedEnabled: false,
          result: 'not_applied',
        },
      },
      {
        name: 'application_setting_change_completed_v2',
        properties: {
          setting: 'lockdown_mode', previousEnabled: false, requestedEnabled: true, appliedEnabled: true,
          result: 'success',
        },
      },
      {
        name: 'application_icon_changed',
        properties: {
          previousIcon: 'dark', previousAutomatic: true, selectedIcon: 'ruby', automatic: false,
        },
      },
      {
        name: 'application_opened',
        properties: { entrypoint: 'system_start', phase: 'cold_start' },
      },
      {
        name: 'application_opened',
        properties: { entrypoint: 'dock', phase: 'activation' },
      },
    ]);
  });

  it('records resource interactions with opaque ids and content-free metadata', async () => {
    const { reporter, spool } = await harness({
      auth: { apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', workspace: true, route: 'global' },
    });
    const workstreamId = '00000000-0000-4000-8000-000000000101';
    const messageId = '00000000-0000-4000-8000-000000000102';
    const noteId = '00000000-0000-4000-8000-000000000103';
    const automationId = '00000000-0000-4000-8000-000000000104';
    await reporter.workstreamOpened({
      workstreamId, visibility: 'private', navigation: 'switched', origin: 'ad_hoc', pinned: true,
    });
    await reporter.messageSent({
      workstreamId, messageId, visibility: 'private', workstreamOrigin: 'ad_hoc', messageKind: 'message',
      attachmentCount: 1, mentionCount: 2, participantAddedCount: 0,
    });
    await reporter.contentCopied({
      contentType: 'message_response', resourceType: 'message', resourceId: messageId, workstreamId,
    });
    await reporter.automationActionCompleted({
      automationId, action: 'archive_draft', visibility: 'private', status: 'draft',
    });
    await reporter.noteOpened({ noteId, visibility: 'public', recordingState: 'complete', navigation: 'reopened' });
    await reporter.transcriptionStateChanged({
      noteId, state: 'paused', visibility: 'public', audioSource: 'microphone_and_system',
    });

    const rows = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(rows.map((row) => ({ name: row.event.name, properties: row.event.properties }))).toEqual([
      { name: 'workstream_opened', properties: {
        workstreamId, visibility: 'private', navigation: 'switched', origin: 'ad_hoc', pinned: true,
      } },
      { name: 'message_sent', properties: {
        workstreamId, messageId, visibility: 'private', workstreamOrigin: 'ad_hoc', messageKind: 'message',
        attachmentCount: 1, mentionCount: 2, participantAddedCount: 0,
      } },
      { name: 'content_copied', properties: {
        contentType: 'message_response', resourceType: 'message', resourceId: messageId, workstreamId,
      } },
      { name: 'automation_action_completed', properties: {
        automationId, action: 'archive_draft', visibility: 'private', status: 'draft',
      } },
      { name: 'note_opened', properties: {
        noteId, visibility: 'public', recordingState: 'complete', navigation: 'reopened',
      } },
      { name: 'transcription_state_changed', properties: {
        noteId, state: 'paused', visibility: 'public', audioSource: 'microphone_and_system',
      } },
    ]);
  });

  it('buckets update duration without retaining versions or provider errors', async () => {
    const { reporter, spool } = await harness({ enabled: false });
    await reporter.updateOutcome('download', 'failed', 6_250);
    const [row] = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(row?.event).toMatchObject({
      name: 'update_outcome',
      category: 'essential',
      identityScope: 'installation',
      properties: { phase: 'download', result: 'failed', duration: '5s_30s' },
    });
  });

  it('reports bounded crash, spool, and crash-free session states as content-free essentials', async () => {
    const { reporter, spool } = await harness({ enabled: false });
    await reporter.desktopSession('started', false);
    await reporter.crashUploadState('retrying');
    await reporter.telemetrySpoolState('evicted', 12);
    const rows = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(rows.map((row) => ({ name: row.event.name, properties: row.event.properties }))).toEqual([
      { name: 'desktop_session', properties: { state: 'started', continuouslyEligible: false } },
      { name: 'crash_upload_state', properties: { state: 'retrying' } },
      { name: 'telemetry_spool_state', properties: { state: 'evicted', count: 'eleven_to_one_hundred' } },
    ]);
  });

  it('builds registered envelopes and never lets an invalid renderer value reach disk', async () => {
    const anonymous = {
      capability: 'c'.repeat(64),
      journeyId: '018f0000-0000-7000-8000-000000000004',
      expiresAt: '2026-08-12T21:00:00.000Z',
    };
    const { reporter, spool } = await harness({ anonymous });
    await reporter.screenViewed('onboarding_welcome', {
      windowId: '018f0000-0000-7000-8000-000000000099',
      viewportWidth: 1480,
      viewportHeight: 940,
      screenWidth: 3024,
      screenHeight: 1964,
    });
    await reporter.screenViewed('private/workspace/42' as never);
    const [row] = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(row?.event).toMatchObject({
      contextSchemaVersion: 2,
      name: 'screen_viewed', source: 'desktop-renderer', category: 'product',
      identityScope: 'anonymous-epoch',
      context: {
        onboardingJourneyId: anonymous.journeyId,
        region: 'global',
        deviceId: identity.installationId,
        osVersion: '15.6.1',
        locale: 'en-US',
        timezone: 'America/Los_Angeles',
        windowId: '018f0000-0000-7000-8000-000000000099',
        viewportWidth: 1480,
        viewportHeight: 940,
        screenWidth: 3024,
        screenHeight: 1964,
      },
      properties: { screen: 'onboarding_welcome' },
    });
    expect(reporter.inspector().at(-1)).toMatchObject({ validation: 'rejected' });
  });

  it('records native application install and update transitions as installation lifecycle events', async () => {
    const { reporter, spool } = await harness({ enabled: false });
    await reporter.applicationVersionChanged(
      { state: 'installed' },
      '018f0000-0000-7000-8000-000000000020',
    );
    await reporter.applicationVersionChanged({
      state: 'updated',
      previousVersion: '1.95.0',
      previousBuild: '19500',
    }, '018f0000-0000-7000-8000-000000000021');

    const rows = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(rows.map((row) => ({ name: row.event.name, properties: row.event.properties }))).toEqual([
      { name: 'application_version_changed', properties: { state: 'installed' } },
      {
        name: 'application_version_changed',
        properties: { state: 'updated', previousVersion: '1.95.0', previousBuild: '19500' },
      },
    ]);
  });

  it('acknowledges an application transition only after its stable event reaches the spool', async () => {
    const { reporter, spool } = await harness({ enabled: false });
    const enqueue = vi.spyOn(spool, 'enqueue').mockRejectedValueOnce(new Error('disk unavailable'));
    const eventId = '018f0000-0000-7000-8000-000000000022';

    await expect(reporter.applicationVersionChanged({ state: 'installed' }, eventId)).resolves.toBe(false);
    await expect(reporter.applicationVersionChanged({ state: 'installed' }, eventId)).resolves.toBe(true);

    expect(enqueue).toHaveBeenCalledTimes(2);
    const [row] = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(row?.event).toMatchObject({ eventId, properties: { state: 'installed' } });
  });

  it('accepts only authenticated sanitized JavaScript exception reports', async () => {
    const unauthenticated = await harness({ auth: null });
    await unauthenticated.reporter.javascriptException(
      'renderer', 'type_error', 'a'.repeat(32), 'available', ['renderer.js:12:4'],
    );
    expect(await unauthenticated.spool.ready(new Date('2026-08-12T20:00:01.000Z'))).toEqual([]);

    const authenticated = await harness({
      auth: {
        apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', workspace: true, route: 'global',
      },
    });
    await authenticated.reporter.javascriptException(
      'renderer', 'type_error', 'b'.repeat(32), 'available', ['renderer.js:12:4'],
    );
    const [row] = await authenticated.spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(row?.event).toMatchObject({
      name: 'javascript_exception',
      source: 'desktop-main',
      identityScope: 'workspace-user',
      properties: {
        process: 'renderer', errorCode: 'type_error', breadcrumbStatus: 'available',
        fingerprint: 'b'.repeat(32), generatedFrames: ['renderer.js:12:4'],
      },
    });
  });

  it('correlates one rich connector intent without emitting its legacy version', async () => {
    const { reporter, spool } = await harness({
      auth: {
        apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', workspace: true, route: 'global',
      },
    });
    const operationId = '018f0000-0000-7000-8000-000000000099';

    await reporter.semanticProductIntent({
      kind: 'connector_setup_requested_v2', connector: 'linear', scope: 'personal',
      method: 'oauth', capabilityCount: 'one',
    }, undefined, operationId);

    const rows = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toMatchObject({
      name: 'connector_setup_requested_v2', context: { operationId },
      properties: {
        connector: 'linear', scope: 'personal', method: 'oauth', capabilityCount: 'one',
      },
    });
  });

  it('carries a realtime socket transition as a workspace-scoped renderer signal', async () => {
    const { reporter, spool } = await harness({
      auth: {
        apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', workspace: true, route: 'global',
      },
    });

    await reporter.semanticProductIntent({
      kind: 'realtime_socket_state',
      socket: 'substream_feed',
      state: 'retrying',
      cause: 'heartbeat_timeout',
      attempts: 'one',
    });

    const rows = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(rows).toHaveLength(1);
    // The renderer is the only party that knows a socket had to be retried, so
    // it is the authoritative source; the row still carries no work stream, no
    // URL, and no close code.
    expect(rows[0]?.event).toMatchObject({
      name: 'realtime_socket_state',
      source: 'desktop-renderer',
      identityScope: 'workspace-user',
      properties: { socket: 'substream_feed', state: 'retrying', cause: 'heartbeat_timeout', attempts: 'one' },
    });
  });

  it('spools correlated renderer phase timings only while diagnostics are enabled', async () => {
    const auth = {
      apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', workspace: true, route: 'global' as const,
    };
    const operationId = '018f0000-0000-7000-8000-000000000020';
    const properties = {
      kind: 'renderer_perf_flow' as const,
      flow: 'workstream_open' as const,
      workstreamId: '00000000-0000-4000-8000-000000000105',
      outcome: 'snapshot' as const,
      durationMs: 852.4,
      blockedMs: 14.2,
      longTaskCount: 'one' as const,
      socketTicketMs: 220.1,
      dialMs: 3.2,
      handshakeMs: 487.6,
      firstFrameMs: 141.5,
      attempts: 'zero' as const,
      sinceEffectMs: 12.7,
      ticketId: '018f22f2-4c22-7abc-8def-012345678901',
      messageCount: 'six_to_twenty' as const,
    };
    const enabled = await harness({ auth });
    await enabled.reporter.semanticProductIntent(properties, undefined, operationId);
    const [row] = await enabled.spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(row?.event).toMatchObject({
      name: 'renderer_perf_flow',
      source: 'desktop-renderer',
      category: 'diagnostic',
      identityScope: 'workspace-user',
      context: { operationId },
      properties: {
        flow: 'workstream_open',
        outcome: 'snapshot',
        socketTicketMs: 220.1,
        handshakeMs: 487.6,
      },
    });

    const disabled = await harness({ auth, enabled: false });
    await disabled.reporter.semanticProductIntent(properties, undefined, operationId);
    expect(await disabled.spool.ready(new Date('2026-08-12T20:00:01.000Z'))).toEqual([]);
    expect(disabled.reporter.inspector()).toMatchObject([
      { name: 'renderer_perf_flow', validation: 'suppressed' },
    ]);
  });

  it('spools correlated work-stream paint and socket-start measurements without content', async () => {
    const { reporter, spool } = await harness({
      auth: {
        apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', workspace: true, route: 'global',
      },
    });
    const workstreamId = '00000000-0000-4000-8000-000000000105';
    const feedOperationId = '018f0000-0000-7000-8000-000000000021';
    const socketOperationId = '018f0000-0000-7000-8000-000000000022';
    const socketLeaseId = '018f0000-0000-7000-8000-000000000023';
    await reporter.semanticProductIntent({
      kind: 'workstream_open_started',
      workstreamId,
      sidebarSection: 'recent',
      socketPoolState: 'control_warmup',
      socketLeaseId,
    }, undefined, feedOperationId);
    await reporter.semanticProductIntent({
      kind: 'workstream_feed_visible',
      workstreamId,
      socketLeaseId,
      durationMs: 724,
      dataReadyDurationMs: 690,
      sidebarSection: 'recent',
      cacheState: 'cold',
      socketPoolState: 'control_warmup',
      feedSource: 'boot_payload',
      messageCount: 'six_to_twenty',
    }, undefined, feedOperationId);
    await reporter.semanticProductIntent({
      kind: 'workstream_send_ready',
      workstreamId,
      durationMs: 731,
      workspaceSocketState: 'reconnecting',
    }, undefined, feedOperationId);
    await reporter.semanticProductIntent({
      kind: 'workstream_socket_started',
      workstreamId,
      socketLeaseId,
      openAttemptId: feedOperationId,
      socket: 'workstream_control',
      reason: 'hover_warmup',
      attempts: 'zero',
    }, undefined, socketOperationId);
    await reporter.semanticProductIntent({
      kind: 'workstream_open_outcome',
      workstreamId,
      outcome: 'visible',
      durationMs: 724,
      socketLeaseId,
    }, undefined, feedOperationId);

    const rows = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(rows.map(({ event }) => ({
      name: event.name,
      operationId: event.context.operationId,
      properties: event.properties,
    }))).toEqual([
      {
        name: 'workstream_open_started',
        operationId: feedOperationId,
        properties: {
          workstreamId,
          sidebarSection: 'recent',
          socketPoolState: 'control_warmup',
          socketLeaseId,
        },
      },
      {
        name: 'workstream_feed_visible',
        operationId: feedOperationId,
        properties: {
          workstreamId,
          socketLeaseId,
          durationMs: 724,
          dataReadyDurationMs: 690,
          sidebarSection: 'recent',
          cacheState: 'cold',
          socketPoolState: 'control_warmup',
          feedSource: 'boot_payload',
          messageCount: 'six_to_twenty',
        },
      },
      {
        name: 'workstream_send_ready',
        operationId: feedOperationId,
        properties: {
          workstreamId,
          durationMs: 731,
          workspaceSocketState: 'reconnecting',
        },
      },
      {
        name: 'workstream_socket_started',
        operationId: socketOperationId,
        properties: {
          workstreamId,
          socketLeaseId,
          openAttemptId: feedOperationId,
          socket: 'workstream_control',
          reason: 'hover_warmup',
          attempts: 'zero',
        },
      },
      {
        name: 'workstream_open_outcome',
        operationId: feedOperationId,
        properties: {
          workstreamId,
          outcome: 'visible',
          durationMs: 724,
          socketLeaseId,
        },
      },
    ]);
  });

  it('suppresses realtime socket transitions for someone who opted out', async () => {
    const { reporter, spool } = await harness({
      enabled: false,
      auth: {
        apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', workspace: true, route: 'global',
      },
    });

    await reporter.semanticProductIntent({
      kind: 'realtime_socket_state', socket: 'workspace', state: 'connected', cause: 'opened', attempts: 'zero',
    });

    expect(await spool.ready(new Date('2026-08-12T20:00:01.000Z'))).toEqual([]);
  });

  it('uploads authenticated rows to only their regional API and acknowledges durable results', async () => {
    const { reporter, spool, fetch } = await harness({
      auth: { apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', workspace: true, route: 'global' },
    });
    fetch.mockResolvedValue(new Response(JSON.stringify({
      results: [{ result: 'accepted', eventId: '018f0000-0000-7000-8000-000000000010' }],
    }), { status: 202, headers: { 'content-type': 'application/json' } }));
    await reporter.screenViewed('workspace_home');
    await reporter.flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.rallywith.ai/telemetry/events');
    expect(new Headers(request?.headers).get('authorization')).toBe('Bearer secret');
    const body = JSON.parse(String(request?.body));
    expect(body.installationId).toBe(identity.installationId);
    expect(body.events[0]).toMatchObject({ name: 'screen_viewed', identityScope: 'workspace-user' });
    expect(await spool.ready(new Date('2026-08-12T20:01:00.000Z'))).toEqual([]);
  });

  it('spools product events before canonical verification and delivers them only after it succeeds', async () => {
    let verified = false;
    const { reporter, spool, fetch } = await harness({
      enabled: true,
      deliveryEnabled: () => verified,
      auth: { apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', workspace: true, route: 'global' },
    });
    fetch.mockResolvedValue(new Response(JSON.stringify({
      results: [{ result: 'accepted', eventId: '018f0000-0000-7000-8000-000000000010' }],
    }), { status: 202, headers: { 'content-type': 'application/json' } }));

    await reporter.screenViewed('workspace_home');
    await reporter.flush();

    expect(fetch).not.toHaveBeenCalled();
    expect(await spool.ready(new Date('2026-08-12T20:01:00.000Z'))).toHaveLength(1);

    verified = true;
    await reporter.flush();

    expect(fetch).toHaveBeenCalledOnce();
    expect(await spool.ready(new Date('2026-08-12T20:01:00.000Z'))).toEqual([]);
  });

  it('uses the Global capability endpoint for a route-fixed anonymous EU event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rally-reporter-eu-'));
    roots.push(directory);
    const spool = new TelemetrySpool({ rootDirectory: directory });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      results: [{ result: 'accepted', eventId: '018f0000-0000-7000-8000-000000000010' }],
    }), { status: 202 }));
    const reporter = new TelemetryReporter({
      spool, identity: () => identity, route: () => 'eu', productAnalyticsEnabled: () => true,
      authenticatedSession: async () => null,
      anonymousSession: () => ({
        capability: 'c'.repeat(64), journeyId: '018f0000-0000-7000-8000-000000000004',
        expiresAt: '2026-08-12T21:00:00.000Z',
      }),
      fetch, now: () => new Date('2026-08-12T20:00:00.000Z'),
      runtime: { environment: 'development', release: '1.96.0', buildId: 'test' },
      globalApiBaseUrl: 'https://api.rallywith.ai',
      eventId: () => '018f0000-0000-7000-8000-000000000010',
    });
    await reporter.screenViewed('onboarding_region');
    await reporter.flush();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.rallywith.ai/telemetry/anonymous');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      capability: 'c'.repeat(64),
      installationId: identity.installationId,
    });
  });

  it('routes pre-workspace EU onboarding intent immediately through its anonymous epoch', async () => {
    const anonymous = {
      capability: 'c'.repeat(64),
      journeyId: '018f0000-0000-7000-8000-000000000004',
      expiresAt: '2026-08-12T21:00:00.000Z',
    };
    const { reporter, spool, fetch } = await harness({
      route: 'eu',
      anonymous,
      auth: {
        apiBaseUrl: 'https://api.rallywith.ai',
        accessToken: 'global-login-token',
        workspace: false,
        route: 'global',
      },
    });
    fetch.mockResolvedValue(new Response(JSON.stringify({
      results: [{ result: 'accepted', eventId: '018f0000-0000-7000-8000-000000000010' }],
    }), { status: 202 }));

    await reporter.workspaceCreateRequested(
      'eu',
      'first_run',
      '018f0000-0000-7000-8000-000000000099',
    );
    const [queued] = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(queued).toMatchObject({
      route: 'eu',
      event: { identityScope: 'anonymous-epoch', context: { onboardingJourneyId: anonymous.journeyId } },
    });
    await reporter.flush();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.rallywith.ai/telemetry/anonymous');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
  });

  it('uses the route-fixed capability for logged-out content-free installation health', async () => {
    const anonymous = {
      capability: 'c'.repeat(64),
      journeyId: '018f0000-0000-7000-8000-000000000004',
      expiresAt: '2026-08-12T21:00:00.000Z',
    };
    const { reporter, fetch } = await harness({ anonymous, auth: null });
    fetch.mockResolvedValue(new Response(JSON.stringify({
      results: [{ result: 'accepted', eventId: '018f0000-0000-7000-8000-000000000010' }],
    }), { status: 202 }));
    await reporter.applicationLifecycle('launch_started');
    await reporter.flush();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.rallywith.ai/telemetry/anonymous');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      capability: anonymous.capability,
      installationId: identity.installationId,
      events: [{ name: 'application_lifecycle', identityScope: 'installation' }],
    });
  });

  it('refreshes an expired fixed-route capability before delivery', async () => {
    const expired = {
      capability: 'c'.repeat(64), journeyId: '018f0000-0000-7000-8000-000000000004',
      expiresAt: '2026-08-12T19:59:00.000Z',
    };
    const refreshed = { ...expired, capability: 'd'.repeat(64), expiresAt: '2026-08-12T21:00:00.000Z' };
    const refreshAnonymous = vi.fn(async () => refreshed);
    const { reporter, fetch } = await harness({ anonymous: expired, refreshAnonymous });
    fetch.mockResolvedValue(new Response(JSON.stringify({
      results: [{ result: 'accepted', eventId: '018f0000-0000-7000-8000-000000000010' }],
    }), { status: 202 }));

    await reporter.screenViewed('onboarding_welcome');
    await reporter.flush();
    expect(refreshAnonymous).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      capability: refreshed.capability,
    });
  });

  it('retains a row with bounded backoff when delivery fails and does not throw into the product path', async () => {
    const { reporter, spool, fetch } = await harness({
      auth: { apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', workspace: true, route: 'global' },
    });
    fetch.mockRejectedValue(new Error('offline'));
    await reporter.screenViewed('workspace_home');
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(await spool.ready(new Date('2026-08-12T20:00:59.000Z'))).toEqual([]);
    expect(await spool.ready(new Date('2026-08-12T20:02:00.000Z'))).toHaveLength(1);
  });

  it('records the first actual send time and preserves it across delivery retries', async () => {
    let now = new Date('2026-08-01T20:00:00.000Z');
    const { reporter, spool, fetch } = await harness({
      auth: { apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', workspace: true, route: 'global' },
      now: () => now,
    });
    fetch
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ result: 'accepted', eventId: '018f0000-0000-7000-8000-000000000010' }],
      }), { status: 202 }));

    await reporter.screenViewed('workspace_home');
    now = new Date('2026-08-05T20:00:00.000Z');
    await reporter.flush();
    const [retry] = await spool.ready(new Date('2026-08-05T20:02:00.000Z'));
    expect(retry?.event).toMatchObject({
      originalTimestamp: '2026-08-01T20:00:00.000Z',
      sentAt: '2026-08-05T20:00:00.000Z',
    });

    now = new Date('2026-08-05T20:02:00.000Z');
    await reporter.flush();
    const secondRequest = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(secondRequest.events[0]).toMatchObject({
      originalTimestamp: '2026-08-01T20:00:00.000Z',
      sentAt: '2026-08-05T20:00:00.000Z',
    });
  });
});
