import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

/** Give editable fields native text actions without claiming the renderer-owned
 * context menus on feed messages and sidebar rows. */
export function installEditableTextMenu(window: BrowserWindow): void {
  const contents = window.webContents;
  contents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;

    const template: MenuItemConstructorOptions[] = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions) {
        template.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
      }
      if (params.dictionarySuggestions.length > 0) template.push({ type: 'separator' });
      template.push({
        label: 'Learn Spelling',
        click: () => { contents.session.addWordToSpellCheckerDictionary(params.misspelledWord); },
      });
      template.push({ type: 'separator' });
    }

    template.push(
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    );
    Menu.buildFromTemplate(template).popup({
      window,
      frame: params.frame ?? undefined,
      x: params.x,
      y: params.y,
      sourceType: params.menuSourceType,
    });
  });
}
