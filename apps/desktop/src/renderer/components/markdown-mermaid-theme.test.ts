import { describe, expect, it, vi } from 'vitest';
import { readMermaidThemeConfig } from './markdown-mermaid-theme';

describe('Mermaid theme', () => {
  it('builds the diagram palette entirely from Rally design tokens', () => {
    const readToken = vi.fn((customProperty: string) => {
      if (customProperty === '--av-sys-size-radius-md') return '7px';
      if (customProperty === '--av-sys-size-border-hairline') return '1px';
      return `resolved(${customProperty})`;
    });

    const { themeCSS, themeVariables } = readMermaidThemeConfig(readToken);

    expect(themeVariables).toMatchObject({
      actorBkg: 'resolved(--av-sys-color-surface-elevated)',
      actorBorder: 'resolved(--av-sys-color-border-default)',
      actorTextColor: 'resolved(--av-sys-color-text-default)',
      fontFamily: 'resolved(--av-sys-font-family-ui)',
      fontSize: 'resolved(--av-sys-font-size-prose)',
      lineColor: 'resolved(--av-cmp-markdown-diagram-line)',
      noteBkgColor: 'resolved(--av-sys-color-warning-wash)',
      noteBorderColor: 'resolved(--av-sys-color-warning-edge)',
      primaryColor: 'resolved(--av-sys-color-surface-elevated)',
      primaryTextColor: 'resolved(--av-sys-color-text-default)',
      radius: 7,
      sequenceNumberColor: 'resolved(--av-sys-color-accent-base)',
      strokeWidth: 1,
    });
    expect(themeVariables['cScale0']).toBe('resolved(--av-sys-color-brand-wash)');
    expect(themeVariables['cScaleInv0']).toBe('resolved(--av-sys-color-brand-base)');
    expect(themeVariables['pie12']).toBe('resolved(--av-sys-color-surface-raised-hover)');
    expect(themeCSS).toContain('resolved(--av-sys-color-accent-on)');
    expect(readToken).toHaveBeenCalledWith('--av-cmp-markdown-diagram-line');
    expect(readToken).toHaveBeenCalledWith('--av-sys-color-surface-raised');
  });

  it('fails closed when a theme token or measurement is unavailable', () => {
    expect(() => readMermaidThemeConfig(() => '')).toThrow('mermaid_theme_token_missing');
    expect(() => readMermaidThemeConfig(() => 'not-a-measurement')).toThrow('mermaid_theme_measurement_invalid');
  });
});
