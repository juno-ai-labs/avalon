import { useContext } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationVisibilityContext } from './conversation-visibility';
import { useVisibleReadAcknowledgement } from './use-visible-read-acknowledgement';
import { useWindowFilePaste } from './use-file-paste';

describe('hidden conversation activity', () => {
  afterEach(() => vi.useRealTimers());
  it('cancels queued reads and ignores paste and transcript changes while hidden, then resumes', () => {
    vi.useFakeTimers();
    const read = vi.fn();
    const addFiles = vi.fn();
    function Probe({ revision }: { revision: number }): null {
      const visible = useContext(ConversationVisibilityContext);
      useWindowFilePaste(addFiles, !visible);
      useVisibleReadAcknowledgement(() => read(revision));
      return null;
    }
    const tree = (visible: boolean, revision: number) => <ConversationVisibilityContext value={visible}><Probe revision={revision} /></ConversationVisibilityContext>;
    const { rerender } = render(tree(true, 1));
    act(() => vi.advanceTimersByTime(100));
    rerender(tree(false, 2));
    fireEvent.paste(document.body, { clipboardData: { files: [new File(['photo'], 'image.png', { type: 'image/png' })], getData: () => '' } });
    fireEvent.focus(window);
    act(() => vi.advanceTimersByTime(500));
    expect(read).not.toHaveBeenCalled();
    expect(addFiles).not.toHaveBeenCalled();
    rerender(tree(true, 2));
    fireEvent.paste(document.body, { clipboardData: { files: [new File(['photo'], 'image.png', { type: 'image/png' })], getData: () => '' } });
    act(() => vi.advanceTimersByTime(250));
    expect(read).toHaveBeenCalledExactlyOnceWith(2);
    expect(addFiles).toHaveBeenCalledOnce();
  });
});
