import type React from 'react';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorNotice } from '@rally/ui/components/error-notice';
import { isPastedText, LONG_PASTE_CHARACTERS } from './pasted-text';
import { useFilePaste, useWindowFilePaste } from './use-file-paste';

function pasteEvent(input: { files?: File[]; text?: string } = {}): React.ClipboardEvent<HTMLElement> {
  const files = input.files ?? [];
  return {
    preventDefault: vi.fn(),
    clipboardData: {
      files: files as unknown as FileList,
      getData: (type: string) => type === 'text/plain' ? input.text ?? '' : '',
      types: [...(input.text ? ['text/plain'] : []), ...(files.length > 0 ? ['Files'] : [])],
    },
  } as unknown as React.ClipboardEvent<HTMLElement>;
}

afterEach(() => vi.useRealTimers());

describe('useFilePaste', () => {
  it('attaches a pasted screenshot under a name that separates it from the next one', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 9, 4, 5));
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles));
    const event = pasteEvent({ files: [new File(['png'], 'image.png', { type: 'image/png' })] });

    result.current(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    const [pasted] = onFiles.mock.calls[0]![0] as File[];
    expect(pasted!.name).toBe('Pasted image 2026-08-11 at 09.04.05.png');
    expect(pasted!.type).toBe('image/png');
  });

  it('leaves a text-only paste to the text surface', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles));
    const event = pasteEvent({ text: 'ship it' });

    result.current(event);

    expect(onFiles).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps images pasted in the same second apart', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 9, 4, 5));
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles));

    result.current(pasteEvent({
      files: [
        new File(['a'], 'image.png', { type: 'image/png' }),
        new File(['b'], 'image.png', { type: 'image/png' }),
      ],
    }));
    // A second paste landing on the same second must not reuse the first's names either.
    result.current(pasteEvent({ files: [new File(['c'], 'image.png', { type: 'image/png' })] }));

    const names = onFiles.mock.calls.flatMap(([files]) => (files as File[]).map((file) => file.name));
    expect(names).toEqual([
      'Pasted image 2026-08-11 at 09.04.05.png',
      'Pasted image 2026-08-11 at 09.04.05 (2).png',
      'Pasted image 2026-08-11 at 09.04.05 (3).png',
    ]);
  });

  it('names an SVG by its extension and leaves a file that is not an image alone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 9, 4, 5));
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles));
    const blob = new File([''], '', { type: '' });

    result.current(pasteEvent({
      files: [new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' }), blob],
    }));

    const [pasted] = onFiles.mock.calls[0]! as [File[]];
    expect(pasted[0]!.name).toBe('Pasted image 2026-08-11 at 09.04.05.svg');
    // Renaming a typeless blob to `.png` would earn it a broken image preview.
    expect(pasted[1]).toBe(blob);
  });

  it('pastes copied prose and attaches the image that came inside it', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles));
    const inline = new File(['png'], 'image001.png', { type: 'image/png' });
    const event = pasteEvent({ files: [inline], text: 'The retry window overlaps the timeout.' });

    result.current(event);

    expect(onFiles).toHaveBeenCalledWith([inline]);
    // The prose is what was copied, so it still reaches the caret.
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps copied text rather than the picture of itself that came with it', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles));
    const event = pasteEvent({
      files: [new File(['png'], 'image.png', { type: 'image/png' })],
      text: 'Region\tRevenue\nEU\t12',
    });

    result.current(event);

    expect(onFiles).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('attaches a named file even when the clipboard also carries its path', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles));
    const file = new File(['png'], 'quarterly-chart.png', { type: 'image/png' });
    const event = pasteEvent({ files: [file], text: '/Users/adam/quarterly-chart.png' });

    result.current(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('attaches a file named like a synthesized bitmap when the clipboard paths it', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles));
    const file = new File(['png'], 'image.png', { type: 'image/png' });
    const event = pasteEvent({ files: [file], text: '/Users/adam/Pictures/image.png' });

    result.current(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    // A path proves the file came off disk, so it keeps both its attachment and its name.
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('reads a file URL as the clipboard describing its own files', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles));
    const first = new File(['png'], 'image.png', { type: 'image/png' });
    const second = new File(['pdf'], 'Q3 report.pdf', { type: 'application/pdf' });
    const event = pasteEvent({
      files: [first, second],
      text: 'file:///Users/adam/image.png\nfile:///Users/adam/Q3%20report.pdf',
    });

    result.current(event);

    expect(onFiles).toHaveBeenCalledWith([first, second]);
  });

  it('attaches long pasted text as a file for the API to type and name', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 9, 4, 5));
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles));
    const text = `# Launch plan\n\n${'We ship on Tuesday. '.repeat(300)}`;
    const event = pasteEvent({ text });

    result.current(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    const [pasted] = onFiles.mock.calls[0]![0] as File[];
    expect(pasted!.name).toBe('Pasted text 2026-08-11 at 09.04.05.txt');
    expect(pasted!.type).toBe('text/plain');
    expect(await pasted!.text()).toBe(text);
    expect(isPastedText(pasted!)).toBe(true);
  });

  it('pastes text just under the long-paste length at the caret', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles));
    const event = pasteEvent({ text: 'a'.repeat(LONG_PASTE_CHARACTERS - 1) });

    result.current(event);

    expect(onFiles).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('pastes long text at the caret when the message has no room for another file', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles, false, false));
    const event = pasteEvent({ text: 'a'.repeat(LONG_PASTE_CHARACTERS) });

    result.current(event);

    expect(onFiles).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('attaches a long spreadsheet copy as its text, not the picture of it', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles));
    const rows = Array.from({ length: 600 }, (_, index) => `Region ${index}\t${index * 12}`).join('\n');
    const event = pasteEvent({ files: [new File(['png'], 'image.png', { type: 'image/png' })], text: rows });

    result.current(event);

    const files = onFiles.mock.calls[0]![0] as File[];
    expect(files.map((file) => file.type)).toEqual(['text/plain']);
  });

  it('ignores every paste while the surface is disabled', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles, true));
    const event = pasteEvent({ files: [new File(['png'], 'image.png', { type: 'image/png' })] });

    result.current(event);

    expect(onFiles).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

