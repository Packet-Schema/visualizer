import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../../app/api/og/route";
import { PRESETS } from "../../lib/psdl/presets";

describe("OG API endpoint", () => {
  async function testOGImageGeneration(url: string) {
    const request = new NextRequest(`http://localhost${url}`);
    const response = await GET(request);

    // Must return 200 (not 500 from Satori errors)
    if (response.status === 500) {
      const text = await response.clone().text();
      throw new Error(
        `OG generation failed with 500: ${text.substring(0, 200)}`,
      );
    }

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    // Verify actual PNG data was generated
    const buffer = await response.arrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(0);

    // PNG magic bytes: 89 50 4E 47
    const view = new Uint8Array(buffer);
    expect(view[0]).toBe(0x89);
    expect(view[1]).toBe(0x50);
    expect(view[2]).toBe(0x4e);
    expect(view[3]).toBe(0x47);
  }

  it("should return 200 with PNG content type", async () => {
    await testOGImageGeneration("/api/og");
  });

  it("should have correct cache control headers", async () => {
    const request = new NextRequest("http://localhost/api/og");
    const response = await GET(request);

    expect(response.headers.get("cache-control")).toBe(
      "public, no-transform, max-age=86400",
    );
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("should render with preset parameter", async () => {
    await testOGImageGeneration("/api/og?preset=ipv4");
  });

  it("should render fallback image for oversized packets", async () => {
    const oversizedParams = new URLSearchParams({
      packet: "A".repeat(10000), // Oversized PSDL
    });
    const request = new NextRequest(
      `http://localhost/api/og?${oversizedParams.toString()}`,
    );
    const response = await GET(request);

    // Should still return 200 with PNG (fallback image)
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("should render fallback image on error", async () => {
    const invalidParams = new URLSearchParams({
      preset: "nonexistent",
    });
    const request = new NextRequest(
      `http://localhost/api/og?${invalidParams.toString()}`,
    );
    const response = await GET(request);

    // Should still return 200 with PNG (fallback image)
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("should support controller parameters", async () => {
    await testOGImageGeneration("/api/og?preset=ipv4&c1=50&c2=25");
  });

  it("should clamp controller values to valid range", async () => {
    // Controllers are clamped to 0-100 in the code
    await testOGImageGeneration("/api/og?preset=ipv4&c1=999&c2=-50");
  });

  it("should use Satori-compatible colors and CSS", async () => {
    // This test ensures:
    // - Theme uses rgb() format (not OKLch)
    // - StaticDiagram uses Satori-compatible CSS (flex, not grid)
    // If Satori encounters unsupported colors or CSS, it returns 500
    await testOGImageGeneration("/api/og?preset=ipv4");
  });

  describe("each parameter set produces a unique OG image", () => {
    // Regression guard: verifies that different presets and controller values
    // each produce a distinct PNG output from the default (/) OG image.
    // If rendering silently degrades (e.g. encrypted stripes disappear, layout
    // collapses), the affected image will become pixel-identical to the default
    // and this test will catch it.

    let defaultBuf: ArrayBuffer;

    beforeAll(async () => {
      const res = await GET(new NextRequest("http://localhost/api/og"));
      defaultBuf = await res.arrayBuffer();
    });

    const presetKeys = Object.keys(PRESETS).filter((k) => k !== "ipv4");

    it.each(presetKeys)(
      "preset=%s differs from default",
      async (presetKey) => {
        const res = await GET(
          new NextRequest(`http://localhost/api/og?preset=${presetKey}`),
        );
        expect(res.status).toBe(200);
        const buf = await res.arrayBuffer();
        expect(Buffer.from(buf).equals(Buffer.from(defaultBuf))).toBe(false);
      },
    );

    const controllerCases: Array<[string, string]> = [
      ["ipv4 with c1=50", "preset=ipv4&c1=50"],
      ["ipv4 with c1=100", "preset=ipv4&c1=100"],
      ["tcp with c1=1", "preset=tcp&c1=1"],
    ];

    it.each(controllerCases)(
      "%s differs from default",
      async (_label, query) => {
        const res = await GET(
          new NextRequest(`http://localhost/api/og?${query}`),
        );
        expect(res.status).toBe(200);
        const buf = await res.arrayBuffer();
        expect(Buffer.from(buf).equals(Buffer.from(defaultBuf))).toBe(false);
      },
    );
  });
});
