import { createRef, type ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it, vi } from 'vitest';
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

  it('shows only the action menu and voice chrome around an empty draft', () => {
    renderInput({
      api: { getTranscriptionSocketTicket: vi.fn() },
      layout: 'message-capsule',
      submitDisabled: true,
      value: '',
    });

    expect(document.querySelector('.workstream-composer')).toHaveClass('is-message-capsule');
    expect(screen.getByRole('button', { name: 'Composer actions' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mention a participant' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose microphone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('adds send without taking dictation away when the draft has content', () => {
    renderInput({
      api: { getTranscriptionSocketTicket: vi.fn() },
      layout: 'message-capsule',
      value: 'Hello there',
    });

    expect(screen.getByRole('button', { name: 'Send' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeVisible();
  });
});
