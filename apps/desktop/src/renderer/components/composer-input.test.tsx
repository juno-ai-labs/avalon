import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it, vi } from 'vitest';
import { ComposerInput } from './composer-input';

function renderInput(onSubmit: () => void): ReturnType<typeof render> {
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
        onSubmit={onSubmit}
        onValueChange={() => undefined}
        placeholder="Message…"
        submitDisabled={false}
        submitLabel="Send"
        uploading={false}
        value="Hello there"
      />
    </Tooltip.Provider>,
  );
}

describe('ComposerInput IME composition guard', () => {
  it('does not submit an Enter that is still committing an IME composition', () => {
    const onSubmit = vi.fn();
    renderInput(onSubmit);
    const textarea = screen.getByLabelText('Message');

    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();

    // Safari reports the composition only as the legacy keycode.
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
