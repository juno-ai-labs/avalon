import { describe, expect, it } from 'vitest';
import { PLUGIN_BRAND_MARKS, connectorBrandMark, isPluginBrandMark } from './plugin-marks';

describe('PLUGIN_BRAND_MARKS', () => {
  it('gives every brand a component of its own', () => {
    const marks = Object.entries(PLUGIN_BRAND_MARKS);
    expect(marks.length).toBeGreaterThan(0);
    // A shared component would mean two companies drawing the same mark.
    expect(new Set(marks.map(([, brand]) => brand.Mark)).size).toBe(marks.length);
  });

  it('narrows a company name apart from the shapes no company owns', () => {
    expect(isPluginBrandMark('slack')).toBe(true);
    expect(isPluginBrandMark('ashby')).toBe(true);
    expect(isPluginBrandMark('fireflies')).toBe(true);
    expect(isPluginBrandMark('computer')).toBe(false);
    expect(isPluginBrandMark('webhook')).toBe(false);
  });
});

describe('connectorBrandMark', () => {
  it('tells the two Google connectors apart by the name they display', () => {
    // One connector type, two brands. The backend discriminates the same way.
    expect(connectorBrandMark('google', 'Google Mail + Calendar')).toBe('google');
    expect(connectorBrandMark('google', 'Google Drive + Docs + Sheets')).toBe('google-drive');
  });

  it('names a real mark for every connector Rally has an adapter for', () => {
    const adapters = ['ashby', 'fireflies', 'github', 'google', 'granola', 'linear', 'notion', 'slack', 'x'];
    for (const connectorType of adapters) {
      const mark = connectorBrandMark(connectorType);
      expect(mark, connectorType).not.toBeNull();
      expect(PLUGIN_BRAND_MARKS[mark!].Mark, connectorType).toBeDefined();
    }
  });

  it('leaves a webhook and an unknown connector without one', () => {
    // A webhook is not a company; there is no mark to be missing.
    expect(connectorBrandMark('generic_webhook')).toBeNull();
    expect(connectorBrandMark('some_future_service')).toBeNull();
  });
});
