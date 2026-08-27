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
