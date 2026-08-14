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

  it('observes real Electron application focus transitions', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');

    expect(source).toContain("app.on('browser-window-focus'");
    expect(source).toContain("app.on('browser-window-blur'");
    expect(source).toContain('BrowserWindow.getFocusedWindow()');
    expect(source).toContain('applicationLifecycle(state)');
    expect(source).toContain('if (startsHidden) applicationLifecycleTelemetry.observeFocused(false)');
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

  it('coalesces menu opening hooks and reports successful menu-bar suggestion use', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');
    const contentSource = readFileSync(`${process.cwd()}/src/main/menu-bar-content.ts`, 'utf8');

    expect(source).toContain("tray.on('click', () =>");
    expect(source).toContain("menu.on('menu-will-show', () => openObserver.opened())");
    expect(source).toContain("menu.on('menu-will-close', () => openObserver.closed())");
    expect(source).toContain("telemetryReporter?.menuBarOpened");
    expect(source).toContain('telemetryReporter?.menuBarActionSelected(action)');
    expect(contentSource).toContain("surface: 'menu_bar'");
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
});
