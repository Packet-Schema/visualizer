import { useCallback, useState, type DragEvent } from "react";

export type DropzoneHandlers = {
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
};

/**
 * File drag-and-drop handlers + a `dragActive` flag the caller can use to
 * style the drop target. `enabled = false` returns no-op handlers so the
 * same DOM tree can opt out of file ingestion (e.g. the Export pane).
 */
export function useDropzone({
  enabled,
  onFile,
}: {
  enabled: boolean;
  onFile: (file: File) => void;
}): { dragActive: boolean; handlers: DropzoneHandlers | undefined } {
  const [dragActive, setDragActive] = useState(false);
  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }, []);
  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);
  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  return {
    dragActive,
    handlers: enabled ? { onDragOver, onDragLeave, onDrop } : undefined,
  };
}
