import { describe, expect, it } from 'vitest';
import { embeddedBrowserFavicon, embeddedBrowserShortcut } from './embedded-browser';

const key = (value: string, code: string, modifiers: Partial<{ command: boolean; control: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key: value, code, command: false, control: false, shift: false, alt: false, ...modifiers,
});

describe('browser shortcuts', () => {
  it('maps the familiar browser keys, with the platform’s primary modifier', () => {
    expect(embeddedBrowserShortcut(key('t', 'KeyT', { command: true }))).toEqual({ kind: 'new-tab' });
    expect(embeddedBrowserShortcut(key('W', 'KeyW', { command: true }))).toEqual({ kind: 'close-tab' });
    expect(embeddedBrowserShortcut(key('l', 'KeyL', { command: true }))).toEqual({ kind: 'focus-address' });
    expect(embeddedBrowserShortcut(key('r', 'KeyR', { command: true }))).toEqual({ kind: 'reload' });
    expect(embeddedBrowserShortcut(key('[', 'BracketLeft', { command: true }))).toEqual({ kind: 'back' });
    expect(embeddedBrowserShortcut(key(']', 'BracketRight', { command: true }))).toEqual({ kind: 'forward' });
    expect(embeddedBrowserShortcut(key('}', 'BracketRight', { command: true, shift: true }))).toEqual({ kind: 'next-tab' });
    expect(embeddedBrowserShortcut(key('{', 'BracketLeft', { command: true, shift: true }))).toEqual({ kind: 'previous-tab' });
    expect(embeddedBrowserShortcut(key('Tab', 'Tab', { control: true }))).toEqual({ kind: 'next-tab' });
    expect(embeddedBrowserShortcut(key('Tab', 'Tab', { control: true, shift: true }))).toEqual({ kind: 'previous-tab' });
    expect(embeddedBrowserShortcut(key('3', 'Digit3', { command: true }))).toEqual({ kind: 'tab-at', index: 2 });
    expect(embeddedBrowserShortcut(key('9', 'Digit9', { command: true }))).toEqual({ kind: 'tab-at', index: 'last' });
  });

  it('leaves ordinary typing, Option combinations and unbound keys to the page', () => {
    expect(embeddedBrowserShortcut(key('t', 'KeyT'))).toBeNull();
    expect(embeddedBrowserShortcut(key('t', 'KeyT', { command: true, alt: true }))).toBeNull();
    expect(embeddedBrowserShortcut(key('c', 'KeyC', { command: true }))).toBeNull();
    expect(embeddedBrowserShortcut(key('T', 'KeyT', { command: true, shift: true }))).toBeNull();
  });
});

describe('page icons drawn in Rally', () => {
  it('keeps https icons and image data, and nothing else', () => {
    expect(embeddedBrowserFavicon('https://claude.ai/favicon.ico')).toBe('https://claude.ai/favicon.ico');
    expect(embeddedBrowserFavicon('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(embeddedBrowserFavicon('http://example.com/favicon.ico')).toBeNull();
    expect(embeddedBrowserFavicon('javascript:alert(1)')).toBeNull();
    expect(embeddedBrowserFavicon('data:text/html,<script>1</script>')).toBeNull();
    expect(embeddedBrowserFavicon(undefined)).toBeNull();
  });
});
