// PacketViewer hooks — small, single-purpose effects extracted from the
// component so the file isn't a 1k-line wall of useEffect.
//
// Each hook owns one concern: viewport size, history-shortcut wiring, etc.
// They take callbacks rather than touching state directly, so PacketViewer
// keeps its single source of truth.

import { useEffect, useState } from "react";

/**
 * Returns `true` when `window.innerWidth >= breakpoint`. SSR-safe: defaults
 * to `false` so the server-rendered markup matches the initial client
 * render before the resize listener fires.
 */
export function useIsWideViewport(breakpoint: number): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setWide(window.innerWidth >= breakpoint);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [breakpoint]);
  return wide;
}

/**
 * Bind Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z / Ctrl+Y to undo and redo callbacks,
 * but only while `enabled` is true and the focus isn't inside an editable
 * control (so the browser's native text undo keeps working in inputs).
 */
export function useUndoRedoShortcuts({
  enabled,
  onUndo,
  onRedo,
}: {
  enabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
}): void {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
          return;
        }
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        onUndo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        onRedo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, onUndo, onRedo]);
}

/**
 * Fire `callback` once after `delayMs` whenever `shouldRun` is `true`.
 * Used by the onboarding tour auto-launch so the diagram is mounted before
 * the spotlight tries to land on it.
 */
export function useDelayedOnce(
  shouldRun: boolean,
  delayMs: number,
  callback: () => void,
): void {
  useEffect(() => {
    if (!shouldRun) return;
    const id = window.setTimeout(callback, delayMs);
    return () => window.clearTimeout(id);
    // Intentionally only depend on `shouldRun` — callback identity changes
    // on every render and we don't want to retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldRun]);
}

/**
 * Auto-clear a transient status message after `delayMs` whenever a new
 * status is set. Pass a `clear` callback that nulls out the parent state.
 */
export function useAutoClearStatus<T>(
  status: T | null,
  delayMs: number,
  clear: () => void,
): void {
  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(clear, delayMs);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, delayMs]);
}
