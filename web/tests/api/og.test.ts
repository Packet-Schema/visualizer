import { describe, it, expect } from "vitest";
import { GET } from "../../app/api/og/route";

describe("OG API endpoint", () => {
  async function testOGImageGeneration(url: string) {
    const request = new Request(`http://localhost${url}`);
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
    const request = new Request("http://localhost/api/og");
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
      packet: "A".repeat(10000), // Oversized PSML
    });
    const request = new Request(
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
    const request = new Request(
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
});
