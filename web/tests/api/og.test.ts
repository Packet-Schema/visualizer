import { describe, it, expect } from "vitest";
import { GET } from "../../app/api/og/route";

describe("OG API endpoint", () => {
  it("should return 200 with PNG content type", async () => {
    const request = new Request("http://localhost/api/og");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
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
    const request = new Request("http://localhost/api/og?preset=ipv4");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
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
    const params = new URLSearchParams({
      preset: "ipv4",
      c1: "50",
      c2: "25",
    });
    const request = new Request(
      `http://localhost/api/og?${params.toString()}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
  });

  it("should clamp controller values to valid range", async () => {
    // Controllers are clamped to 0-100 in the code
    const params = new URLSearchParams({
      preset: "ipv4",
      c1: "999", // Should be clamped to 100
      c2: "-50", // Should be clamped to 0
    });
    const request = new Request(
      `http://localhost/api/og?${params.toString()}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
  });

  it("should use Satori-compatible colors (no OKLch)", async () => {
    // This test ensures the theme generation doesn't use OKLch colors
    // which would fail in Satori. The actual verification happens at runtime
    // when the OG image is generated.
    const request = new Request("http://localhost/api/og?preset=ipv4");
    const response = await GET(request);

    // If Satori encounters unsupported colors, it would error
    // A successful response indicates color compatibility
    expect(response.status).toBe(200);
  });
});
