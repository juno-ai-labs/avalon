import { createRef, type ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ComposerInput } from './composer-input';

function renderInput(props: Partial<ComponentProps<typeof ComposerInput>> = {}): ReturnType<typeof render> {
  return render(
    <Tooltip.Provider>
      <ComposerInput
        ariaLabel="Message"
        attachments={[]}
        fileInputRef={createRef<HTMLInputElement>()}
        onAttach={() => undefined}
        onMention={() => undefined}
        onOpenAttachment={() => undefined}
        onRemoveAttachment={() => undefined}
        onRetryAttachment={() => undefined}
        onSubmit={() => undefined}
        onValueChange={() => undefined}
        placeholder="Message…"
        submitDisabled={false}
        submitLabel="Send"
        uploading={false}
        value="Hello there"
        {...props}
      />
    </Tooltip.Provider>,
  );
}

describe('ComposerInput errors', () => {
  it('titles a send error with what happened when the host says it', () => {
    renderInput({ error: 'This message is over 100,000 characters, please shorten it.', errorTitle: 'Message too long' });
    expect(screen.getByRole('alertdialog', { name: 'Message too long' })).toHaveTextContent('This message is over 100,000 characters');
  });

  it('keeps the generic title for an error the host does not name', () => {
    renderInput({ error: 'The message couldn’t be sent. Try again.' });
    expect(screen.getByRole('alertdialog', { name: 'Something went wrong' })).toBeInTheDocument();
  });
});

