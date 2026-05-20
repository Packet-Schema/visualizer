// PacketViewer hooks — small, single-purpose effects extracted from the
// component so the file isn't a 1k-line wall of useEffect.
//
// Each hook owns one concern: viewport size, history-shortcut wiring, etc.
// They take callbacks rather than touching state directly, so PacketViewer
// keeps its single source of truth.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import { highlightSelector } from "@/components/diagram/dom-query";
import { findRowNeighbor } from "./navigation";

/**
 * Wrap `callback` in a ref-backed thunk whose identity is stable for the
 * lifetime of the host component but always reads the *latest* callback
 * passed in. This is the “useEvent / useEventCallback” pattern that React's
 * RFC describes and is the cleanest way to avoid `eslint-disable
 * react-hooks/exhaustive-deps` in interval/timeout hooks.
 */
function useEventCallback<TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const ref = useRef(callback);
  // Synchronously refresh on every render so we never run a stale closure.
  ref.current = callback;
  return useCallback((...args: TArgs) => ref.current(...args), []);
}

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
  // Stabilise the handlers so the listener is bound once per `enabled`
  // transition rather than on every render.
  const onUndoStable = useEventCallback(onUndo);
  const onRedoStable = useEventCallback(onRedo);
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
        onUndoStable();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        onRedoStable();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, onUndoStable, onRedoStable]);
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
  const callbackStable = useEventCallback(callback);
  useEffect(() => {
    if (!shouldRun) return;
    const id = window.setTimeout(callbackStable, delayMs);
    return () => window.clearTimeout(id);
  }, [shouldRun, delayMs, callbackStable]);
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
  const clearStable = useEventCallback(clear);
  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(clearStable, delayMs);
    return () => window.clearTimeout(id);
  }, [status, delayMs, clearStable]);
}

/**
 * Imperative bridge for diagram ↔ hex strip hover highlighting.
 *
 * Returns a setter that paints `.hex-match` onto cells matching `fieldId`
 * and mirrors the id on the root via `data-highlighted-field`. The work
 * runs outside React's render cycle on purpose: hover events fire dozens
 * of times per second and we don't want each one to trigger a re-render
 * of the entire packet tree. The hook contains the side effect so the
 * call site stays declarative — "give me a highlighter for this DOM
 * subtree" instead of two dozen lines of DOM queries.
 */
/**
 * Roving-tabindex keyboard navigation across the hybrid diagram's flat list
 * of `.field-cell` / `.subfield-cell` elements. The single tab stop moves to
 * whichever cell the user lands on, so screen readers and keyboard users can
 * step through the diagram with arrow keys + Home/End instead of Tab-storming
 * every cell.
 */
export function useRovingTabindex(
  rootRef: RefObject<HTMLElement | null>,
): (e: ReactKeyboardEvent<HTMLDivElement>) => void {
  return useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const root = rootRef.current;
      if (!root) return;
      const target = e.target as Element | null;
      if (!target) return;

      const isFieldCell = target.classList.contains("field-cell");
      const isSubfieldCell = target.classList.contains("subfield-cell");
      if (!isFieldCell && !isSubfieldCell) return;

      const cells = Array.from(
        root.querySelectorAll<HTMLElement>(
          isSubfieldCell ? ".subfield-cell" : ".field-cell",
        ),
      );
      // Subfields navigate within their parent only.
      const group = isSubfieldCell
        ? cells.filter(
            (c) =>
              c.dataset.parentFieldId ===
              (target as HTMLElement).dataset.parentFieldId,
          )
        : cells;

      const idx = group.indexOf(target as HTMLElement);
      if (idx === -1) return;

      let next: HTMLElement | null = null;
      switch (e.key) {
        case "ArrowRight":
          next = group[Math.min(group.length - 1, idx + 1)] ?? null;
          break;
        case "ArrowLeft":
          next = group[Math.max(0, idx - 1)] ?? null;
          break;
        case "ArrowDown":
          next = isSubfieldCell
            ? null
            : findRowNeighbor(group, target as HTMLElement, +1);
          break;
        case "ArrowUp":
          next = isSubfieldCell
            ? null
            : findRowNeighbor(group, target as HTMLElement, -1);
          break;
        case "Home":
          next = group[0] ?? null;
          break;
        case "End":
          next = group[group.length - 1] ?? null;
          break;
        default:
          return;
      }

      if (next && next !== target) {
        e.preventDefault();
        // Move the single tabindex=0 to the focused element.
        for (const c of group) {
          c.setAttribute("tabindex", c === next ? "0" : "-1");
        }
        next.focus();
      }
    },
    [rootRef],
  );
}

export function useFieldHighlight(
  rootRef: RefObject<HTMLElement | null>,
): (fieldId: string | null) => void {
  return useCallback(
    (fieldId: string | null) => {
      const root = rootRef.current;
      if (!root) return;
      // Always clear the previous highlight first so rapid hover transitions
      // don't leave stale classes behind.
      for (const el of root.querySelectorAll<HTMLElement>(".hex-match")) {
        el.classList.remove("hex-match");
      }
      if (!fieldId) {
        root.removeAttribute("data-highlighted-field");
        return;
      }
      root.setAttribute("data-highlighted-field", fieldId);
      // Subfield ids look like "parent:sub". The selector lights up both the
      // subfield itself and the parent field cell so the relationship is
      // unambiguous (see `dom-query.highlightSelector`).
      const matches = root.querySelectorAll<HTMLElement>(
        highlightSelector(fieldId),
      );
      for (const el of matches) el.classList.add("hex-match");
    },
    [rootRef],
  );
}
