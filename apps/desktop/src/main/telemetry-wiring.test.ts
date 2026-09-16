import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Electron telemetry wiring', () => {
  it('reports preload startup failure through bounded process and exception signals', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');
    const handler = source.match(
      /window\.webContents\.on\('preload-error',[\s\S]*?\n {2}\}\);/u,
    )?.[0];

    expect(handler).toBeDefined();
    expect(handler).toContain("processHealth('preload', 'exception', 'launch_failure')");
    expect(handler).toContain("process: 'preload'");
    expect(handler).not.toContain('preloadPath');
  });

  it('offers native recovery when the primary renderer exits unexpectedly', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');
    const mainWindowCrashHandler = source.match(
      /mainWindow\.webContents\.on\('render-process-gone',[\s\S]*?\n {2}\}\);/u,
    )?.[0];
    const beforeQuitHandler = source.match(
      /app\.on\('before-quit',[\s\S]*?\n\}\);/u,
    )?.[0];

    expect(source).toContain('new RendererCrashRecovery({');
    expect(mainWindowCrashHandler).toBeDefined();
    expect(mainWindowCrashHandler).toContain('realtimeSocketBroker.closeOwner(mainWindowWebContentsId)');
    expect(mainWindowCrashHandler).toContain(
      'if (!applicationIsQuitting) void rendererCrashRecovery.offer(details.reason)',
    );
    expect(beforeQuitHandler).toBeDefined();
    expect(beforeQuitHandler).toContain('applicationIsQuitting = true');
    expect(beforeQuitHandler!.indexOf('applicationIsQuitting = true'))
      .toBeLessThan(beforeQuitHandler!.indexOf('telemetryQuitBarrier.hold'));
  });

  it('applies breadcrumb teardown to Product analytics changes rather than Debug changes', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');
    const debugController = source.match(
      /const debugSettingsController = new DebugSettingsController\([\s\S]*?\n\}\);/u,
    )?.[0];
    const productAnalyticsController = source.match(
      /const productAnalyticsSettingsController = new ProductAnalyticsSettingsController\([\s\S]*?\n\}\);/u,
    )?.[0];

    expect(debugController).toBeDefined();
    expect(debugController).not.toContain('telemetryBreadcrumbs');
    expect(productAnalyticsController).toContain(
      'if (!state.effectiveEnabled) telemetryBreadcrumbs = null',
    );
    expect(productAnalyticsController).toContain('new TelemetryBreadcrumbRing');
  });

  it('reconciles Product analytics in the background without suppressing cold-launch events', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');
    const request = source.match(
      /async function requestProductAnalyticsPreference\(\)[\s\S]*?\n\}\n\nasync function syncProductAnalyticsPreference/u,
    )?.[0];

    expect(source).toContain('const PRODUCT_ANALYTICS_PREFERENCE_REQUEST_TIMEOUT_MS = 15_000;');
    expect(source).not.toContain('PRODUCT_ANALYTICS_LAUNCH_BARRIER_MS');
    expect(request).toBeDefined();
    expect(request).toContain(
      'signal: AbortSignal.timeout(PRODUCT_ANALYTICS_PREFERENCE_REQUEST_TIMEOUT_MS)',
    );
    expect(request).not.toContain('AbortSignal.timeout(1_000)');

    const launch = source.match(
      /const launchAuth = await loadStoredAuth\(\);[\s\S]*?await initializeTelemetry\(launchAuth\);/u,
    )?.[0];
    expect(launch).toBeDefined();
    expect(launch).toContain('productAnalyticsSettingsController.initialize(launchAuth !== null);');
    expect(launch).not.toContain('productAnalyticsSettingsController.refresh()');
    expect(source).toContain('void productAnalyticsSettingsController.refresh()');
    expect(source).toContain(
      'productAnalyticsEnabled: () => productAnalyticsSettingsController.admissionEnabled()',
    );
    expect(source).toContain(
      'productAnalyticsDeliveryEnabled: () => productAnalyticsSettingsController.state().effectiveEnabled',
    );
  });

  it('observes real Electron application focus transitions and relays them to renderers', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');
    const observer = source.match(
      /function observeApplicationForeground\(foregrounded: boolean\)[\s\S]*?\n\}/u,
    )?.[0];

    expect(source).toContain("app.on('browser-window-focus'");
    expect(source).toContain("app.on('browser-window-blur'");
    expect(source).toContain('BrowserWindow.getFocusedWindow()');
    expect(source).toContain('applicationLifecycle(state)');
    expect(observer).toContain('applicationLifecycleTelemetry.observeFocused(foregrounded)');
    expect(observer).toContain('!window.webContents.isCrashed()');
    expect(observer).toContain("window.webContents.send('application:foreground-changed', foregrounded)");
    expect(source).toContain('if (startsHidden) observeApplicationForeground(false)');
    expect(source).toContain('observeApplicationForeground(true)');
    expect(source).toContain("ipcMain.handle('application:foreground-get'");
  });

  it('derives PostHog-compatible window metadata in main instead of trusting renderer values', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');
    const context = source.match(
      /function telemetryWindowContext\(contents: WebContents\)[\s\S]*?\n\}\n\nasync function reportJavascriptErrorCandidate/u,
    )?.[0];

    expect(context).toContain('BrowserWindow.fromWebContents(contents)');
    expect(context).toContain('window.getContentSize()');
    expect(context).toContain('electronScreen.getDisplayMatching(window.getBounds())');
    expect(context).toContain('telemetryWindowIds.get(contents)');
    expect(source).toContain('screenViewed(screen, telemetryWindowContext(event.sender))');
    expect(source).toContain('reportTelemetryProductIntent(rawIntent, telemetryWindowContext(event.sender))');
    expect(source).toContain('reportJavascriptErrorCandidate(rawCandidate, telemetryWindowContext(event.sender))');
  });

  it('coalesces menu opening hooks into one reported open', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');

    expect(source).toContain("tray.on('click', () =>");
    expect(source).toContain("menu.on('menu-will-show', () => openObserver.opened())");
    expect(source).toContain("menu.on('menu-will-close', () => openObserver.closed())");
    expect(source).toContain("telemetryReporter?.menuBarOpened");
    expect(source).toContain('telemetryReporter?.menuBarActionSelected(action)');
  });

  it('reports actual settings snapshots and applied main-owned changes', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');
    const lockdownHandler = source.match(
      /ipcMain\.handle\('application-settings:set-lockdown-mode',[\s\S]*?\n {2}\}\);/u,
    )?.[0];
    const launchHandler = source.match(
      /ipcMain\.handle\('application-settings:set-launch-at-login',[\s\S]*?\n {2}\}\);/u,
    )?.[0];
    const iconChange = source.match(
      /async function enqueueApplicationIconChange[\s\S]*?\n\}/u,
    )?.[0];

    expect(source).toContain('telemetryReporter?.applicationSettingsState(applicationSettingsTelemetryState())');
    expect(lockdownHandler).toBeDefined();
    expect(lockdownHandler!.indexOf('await lockdownModeController.set(rawEnabled)'))
      .toBeLessThan(lockdownHandler!.indexOf("applicationSettingChangeCompleted(\n      'lockdown_mode'"));
    expect(launchHandler).toBeDefined();
    expect(launchHandler!.indexOf('await launchAtLoginController.set(rawEnabled)'))
      .toBeLessThan(launchHandler!.indexOf("applicationSettingChangeCompleted(\n      'launch_at_login'"));
    expect(iconChange).toBeDefined();
    expect(iconChange!.indexOf('await applicationIconController.change(rawIconId)'))
      .toBeLessThan(iconChange!.indexOf('telemetryReporter?.applicationIconChanged({'));
    expect(iconChange).toContain('selectedIcon: state.activeIcon');
  });

  it('classifies cold starts and coalesces explicit opens with Electron activation', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');

    expect(source).toContain('initialApplicationOpenEntrypoint({');
    expect(source).toContain('applicationOpenObserver.launched(launchEntrypoint)');
    expect(source).toContain("applicationOpenObserver.opened('menu_bar')");
    expect(source).toContain("applicationOpenObserver.opened('deep_link')");
    expect(source).toContain("applicationOpenObserver.opened('user_launch')");
    expect(source).toContain('applicationOpenObserver.activated()');
    expect(source).toContain("'push_notification'");
  });

  it('preserves native navigation sources and holds quit behind one bounded flush', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');

    // The menu's own rows: every one that opens something re-enters through the
    // existing deep links rather than through a second navigation path, and
    // carries `menu_bar` so the open is not misread as a Dock activation.
    expect(source).toContain("emitDeepLink(`${customProtocol}://workstreams/${workstreamId}`, 'menu_bar')");
    expect(source).toContain('const telemetryQuitBarrier = new TelemetryQuitBarrier');
    expect(source).toContain('if (telemetryQuitBarrier.hold(() => app.quit())) event.preventDefault()');
    expect(source).not.toContain("void telemetryReporter?.applicationLifecycle('graceful_exit')");
  });
});
