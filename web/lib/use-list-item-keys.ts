import { useRef } from "react";

/**
 * Return a stable React `key` for each item in `items` so the underlying
 * DOM nodes survive both immutable edits *and* reorder/remove operations.
 *
 * Two-pass matching:
 *
 *  1. **Identity pass** — items that exist (by reference) in the previous
 *     render reclaim their previous key. Handles reorder / swap / no-op.
 *  2. **Fallback pass** — for each remaining slot, pull from the pool of
 *     previous keys that pass 1 didn't claim, in their original order.
 *     Handles the common immutable-edit pattern `list[i] = { ...list[i],
 *     extras: ... }` (spread-replace at one index). Any slot still left
 *     unfilled after the pool drains gets a freshly minted key.
 *
 * The single-pass version this replaced had a key-collision bug: with
 * `prev = [A, B]` and `items = [C, A, B]` (prepend), index 0 fell into
 * the position fallback and grabbed prev key 0, but the identity match
 * for A *also* picked prev key 0 — two slots ended up with the same
 * React key. The two-pass split (identity first, draw remainder from a
 * pool of leftover keys) makes that collision impossible.
 *
 * Read refs at the top, write back before return — same render-time
 * pattern PacketViewer uses elsewhere. No effects, no side effects.
 */
export function useListItemKeys<T extends object>(
  items: readonly T[],
): string[] {
  const lastItemsRef = useRef<readonly T[]>([]);
  const lastKeysRef = useRef<string[]>([]);
  const counterRef = useRef(0);

  const prevItems = lastItemsRef.current;
  const prevKeys = lastKeysRef.current;

  // Build an item → queue-of-prev-indices map up front. We use a Map of
  // FIFO queues (not `indexOf`) so that:
  //   - Pass 1 is O(n) instead of O(n²).
  //   - When the same object reference legitimately appears twice in
  //     `items` (rare today since the reducers clone, but the type
  //     contract allows it), each occurrence consumes a distinct prev
  //     entry instead of both reading prev index 0 — that's what would
  //     otherwise hand two slots the same React key and corrupt state.
  const prevIndexPool = new Map<T, number[]>();
  for (let i = 0; i < prevItems.length; i++) {
    const queue = prevIndexPool.get(prevItems[i]);
    if (queue) queue.push(i);
    else prevIndexPool.set(prevItems[i], [i]);
  }

  // Pass 1: identity-based reuse (reorder / no-op). `null` marks slots
  // still to be filled.
  const newKeys: (string | null)[] = items.map((item) => {
    const queue = prevIndexPool.get(item);
    if (!queue || queue.length === 0) return null;
    const idx = queue.shift()!;
    return prevKeys[idx];
  });

  // Pool of previous keys not yet claimed by Pass 1, in original order.
  // Pass 2 draws from this pool so that spread-replaced rows reuse a key
  // (no remount → no focus drop) without ever stealing a key that
  // Pass 1 already assigned to another slot.
  const claimed = new Set(newKeys.filter((k): k is string => k !== null));
  const pool = prevKeys.filter((k) => !claimed.has(k));
  let poolIdx = 0;

  for (let i = 0; i < newKeys.length; i++) {
    if (newKeys[i] !== null) continue;
    newKeys[i] =
      poolIdx < pool.length ? pool[poolIdx++] : `i${++counterRef.current}`;
  }

  const resolved = newKeys as string[];
  lastItemsRef.current = items;
  lastKeysRef.current = resolved;
  return resolved;
}
