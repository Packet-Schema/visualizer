import { useRef } from "react";

/**
 * Return a stable React `key` for each item in `items` so the underlying
 * DOM nodes survive both immutable edits *and* reorder/remove operations.
 *
 * Three matching strategies are tried per render, in order:
 *
 *  1. **Identity match**: the same object reference appears in the
 *     previous render → reuse its key. Covers reorder (swap two indices).
 *  2. **Position match**: an item at the same index in the previous
 *     render exists → reuse that key. Covers immutable edits — the
 *     common pattern `list[i] = { ...list[i], extras: ... }` swaps the
 *     reference but the caller still means "same row".
 *  3. **Fresh key**: anything else (length growth, all-new array) gets a
 *     newly minted key.
 *
 * Without (2), every spread-replace would mint a new key and React would
 * remount the row mid-edit, dropping the focused input — that's the
 * Copilot regression this rewrite fixes. The shape of the hook (read
 * refs at the top, write back before return) is the React "render-time
 * ref comparison" pattern; we don't dispatch any side effects, so the
 * write is safe during render.
 */
export function useListItemKeys<T extends object>(
  items: readonly T[],
): string[] {
  const lastItemsRef = useRef<readonly T[]>([]);
  const lastKeysRef = useRef<string[]>([]);
  const counterRef = useRef(0);

  const prevItems = lastItemsRef.current;
  const prevKeys = lastKeysRef.current;

  const newKeys: string[] = items.map((item, i) => {
    const prevIdx = prevItems.indexOf(item);
    if (prevIdx !== -1) return prevKeys[prevIdx];
    if (i < prevKeys.length) return prevKeys[i];
    return `i${++counterRef.current}`;
  });

  lastItemsRef.current = items;
  lastKeysRef.current = newKeys;
  return newKeys;
}
