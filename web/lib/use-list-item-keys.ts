import { useRef } from "react";

/**
 * Return a stable React `key` for each item in `items` based on object
 * identity. Two renders with the same item reference get the same key, so
 * reorder operations (swap two indices, splice one element) keep DOM nodes
 * in place instead of remounting them.
 *
 * Object-only by design: the implementation backs identity via a WeakMap,
 * which forbids primitive keys. Callers that hold primitives should wrap
 * them in a stable object first (e.g. `{ value: 42 }`) so the same
 * reference reaches every render. Passing a primitive array is a tsc
 * error — `T extends object` enforces this at the call site.
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
