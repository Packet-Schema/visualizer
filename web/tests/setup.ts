// Vitest global setup.
//
// The client now lazy-fetches built-in preset bodies from `/presets/<key>.json`
// (see `lib/psdl/presets.ts`). jsdom has no server, so stub `fetch` to serve
// those bodies from the full server-side registry. Any other URL falls through
// to a 404 so an unmocked fetch fails loudly rather than hanging.

import { vi } from "vitest";
import { PRESETS } from "@/lib/psdl/presets.server";

vi.stubGlobal("fetch", async (input: unknown): Promise<Response> => {
  const url = String(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : ((input as { url?: string })?.url ?? input),
  );
  const match = url.match(/\/presets\/([^/]+)\.json(?:\?.*)?$/);
  if (match) {
    const key = decodeURIComponent(match[1]);
    const preset = PRESETS[key];
    if (!preset) {
      return new Response(`preset "${key}" not found`, { status: 404 });
    }
    return new Response(JSON.stringify(preset), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(`unmocked fetch: ${url}`, { status: 404 });
});
