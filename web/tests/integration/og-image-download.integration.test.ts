import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import sharp from "sharp";

const PORT = 8787;
const BASE_URL = `http://localhost:${PORT}`;

describe("OG Image Download Integration Tests", () => {
  let devServer: ChildProcess;

  beforeAll(async () => {
    // Kill any existing process on port 8787
    console.log("Cleaning up port 8787...");
    spawnSync("bash", ["-c", "lsof -ti:8787 | xargs kill -9 2>/dev/null || true"], {
      stdio: "ignore",
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Start the Cloudflare worker preview server
    // Note: The build should already be completed before running integration tests
    console.log("Starting Cloudflare worker preview server...");
    devServer = spawn("npm", ["run", "preview:worker:start"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });

    // Log server output for debugging
    devServer.stdout?.on("data", (data) => {
      const lines = data.toString().split("\n");
      lines.forEach((line) => {
        if (line.trim()) {
          console.log(`[Server stdout] ${line.trim()}`);
        }
      });
    });
    devServer.stderr?.on("data", (data) => {
      const lines = data.toString().split("\n");
      lines.forEach((line) => {
        if (line.trim()) {
          console.log(`[Server stderr] ${line.trim()}`);
        }
      });
    });

    // Log when server exits unexpectedly
    devServer.on("error", (err) => {
      console.error("[Server error]", err);
    });
    devServer.on("exit", (code) => {
      console.log(`[Server exited with code ${code}]`);
    });

    // Wait for the server to be ready
    await waitForServer(BASE_URL, 90000);
  }, 120000);

  afterAll(async () => {
    if (devServer) {
      devServer.kill();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  });

  describe("OG image requests", () => {
    const fetchWithRetry = async (
      url: string,
      maxRetries: number = 3,
    ): Promise<Response> => {
      for (let i = 0; i < maxRetries; i++) {
        try {
          const response = await fetch(url, { timeout: 10000 });
          return response;
        } catch (err) {
          if (i === maxRetries - 1) throw err;
          await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
        }
      }
      throw new Error("Unreachable");
    };

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
});

async function waitForServer(
  url: string,
  timeoutMs: number = 60000,
): Promise<void> {
  const startTime = Date.now();
  const interval = 1000;
  let attempts = 0;

  while (Date.now() - startTime < timeoutMs) {
    attempts++;
    try {
      const response = await fetch(url, { timeout: 5000 });
      if (response.status === 404 || response.status === 200) {
        console.log(
          `Server ready after ${Date.now() - startTime}ms (${attempts} attempts)`,
        );
        return;
      }
    } catch (err) {
      // Server not ready yet
      if (attempts % 5 === 0) {
        console.log(
          `Waiting for server... (${Math.round((Date.now() - startTime) / 1000)}s)`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `Server did not start within ${timeoutMs}ms at ${url} after ${attempts} attempts`,
  );
}
