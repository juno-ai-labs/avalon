import type React from 'react';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFilePaste } from './use-file-paste';

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

  it('ignores every paste while the surface is disabled', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFilePaste(onFiles, true));
    const event = pasteEvent({ files: [new File(['png'], 'image.png', { type: 'image/png' })] });

    result.current(event);

    expect(onFiles).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
