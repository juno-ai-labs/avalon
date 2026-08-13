import { describe, expect, it, vi } from 'vitest';
import { ApplicationLifecycleTelemetry } from './application-lifecycle-telemetry';

describe('ApplicationLifecycleTelemetry', () => {
  it('uses the first focus observation as a baseline without duplicating launch', () => {
    const report = vi.fn();
    const lifecycle = new ApplicationLifecycleTelemetry(report);

    lifecycle.observeFocused(true);
    lifecycle.observeFocused(true);

    expect(report).not.toHaveBeenCalled();
  });

  it('reports real background and foreground transitions once', () => {
    const report = vi.fn();
    const lifecycle = new ApplicationLifecycleTelemetry(report);

    lifecycle.observeFocused(true);
    lifecycle.observeFocused(false);
    lifecycle.observeFocused(false);
    lifecycle.observeFocused(true);
    lifecycle.observeFocused(true);

    expect(report.mock.calls).toEqual([
      ['background'],
      ['foreground'],
    ]);
  });

  it('does not claim a foreground transition when the first observed window belongs to a hidden launch', () => {
    const report = vi.fn();
    const lifecycle = new ApplicationLifecycleTelemetry(report);

    lifecycle.observeFocused(false);
    lifecycle.observeFocused(true);

    expect(report.mock.calls).toEqual([['foreground']]);
  });
});
