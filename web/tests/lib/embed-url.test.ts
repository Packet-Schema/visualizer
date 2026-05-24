import { describe, expect, it } from "vitest";

import {
  EMBED_MIN_HEIGHT,
  buildEmbedUrl,
  buildIframeEmbedHtml,
  estimateEmbedIframeHeight,
  parseEmbedThemeParam,
} from "@/lib/embed-url";
import { decodePsmlParam } from "@/lib/share-url";
import { PRESETS } from "@/lib/psml/presets";
import type { ResolvedLayout } from "@/lib/psml/renderer";

describe("embed URL params", () => {
  it("parses supported theme values", () => {
    expect(parseEmbedThemeParam("?theme=light")).toBe("light");
    expect(parseEmbedThemeParam("?theme=dark")).toBe("dark");
    expect(parseEmbedThemeParam("?theme=system")).toBe("system");
  });

  it("distinguishes missing and invalid theme values", () => {
    expect(parseEmbedThemeParam("?preset=ipv4")).toBeNull();
    expect(parseEmbedThemeParam("?theme=nope")).toBe("system");
  });

  it("builds an embed URL with encoded PSML and theme", () => {
    const url = new URL(
      buildEmbedUrl({
        baseUrl: "https://packet-view.example/app?preset=tcp",
        packet: PRESETS.ipv4,
        controllers: { "header.ihl": 6 },
      }),
    );

    expect(url.origin).toBe("https://packet-view.example");
    expect(url.pathname).toBe("/embed");
    expect(url.searchParams.get("theme")).toBe("system");

    const psml = url.searchParams.get("psml");
    expect(psml).toBeTruthy();
    const decoded = decodePsmlParam(psml!);
    expect(decoded.packet.name).toBe(PRESETS.ipv4.name);
    expect(decoded.controllers).toEqual({ "header.ihl": 6 });
  });

  it("builds escaped iframe HTML with the packet title", () => {
    const html = buildIframeEmbedHtml({
      baseUrl: "https://packet-view.example/",
      packet: {
        ...PRESETS.ipv4,
        name: 'IPv4 "Header" & <Options>',
      },
      controllers: {},
      theme: "dark",
      height: 320.2,
    });

    expect(html).toContain("<iframe");
    expect(html).toContain(
      'title="IPv4 &quot;Header&quot; &amp; &lt;Options&gt; packet diagram"',
    );
    expect(html).toContain("https://packet-view.example/embed?psml=");
    expect(html).toContain("&amp;theme=dark");
    expect(html).toContain('height="321"');
    expect(html).toContain('style="width:100%;border:0;"');
  });

  it("estimates iframe height from the resolved diagram rows", () => {
    expect(
      estimateEmbedIframeHeight({
        totalBits: 8,
        cells: [],
      }),
    ).toBe(EMBED_MIN_HEIGHT);

    expect(
      estimateEmbedIframeHeight({
        totalBits: 128,
        cells: [{ row: 4 }],
      } as unknown as ResolvedLayout),
    ).toBe(390);
  });
});
