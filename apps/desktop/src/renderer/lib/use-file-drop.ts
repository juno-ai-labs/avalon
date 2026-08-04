import { useMemo, useRef, useState } from 'react';

export function useFileDrop(onFiles: (files: FileList) => void) {
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  return useMemo(() => ({
    dragging,
    onDragEnter: (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      onFiles(event.dataTransfer.files);
    },
  }), [dragging, onFiles]);
}
