import { test, expect } from "@playwright/test";
import sharp from "sharp";

test.describe("OG Image Download", () => {
  test("downloads OG image with HTTP protocol", async ({ request }) => {
    const response = await request.get("/api/og");

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    expect(response.headers()["cache-control"]).toContain("max-age");

    const buffer = await response.body();
    expect(buffer.length).toBeGreaterThan(0);

    const metadata = await sharp(buffer).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  test("downloads OG image with preset parameter", async ({ request }) => {
    const response = await request.get("/api/og?preset=ipv4");

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");

    const buffer = await response.body();
    const metadata = await sharp(buffer).metadata();

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  test("downloads OG image with custom controllers", async ({ request }) => {
    const response = await request.get(
      "/api/og?preset=ipv4&controllers.ihl=6&controllers.dscp=10",
    );

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");

    const buffer = await response.body();
    const metadata = await sharp(buffer).metadata();

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  test("returns fallback image for invalid preset", async ({ request }) => {
    const response = await request.get("/api/og?preset=nonexistent");

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");

    const buffer = await response.body();
    const metadata = await sharp(buffer).metadata();

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  test("includes proper cache headers", async ({ request }) => {
    const response = await request.get("/api/og?preset=ipv4");

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    expect(response.headers()["cache-control"]).toBe(
      "public, no-transform, max-age=86400",
    );
    expect(response.headers()["x-robots-tag"]).toBe("noindex");
  });

  test("handles multiple query parameters", async ({ request }) => {
    const response = await request.get(
      "/api/og?preset=ipv4&controllers.ihl=5&controllers.dscp=20&controllers.ecn=3",
    );

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");

    const buffer = await response.body();
    const metadata = await sharp(buffer).metadata();

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  test("verifies PNG is valid and readable by sharp", async ({ request }) => {
    const response = await request.get("/api/og");
    const buffer = await response.body();

    const image = sharp(buffer);
    const stats = await image.stats();

    expect(stats.channels.length).toBeGreaterThanOrEqual(3);
    expect(typeof stats.isOpaque).toBe("boolean");
  });

  test("returns consistent image dimensions across multiple requests", async ({
    request,
  }) => {
    const dimensions = [];

    for (let i = 0; i < 3; i++) {
      const response = await request.get("/api/og?preset=ipv4");
      const buffer = await response.body();
      const metadata = await sharp(buffer).metadata();
      dimensions.push({ width: metadata.width, height: metadata.height });
    }

    dimensions.forEach((dim) => {
      expect(dim.width).toBe(1200);
      expect(dim.height).toBe(630);
    });
  });
});
