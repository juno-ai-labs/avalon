import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  emptyMenuBarContent,
  menuBarLabel,
  menuBarMenuTemplate,
  menuBarTitle,
  supportsSectionHeaders,
  type MenuBarActions,
  type MenuBarRow,
  type MenuBarContent,
} from './menu-bar-menu';

function actions(): MenuBarActions {
  return { selected: vi.fn(), open: vi.fn(), openRally: vi.fn(), quit: vi.fn() };
}

function template(
  content: Partial<MenuBarContent>,
  overrides: { signedIn?: boolean; sectionHeaders?: boolean; actions?: MenuBarActions } = {},
): MenuItemConstructorOptions[] {
  return menuBarMenuTemplate({
    appName: 'Rally',
    content: { ...emptyMenuBarContent, attentionComplete: true, recentsComplete: true, ...content },
    signedIn: overrides.signedIn ?? true,
    sectionHeaders: overrides.sectionHeaders ?? true,
    actions: overrides.actions ?? actions(),
  });
}

/** `click` is declared with the menu item, window, and event AppKit passes; the
 * template's own handlers ignore all three. */
function activate(item: MenuItemConstructorOptions | undefined): void {
  (item?.click as (() => void) | undefined)?.();
}

function labels(items: MenuItemConstructorOptions[]): (string | undefined)[] {
  return items.map((item) => (item.type === 'separator' ? '—' : item.label));
}

function canvas(id: string, title: string, detail: string | null = null): MenuBarRow {
  return { key: `canvas:${id}`, kind: 'canvas', id, title, detail };
}

function sidekick(id: string, name: string, detail = 'Needs input'): MenuBarRow {
  return { key: `sidekick:${id}`, kind: 'sidekick', id, title: name, detail };
}

