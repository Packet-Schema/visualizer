import { useRef } from "react";

/**
 * Return a stable React `key` for each item in `items` based on object
 * identity. Two renders with the same item reference get the same key, so
 * reorder operations (swap two indices, splice one element) keep DOM nodes
 * in place instead of remounting them.
 *
 * Falls back to `idx-${i}` for primitives — those have no identity, so we
 * cannot do better than index-based keying.
 */
export function useListItemKeys<T extends object>(
  items: readonly T[],
): string[] {
  const ids = useRef(new WeakMap<T, string>());
  const counter = useRef(0);
  return items.map((item) => {
    const existing = ids.current.get(item);
    if (existing) return existing;
    const fresh = `i${++counter.current}`;
    ids.current.set(item, fresh);
    return fresh;
  });
}
