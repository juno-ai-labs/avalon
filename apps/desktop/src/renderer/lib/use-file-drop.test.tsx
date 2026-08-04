import type React from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFileDrop } from './use-file-drop';

function dragEvent(input: { files?: File[]; types?: string[] } = {}): React.DragEvent<HTMLElement> {
  const files = input.files ?? [];
  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      files: files as unknown as FileList,
      types: input.types ?? (files.length > 0 ? ['Files'] : []),
      dropEffect: 'none',
    },
  } as unknown as React.DragEvent<HTMLElement>;
}

describe('useFileDrop', () => {
  it('keeps the drop state active while moving across nested children', () => {
    const { result } = renderHook(() => useFileDrop(vi.fn()));
    act(() => result.current.onDragEnter(dragEvent({ types: ['Files'] })));
    act(() => result.current.onDragEnter(dragEvent({ types: ['Files'] })));
    expect(result.current.dragging).toBe(true);

    act(() => result.current.onDragLeave(dragEvent({ types: ['Files'] })));
    expect(result.current.dragging).toBe(true);
    act(() => result.current.onDragLeave(dragEvent({ types: ['Files'] })));
    expect(result.current.dragging).toBe(false);
  });

  it('accepts file drops, clears the drop state, and ignores non-file drags', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFileDrop(onFiles));
    const file = new File(['hello'], 'hello.txt');

    const textDrag = dragEvent({ types: ['text/plain'] });
    act(() => result.current.onDragEnter(textDrag));
    expect(textDrag.preventDefault).not.toHaveBeenCalled();
    expect(result.current.dragging).toBe(false);

    act(() => result.current.onDragEnter(dragEvent({ types: ['Files'] })));
    const dropped = dragEvent({ files: [file] });
    act(() => result.current.onDrop(dropped));

    expect(dropped.preventDefault).toHaveBeenCalledOnce();
    expect(onFiles).toHaveBeenCalledWith(dropped.dataTransfer.files);
    expect(result.current.dragging).toBe(false);
  });
});