describe('menu bar menu', () => {
  it('draws Needs attention, then Recent Canvases, then the app controls', () => {
    const items = template({
      attention: [sidekick('triage', 'Incident triage'), canvas('q4', 'Q4 review', 'Unread')],
      recents: [canvas('q4', 'Q4 review'), canvas('plan', 'Launch plan')],
    });
    expect(labels(items)).toEqual([
      'Needs attention', 'Incident triage', 'Q4 review', '—',
      'Recent Canvases', 'Q4 review', 'Launch plan', '—',
      'Open Rally', 'Quit Rally',
    ]);
    expect(items[1]?.sublabel).toBe('Needs input');
    expect(items[2]?.sublabel).toBe('Unread');
  });

  it('lists at most five rows in each section, in the order given', () => {
    const many = Array.from({ length: 7 }, (_value, index) => canvas(`c${index}`, `Canvas ${index}`, 'Unread'));
    const items = template({ attention: many, recents: many });
    expect(labels(items).filter((label) => label?.startsWith('Canvas '))).toHaveLength(10);
    expect(labels(items)[1]).toBe('Canvas 0');
  });

  it('says why a section is empty, and never says so before its list has arrived', () => {
    expect(labels(template({}))).toContain('Nothing needs your attention');
    expect(labels(template({}))).toContain('No Canvases yet');
    const loading = labels(template({ attentionComplete: false, recentsComplete: false }));
    expect(loading).toContain('Still loading');
    expect(loading).toContain('Still loading Canvases');
    expect(loading).not.toContain('Nothing needs your attention');
  });

  it('shows the signed-out state once, with nothing to list', () => {
    expect(labels(template({ attention: [canvas('a', 'A', 'Unread')] }, { signedIn: false })))
      .toEqual(['Needs attention', 'Sign in to Rally', '—', 'Open Rally', 'Quit Rally']);
  });

  it('heads both sections, and falls back to a disabled row where macOS has no section headers', () => {
    const items = template({}, { sectionHeaders: false });
    expect(items[0]).toEqual({ label: 'Needs attention', enabled: false });
    expect(template({})[0]).toEqual({ label: 'Needs attention', type: 'header' });
  });

  it('opens each row in the main window and reports which section it came from', () => {
    const handlers = actions();
    const items = template({
      attention: [sidekick('triage', 'Incident triage')],
      recents: [canvas('plan', 'Launch plan')],
    }, { actions: handlers });
    activate(items.find((item) => item.label === 'Incident triage'));
    activate(items.find((item) => item.label === 'Launch plan'));
    expect(handlers.open).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'sidekick', id: 'triage' }));
    expect(handlers.open).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'canvas', id: 'plan' }));
    expect(handlers.selected).toHaveBeenNthCalledWith(1, 'attention_conversation');
    expect(handlers.selected).toHaveBeenNthCalledWith(2, 'recent_workstream');
  });

  it('does not let failed selection reporting block the menu action', () => {
    const handlers = actions();
    vi.mocked(handlers.selected).mockImplementation(() => { throw new Error('telemetry down'); });
    activate(template({ recents: [canvas('plan', 'Launch plan')] }, { actions: handlers })
      .find((item) => item.label === 'Launch plan'));
    expect(handlers.open).toHaveBeenCalledOnce();
  });

  it('writes the count beside the icon the way the sidebar button does', () => {
    expect(menuBarTitle(0)).toBe('');
    expect(menuBarTitle(1)).toBe('1');
    expect(menuBarTitle(99)).toBe('99');
    expect(menuBarTitle(100)).toBe('99+');
  });

  it('reads the macOS version that decides whether section headers exist', () => {
    // macOS 14 introduced them; Rally targets 26 and 27, where they are the
    // native treatment.
    expect(supportsSectionHeaders('26.1')).toBe(true);
    expect(supportsSectionHeaders('14.0.0')).toBe(true);
    expect(supportsSectionHeaders('13.6.1')).toBe(false);
    expect(supportsSectionHeaders('')).toBe(false);
  });

  it('flattens a model-written title into one readable row', () => {
    expect(menuBarLabel('  Reply to\n  the Acme  thread ')).toBe('Reply to the Acme thread');
    expect(menuBarLabel('Reply to Dana')).toBe('Reply to Dana');
  });

  it('truncates a long label at a word boundary, never mid-word', () => {
    // 180 characters is what the work-stream contract allows, and a title Rally
    // wrote itself can run most of them.
    const title = 'Prepare the Acme client follow-up and capture every promised action with an owner';
    const truncated = menuBarLabel(title);

    expect(truncated).toBe('Prepare the Acme client follow-up and capture every…');
    expect(truncated.length).toBeLessThanOrEqual(60);
    expect(title.startsWith(truncated.slice(0, -1))).toBe(true);
  });

  it('drops punctuation left dangling by the cut', () => {
    expect(menuBarLabel('Investigate ENG-142, ENG-143, and the retry storm behind both of them'))
      .toBe('Investigate ENG-142, ENG-143, and the retry storm behind…');
  });

  it('cuts between characters a reader sees, never through one', () => {
    // 70 visible characters, 140 code units, and no space to retreat to — so
    // the cut is hard and lands where a code-unit slice would split a pair.
    const label = menuBarLabel('🎯'.repeat(70));

    // A slice by code unit lands inside a surrogate pair and renders as `�`
    // immediately before the ellipsis.
    expect(label).not.toContain('�');
    expect([...label].every((character) => character !== '\uD83C' && character !== '\uDFAF')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    expect([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(label)].length)
      .toBeLessThanOrEqual(60);
  });

  it('cuts hard when trimming to a word would leave a stub', () => {
    // One long word, or a boundary too near the start: the space saved is worth
    // less than the label it would throw away.
    const single = menuBarLabel('x'.repeat(200));
    expect(single).toHaveLength(60);
    expect(single.endsWith('…')).toBe(true);

    expect(menuBarLabel(`Acme ${'y'.repeat(120)}`)).toBe(`Acme ${'y'.repeat(54)}…`);
  });
});
