import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import {
  BASE_URL,
  fetchWithRetry,
  waitForServer,
  startPreviewServer,
} from "./helpers";

describe("OG Image Download", () => {
  let devServer: ChildProcess;

  beforeAll(async () => {
    devServer = startPreviewServer();
    await waitForServer(BASE_URL, 90000);
  }, 120000);

  afterAll(async () => {
    if (devServer) {
      devServer.kill();
    }
  });

  it("downloads OG image with HTTP protocol", async () => {
    const url = `${BASE_URL}/api/og`;
    const response = await fetchWithRetry(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("max-age");

    const buffer = await response.arrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(0);

    // Verify PNG format and dimensions
    const metadata = await sharp(Buffer.from(buffer)).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  it("downloads OG image with preset parameter", async () => {
    const url = `${BASE_URL}/api/og?preset=ipv4`;
    const response = await fetchWithRetry(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    const buffer = await response.arrayBuffer();
    const metadata = await sharp(Buffer.from(buffer)).metadata();

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  it("downloads OG image with custom controllers", async () => {
    const url = `${BASE_URL}/api/og?preset=ipv4&controllers.ihl=6&controllers.dscp=10`;
    const response = await fetchWithRetry(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    const buffer = await response.arrayBuffer();
    const metadata = await sharp(Buffer.from(buffer)).metadata();

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  it("returns fallback image for invalid preset", async () => {
    const url = `${BASE_URL}/api/og?preset=nonexistent`;
    const response = await fetchWithRetry(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    const buffer = await response.arrayBuffer();
    const metadata = await sharp(Buffer.from(buffer)).metadata();

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  it("includes proper cache headers", async () => {
    const url = `${BASE_URL}/api/og?preset=ipv4`;
    const response = await fetchWithRetry(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, no-transform, max-age=86400",
    );
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("handles multiple query parameters", async () => {
    const url = `${BASE_URL}/api/og?preset=ipv4&controllers.ihl=5&controllers.dscp=20&controllers.ecn=3`;
    const response = await fetchWithRetry(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    const buffer = await response.arrayBuffer();
    const metadata = await sharp(Buffer.from(buffer)).metadata();

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  it("verifies PNG is valid and readable by sharp", async () => {
    const url = `${BASE_URL}/api/og`;
    const response = await fetchWithRetry(url);

    const buffer = await response.arrayBuffer();

    // Try to get detailed image info to ensure PNG is fully valid
    const image = sharp(Buffer.from(buffer));
    const stats = await image.stats();

    expect(stats).toBeDefined();
    expect(stats.channels.length).toBeGreaterThanOrEqual(3); // RGB or RGBA channels
    expect(stats.isOpaque).toBeDefined();
  });

  it("returns consistent image dimensions across multiple requests", async () => {
    const url = `${BASE_URL}/api/og?preset=ipv4`;
    const dimensions = [];

    for (let i = 0; i < 3; i++) {
      const response = await fetchWithRetry(url);
      const buffer = await response.arrayBuffer();
      const metadata = await sharp(Buffer.from(buffer)).metadata();
      dimensions.push({ width: metadata.width, height: metadata.height });
    }

    // All requests should return the same dimensions
    dimensions.forEach((dim) => {
      expect(dim.width).toBe(1200);
      expect(dim.height).toBe(630);
    });
  });
});
