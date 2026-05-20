import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function getFocusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => !el.hasAttribute("data-skip-focus"));
}

/**
 * Trap keyboard focus inside `containerRef` while `open` is true, escape
 * closes via `onClose`, and the previously focused element is restored
 * once the drawer is dismissed.
 *
 * Pulled out of `ImportExportDrawer` so the drawer component shrinks to a
 * presentational surface and the same trap can be reused if another modal
 * surface appears.
 */
export function useDrawerFocusTrap({
  open,
  containerRef,
  onClose,
}: {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}): void {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Keep the latest `onClose` in a ref so the effect below doesn't depend
  // on it. An inline `onClose={() => ...}` from the caller (common in
  // React) would otherwise mint a new function identity each render,
  // re-firing the effect every time and clobbering `returnFocusRef` +
  // re-focusing the first focusable on every parent re-render. That
  // also broke focus restoration on close because the saved trigger
  // got overwritten with the in-trap element (Copilot review).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Move focus into the trap.
    const focusables = getFocusables(containerRef.current);
    if (focusables.length > 0) focusables[0].focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && containerRef.current) {
        const list = getFocusables(containerRef.current);
        if (list.length === 0) {
          e.preventDefault();
          return;
        }
        const first = list[0];
        const last = list[list.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !containerRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !containerRef.current.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
    };
    // `onClose` is captured via `onCloseRef`; including it here would
    // re-run the effect on every parent render with an inline handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, containerRef]);

  // Restore focus once we close.
  useEffect(() => {
    if (open) return;
    const el = returnFocusRef.current;
    if (el && document.contains(el)) {
      try {
        el.focus();
      } catch {
        /* ignore */
      }
    }
    returnFocusRef.current = null;
  }, [open]);
}
