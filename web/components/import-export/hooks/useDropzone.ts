import { useCallback, useState, type DragEvent } from "react";

export type DropzoneHandlers = {
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
};

/**
 * File drag-and-drop handlers + a `dragActive` flag the caller can use to
 * style the drop target. When `enabled = false` the hook returns
 * `handlers: undefined` so the caller can spread it conditionally
 * (`{...dropzone.handlers}`) and have the drop target opt out of file
 * ingestion entirely — useful for the Export pane, which shares the
 * same DOM tree but should not accept drops. (Earlier wording promised
 * "no-op handlers"; the implementation has always omitted them, and a
 * missing-spread form is cheaper than re-binding three no-op functions.)
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
    // Ignore "leaves" that just transition into a child element of the
    // dropzone (typically the textarea inside the wrapper). Without
    // this guard, dragging over any nested element flips `dragActive`
    // off and the drop-target styling flickers — Copilot flagged this
    // as a UX regression. `relatedTarget` is the element the pointer
    // is *entering*; if it's still inside `currentTarget`, the user
    // hasn't actually left the dropzone.
    if (
      e.relatedTarget instanceof Node &&
      e.currentTarget.contains(e.relatedTarget)
    ) {
      return;
    }
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