function dispatchPaste(target: EventTarget, files: File[]): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: files as unknown as FileList,
      getData: () => '',
      types: files.length > 0 ? ['Files'] : [],
    },
  });
  target.dispatchEvent(event);
  return event;
}

describe('useWindowFilePaste', () => {
  afterEach(() => { cleanup(); document.body.replaceChildren(); });

  it('does not attach a screenshot pasted on an error popup OK button', async () => {
    const onFiles = vi.fn();
    function Host() {
      useWindowFilePaste(onFiles);
      return <ErrorNotice>The message couldn’t be sent.</ErrorNotice>;
    }
    render(<Host />);
    const ok = screen.getByRole('button', { name: 'OK' });
    await waitFor(() => expect(ok).toHaveFocus());
    const files = [new File(['png'], 'image.png', { type: 'image/png' })];
    dispatchPaste(ok, files);
    expect(onFiles).not.toHaveBeenCalled();
    fireEvent.click(ok);
    dispatchPaste(document.body, files);
    expect(onFiles).toHaveBeenCalledOnce();
  });

  it('attaches a paste that lands outside any text surface', () => {
    const onFiles = vi.fn();
    renderHook(() => useWindowFilePaste(onFiles));

    const event = dispatchPaste(document.body, [new File(['png'], 'image.png', { type: 'image/png' })]);

    expect(onFiles).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a text field and a dialog to handle their own paste', () => {
    const onFiles = vi.fn();
    renderHook(() => useWindowFilePaste(onFiles));
    const textarea = document.createElement('textarea');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inside = document.createElement('span');
    dialog.append(inside);
    document.body.append(textarea, dialog);

    const file = [new File(['png'], 'image.png', { type: 'image/png' })];
    dispatchPaste(textarea, file);
    dispatchPaste(inside, file);

    expect(onFiles).not.toHaveBeenCalled();
  });

  it('stops listening once the screen unmounts', () => {
    const onFiles = vi.fn();
    const { unmount } = renderHook(() => useWindowFilePaste(onFiles));

    unmount();
    dispatchPaste(document.body, [new File(['png'], 'image.png', { type: 'image/png' })]);

    expect(onFiles).not.toHaveBeenCalled();
  });
});
