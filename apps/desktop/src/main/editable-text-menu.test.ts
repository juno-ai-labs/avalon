import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions, type WebFrameMain } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import { installEditableTextMenu } from './editable-text-menu';

vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

function setup() {
  let contextMenu!: (_event: unknown, params: ContextMenuParams) => void;
  const replaceMisspelling = vi.fn();
  const addWordToSpellCheckerDictionary = vi.fn();
  const popup = vi.fn();
  vi.mocked(Menu.buildFromTemplate).mockReturnValue({ popup } as unknown as Menu);
  const window = {
    webContents: {
      on: vi.fn((event: string, listener: typeof contextMenu) => {
        if (event === 'context-menu') contextMenu = listener;
      }),
      replaceMisspelling,
      session: { addWordToSpellCheckerDictionary },
    },
  } as unknown as BrowserWindow;
  installEditableTextMenu(window);
  const params = {
    isEditable: true,
    frame: {} as WebFrameMain,
    x: 120,
    y: 240,
    menuSourceType: 'keyboard',
    misspelledWord: 'recomendations',
    dictionarySuggestions: ['recommendations'],
    editFlags: {
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: false,
      canSelectAll: true,
    },
  } as ContextMenuParams;
  return { window, contextMenu, params, popup, replaceMisspelling, addWordToSpellCheckerDictionary };
}

it('opens no native menu for non-editable targets', () => {
  const subject = setup();
  subject.contextMenu({}, { ...subject.params, isEditable: false });
  expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
  expect(subject.popup).not.toHaveBeenCalled();
});

it('uses the originating frame, location, capabilities, and spelling actions', () => {
  const subject = setup();
  subject.contextMenu({}, subject.params);

  expect(subject.popup).toHaveBeenCalledWith({
    window: subject.window,
    frame: subject.params.frame,
    x: 120,
    y: 240,
    sourceType: 'keyboard',
  });
  const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0]![0] as MenuItemConstructorOptions[];
  expect(template.map((item) => item.role ?? item.label ?? item.type)).toEqual([
    'recommendations', 'separator', 'Learn Spelling', 'separator',
    'undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'selectAll',
  ]);
  expect(template.find((item) => item.role === 'paste')?.enabled).toBe(false);
  template[0]!.click?.({} as never, {} as never, {} as never);
  template[2]!.click?.({} as never, {} as never, {} as never);
  expect(subject.replaceMisspelling).toHaveBeenCalledWith('recommendations');
  expect(subject.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('recomendations');
});
