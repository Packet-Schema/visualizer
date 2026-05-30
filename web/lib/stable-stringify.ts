/**
 * Key-order-independent JSON fingerprint.
 *
 * Uses JSON.stringify's replacer-array form: a single walk collects every
 * reachable property name, sorts them, then a second stringify pass emits
 * them in that stable order at every depth.
 *
 * The root invocation (key === "" on the very first replacer call) is skipped
 * so that a legitimate empty-string property key (e.g. switch.cases[""]) still
 * enters the set and is not silently deduplicated with the root sentinel.
 */
export function stableStringify(value: unknown): string {
  const keys = new Set<string>();
  let seenRoot = false;
  JSON.stringify(value, (key, val) => {
    if (!seenRoot) {
      seenRoot = true;
      return val;
    }
    keys.add(key);
    return val;
  });
  return JSON.stringify(value, Array.from(keys).sort());
}