describe('ComposerInput IME composition guard', () => {
  it('does not submit an Enter that is still committing an IME composition', () => {
    const onSubmit = vi.fn();
    renderInput({ onSubmit });
    const textarea = screen.getByLabelText('Message');

    // `fireEvent` reports whether the event survived: the keystroke has to reach
    // the IME uncancelled, or the composition it was going to commit is lost.
    expect(fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();

    expect(fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('hands the host no keydown while an IME is composing, and hands it every other one', () => {
    // The guard runs before `onKeyDown`, so a host's mention navigation, popover
    // dismissal, and slash commands never see a key the IME still owns.
    const seen: string[] = [];
    renderInput({ onKeyDown: (event) => { seen.push(event.key); } });
    const textarea = screen.getByLabelText('Message');

    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Tab', keyCode: 229 });
    expect(seen).toEqual([]);

    fireEvent.keyDown(textarea, { key: 'Escape' });
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(seen).toEqual(['Escape', 'Tab']);
  });

  it('leaves Enter to the textarea when the host says it is not a submit', () => {
    const onSubmit = vi.fn();
    renderInput({ onSubmit, shouldSubmitOnEnter: () => false });
    const textarea = screen.getByLabelText('Message');

    // Uncancelled as well as unsent: this is the newline a composer with an open
    // mention list still owes the draft.
    expect(fireEvent.keyDown(textarea, { key: 'Enter' })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('ComposerInput message capsule', () => {
  it('retains multiline state beneath the attachment layout and clears it for short text', () => {
    // jsdom has no layout; expose the compact/attachment minimum heights and
    // a two-line draft so the component must measure outside attachment mode.
    const clientHeight = vi.spyOn(HTMLTextAreaElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLTextAreaElement) {
        return this.closest('.has-attachments') ? 67 : 42;
      });
    const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLTextAreaElement) {
        return this.value.includes('\n') ? 55 : 42;
      });
    try {
      renderInput({ layout: 'message-capsule', className: 'has-attachments', value: 'First\nSecond' });
      const composer = document.querySelector('.workstream-composer');
      expect(composer).toHaveAttribute('data-multiline', 'true');
      expect(composer).toHaveClass('has-attachments');
      fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Short' } });
      expect(composer).toHaveAttribute('data-multiline', 'false');
    } finally {
      clientHeight.mockRestore();
      scrollHeight.mockRestore();
    }
  });

  it('keeps send on screen but disabled around an empty draft', () => {
    renderInput({
      api: { getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() },
      layout: 'message-capsule',
      submitDisabled: true,
      value: '',
    });

    expect(document.querySelector('.workstream-composer')).toHaveClass('is-message-capsule');
    expect(screen.getByRole('button', { name: 'Composer actions' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mention a participant' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose microphone' })).not.toBeInTheDocument();
    // Absent is what this used to be, and an empty composer then had nothing on
    // it that said how to send.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('enables send without taking dictation away when the draft has content', () => {
    renderInput({
      api: { getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() },
      layout: 'message-capsule',
      value: 'Hello there',
    });

    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeVisible();
  });
});

/**
 * The rules themselves are `lib/markdown-lists`, proved there against text and
 * offsets. These cover the wiring: which keystroke reaches which operation,
 * and that a handled one is cancelled while an unhandled one is not. jsdom has
 * no `execCommand`,
 * so the component takes its fallback and the new draft arrives through
 * `onValueChange` — which is also what a real window's `input` event delivers.
 */
describe('ComposerInput markdown lists', () => {
  function composeAt(value: string, caret: number, props: Partial<ComponentProps<typeof ComposerInput>> = {}): {
    onValueChange: ReturnType<typeof vi.fn>;
    textarea: HTMLTextAreaElement;
  } {
    const onValueChange = vi.fn();
    renderInput({ onValueChange, value, ...props });
    const textarea = screen.getByLabelText('Message') as HTMLTextAreaElement;
    textarea.setSelectionRange(caret, caret);
    return { onValueChange, textarea };
  }

  it('carries a numbered list on to the next line', () => {
    const { onValueChange, textarea } = composeAt('1. first', 8, { shouldSubmitOnEnter: () => false });
    // Cancelled: the composer wrote the newline, and the field must not write a
    // second one under the marker it just inserted.
    expect(fireEvent.keyDown(textarea, { key: 'Enter' })).toBe(false);
    expect(onValueChange).toHaveBeenCalledWith('1. first\n2. ');
  });

  it('continues a list on Shift+Enter while a plain Enter still sends', () => {
    const onSubmit = vi.fn();
    const { onValueChange, textarea } = composeAt('- first', 7, { onSubmit });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onValueChange).toHaveBeenCalledWith('- first\n- ');
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('leaves the list alone when Enter has nothing to continue', () => {
    const { onValueChange, textarea } = composeAt('just prose', 10, { shouldSubmitOnEnter: () => false });
    expect(fireEvent.keyDown(textarea, { key: 'Enter' })).toBe(true);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('nests an item with Tab', () => {
    const { onValueChange, textarea } = composeAt('- a\n- b', 7);
    expect(fireEvent.keyDown(textarea, { key: 'Tab' })).toBe(false);
    expect(onValueChange).toHaveBeenCalledWith('- a\n  - b');
  });

  it('keeps Tab inside the list even where the indent has nowhere to go', () => {
    // Cancelled and unchanged. Tab that indents four times and then, with
    // nothing on screen having moved, throws the caret out of the field is the
    // thing this is for; the depth cap is proved in the module's own tests.
    const { onValueChange, textarea } = composeAt('- a\n  - b\n    - c\n      - d\n        - e\n          - f\n          - g', 68);
    expect(fireEvent.keyDown(textarea, { key: 'Tab' })).toBe(false);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('lets Tab out of the composer when the caret is not in a list', () => {
    const { onValueChange, textarea } = composeAt('just prose', 10);
    // Uncancelled: an ordinary message keeps the way out of the field it had.
    expect(fireEvent.keyDown(textarea, { key: 'Tab' })).toBe(true);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('toggles a list from the keyboard on the physical digit', () => {
    const { onValueChange, textarea } = composeAt('write it up', 0);
    // `*` is what Shift+8 reports; `Digit8` is what was pressed.
    expect(fireEvent.keyDown(textarea, { key: '*', code: 'Digit8', shiftKey: true, metaKey: true })).toBe(false);
    expect(onValueChange).toHaveBeenCalledWith('- write it up');
  });

  /**
   * The tests above take the fallback, because jsdom defines no `execCommand`.
   * This one stands one in, so the branch that actually runs in Electron is
   * covered: the contiguous span the prefix rewrites collapse to, and the
   * choice of command when that span is a deletion. Everything the undo-stack
   * claim rests on is in those three lines, and an error in the head/tail
   * arithmetic would corrupt a draft rather than fail loudly.
   */
  interface EditCommand { command: string; text: string; start: number; end: number }

  function withExecCommand(): EditCommand[] {
    const commands: EditCommand[] = [];
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: (command: string, _ui: boolean, text?: string) => {
        const field = document.activeElement as HTMLTextAreaElement;
        // Recorded before the edit: the selection is the span `applyDraftEdit`
        // chose, and it is the thing under test. The field's own value is not —
        // these are controlled textareas whose `value` prop the test holds
        // fixed, so React writes it back on the render that follows.
        commands.push({ command, text: text ?? '', start: field.selectionStart, end: field.selectionEnd });
        field.setRangeText(text ?? '', field.selectionStart, field.selectionEnd, 'end');
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      },
    });
    onTestFinished(() => { Reflect.deleteProperty(document, 'execCommand'); });
    return commands;
  }

  it('collapses a continuation and the renumber below it to one span', () => {
    const commands = withExecCommand();
    // An item with another below it, so the edit is a continuation *and* a
    // renumber of a line further down — the case where the span is neither the
    // caret nor the rest of the draft, and where getting either end of it wrong
    // would eat text rather than fail loudly.
    const { onValueChange, textarea } = composeAt('1. first\n1. third', 8, { shouldSubmitOnEnter: () => false });
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'Enter' });

    // Offsets 9 to 10 is the `1` of the third item — everything either side of
    // it is untouched, so that one character is what the undo stack records.
    expect(commands).toEqual([{ command: 'insertText', text: '2. \n3', start: 9, end: 10 }]);
    // And the command's own input event is what carries the draft to the host.
    expect(onValueChange).toHaveBeenCalledWith('1. first\n2. \n3. third');
  });

  it('removes a marker with the command that deletes, not an empty insert', () => {
    const commands = withExecCommand();
    const { onValueChange, textarea } = composeAt('- a\n- ', 6, { shouldSubmitOnEnter: () => false });
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'Enter' });

    // `insertText` with nothing to insert is not a delete in every engine. The
    // span is the marker the draft is losing — offsets 4 to 6, not 4 to 4.
    expect(commands).toEqual([{ command: 'delete', text: '', start: 4, end: 6 }]);
    expect(onValueChange).toHaveBeenCalledWith('- a\n');
  });

  it('leaves the composer menu to attachments alone', () => {
    composeAt('', 0, { layout: 'message-capsule' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Composer actions' }), { button: 0, ctrlKey: false });
    // A list is started by typing one, so the menu offers no list command to
    // get out of step with what the keys do.
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Attach files']);
  });

  it('lists a host action after Attach files and runs it when chosen', () => {
    const onSelect = vi.fn();
    composeAt('', 0, { layout: 'message-capsule', menuActions: [{ icon: null, label: 'Import from Claude or ChatGPT', onSelect }] });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Composer actions' }), { button: 0, ctrlKey: false });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Attach files', 'Import from Claude or ChatGPT']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import from Claude or ChatGPT' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('shows a host action it cannot run as disabled, saying why', async () => {
    const onSelect = vi.fn();
    composeAt('', 0, {
      layout: 'message-capsule',
      menuActions: [{ disabledReason: 'Importing needs the Rally Mac app', icon: null, label: 'Import from Claude or ChatGPT', onSelect }],
    });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Composer actions' }), { button: 0, ctrlKey: false });
    const item = screen.getByRole('menuitem', { name: 'Import from Claude or ChatGPT' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    // Reached the way a keyboard reaches it: arrowing past Attach files.
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toHaveTextContent('Attach files'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(item));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Importing needs the Rally Mac app');
    fireEvent.keyDown(item, { key: 'Enter' });
    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens the menu for host actions when the host takes no attachments', () => {
    composeAt('', 0, { layout: 'message-capsule', menuActions: [{ icon: null, label: 'Import from Claude or ChatGPT', onSelect: () => undefined }], onAttach: undefined });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Composer actions' }), { button: 0, ctrlKey: false });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Import from Claude or ChatGPT']);
  });
});
