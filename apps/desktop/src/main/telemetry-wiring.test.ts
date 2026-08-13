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
});
