import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ChildProcess } from "node:child_process";
import { JSDOM } from "jsdom";
import {
  BASE_URL,
  fetchWithRetry,
  waitForServer,
  startPreviewServer,
} from "./helpers";

describe("Homepage and Meta Tags", () => {
  let devServer: ChildProcess;

  beforeAll(async () => {
    devServer = startPreviewServer();
    await waitForServer(BASE_URL, 90000);
  }, 120000);

  afterAll(async () => {
    if (devServer) {
      devServer.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    // Force cleanup of port 8787
    const { spawnSync } = await import("node:child_process");
    spawnSync(
      "bash",
      ["-c", "lsof -ti:8787 | xargs kill -9 2>/dev/null || true"],
      {
        stdio: "ignore",
      },
    );
  });

  describe("Homepage access", () => {
    it("returns 200 status when accessing homepage", async () => {
      const response = await fetchWithRetry(`${BASE_URL}/`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
    });

    it("returns 200 status when accessing homepage with preset parameter", async () => {
      const response = await fetchWithRetry(`${BASE_URL}/?preset=ipv4`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
    });

    it("returns valid HTML with proper structure", async () => {
      const response = await fetchWithRetry(`${BASE_URL}/`);
      const html = await response.text();

      expect(html).toContain("<html");
      expect(html).toContain("<head");
      expect(html).toContain("<body");
      expect(html).toContain("</html>");
    });
  });

  describe("Meta tags - without preset", () => {
    it("includes title tag when accessing without preset", async () => {
      const response = await fetchWithRetry(`${BASE_URL}/`);
      const html = await response.text();
      const dom = new JSDOM(html);
      const titleTag = dom.window.document.querySelector("title");

      expect(titleTag).toBeDefined();
      expect(titleTag?.textContent).toBeTruthy();
      expect(titleTag?.textContent).not.toContain("preset");
    });

    it("includes OGP meta tags when accessing without preset", async () => {
      const response = await fetchWithRetry(`${BASE_URL}/`);
      const html = await response.text();
      const dom = new JSDOM(html);

      // Check for og:title
      const ogTitle = dom.window.document.querySelector(
        'meta[property="og:title"]',
      );
      expect(ogTitle).toBeDefined();
      expect(ogTitle?.getAttribute("content")).toBeTruthy();

      // Check for og:description
      const ogDescription = dom.window.document.querySelector(
        'meta[property="og:description"]',
      );
      expect(ogDescription).toBeDefined();

      // Check for og:image
      const ogImage = dom.window.document.querySelector(
        'meta[property="og:image"]',
      );
      expect(ogImage).toBeDefined();
      expect(ogImage?.getAttribute("content")).toMatch(/^https?:\/\//);
    });

    it("does not include og:url meta tag when accessing without preset", async () => {
      const response = await fetchWithRetry(`${BASE_URL}/`);
      const html = await response.text();
      const dom = new JSDOM(html);

      const ogUrl = dom.window.document.querySelector(
        'meta[property="og:url"]',
      );
      expect(ogUrl).toBeNull();
    });
  });

  describe("Meta tags - with preset", () => {
    it("includes title tag with preset info when accessing with preset", async () => {
      const response = await fetchWithRetry(`${BASE_URL}/?preset=ipv4`);
      const html = await response.text();
      const dom = new JSDOM(html);
      const titleTag = dom.window.document.querySelector("title");

      expect(titleTag).toBeDefined();
      expect(titleTag?.textContent).toBeTruthy();
      expect(titleTag?.textContent).toContain("IPv4"); // IPv4 header name
      expect(titleTag?.textContent).toContain("Packet Visualizer");
    });

    it("includes OGP meta tags with preset info when accessing with preset", async () => {
      const response = await fetchWithRetry(
        `${BASE_URL}/?preset=ipv4&controllers.ihl=6`,
      );
      const html = await response.text();
      const dom = new JSDOM(html);

      // Check for og:title with preset info
      const ogTitle = dom.window.document.querySelector(
        'meta[property="og:title"]',
      );
      expect(ogTitle).toBeDefined();
      const ogTitleContent = ogTitle?.getAttribute("content") || "";
      expect(ogTitleContent).toContain("IPv4"); // IPv4 header name
      expect(ogTitleContent).toContain("Packet Visualizer");

      // Check for og:image (should include preset in URL)
      const ogImage = dom.window.document.querySelector(
        'meta[property="og:image"]',
      );
      expect(ogImage).toBeDefined();
      const ogImageUrl = ogImage?.getAttribute("content") || "";
      expect(ogImageUrl).toContain("preset=ipv4");
    });

    it("includes og:image with preset parameters in URL", async () => {
      const response = await fetchWithRetry(`${BASE_URL}/?preset=ipv6`);
      const html = await response.text();
      const dom = new JSDOM(html);

      const ogImage = dom.window.document.querySelector(
        'meta[property="og:image"]',
      );
      expect(ogImage).toBeDefined();
      const imageUrl = ogImage?.getAttribute("content") || "";
      expect(imageUrl).toContain("preset=ipv6");
    });
  });

  describe("Meta tags - with controllers", () => {
    it("includes OGP meta tags when accessing with multiple controller parameters", async () => {
      const response = await fetchWithRetry(
        `${BASE_URL}/?preset=ipv4&controllers.ihl=5&controllers.dscp=20&controllers.ecn=3`,
      );
      const html = await response.text();
      const dom = new JSDOM(html);

      const ogTitle = dom.window.document.querySelector(
        'meta[property="og:title"]',
      );
      expect(ogTitle).toBeDefined();

      const ogImage = dom.window.document.querySelector(
        'meta[property="og:image"]',
      );
      expect(ogImage).toBeDefined();
      const ogImageUrl = ogImage?.getAttribute("content") || "";
      expect(ogImageUrl).toContain("preset=ipv4");
      expect(ogImageUrl).toContain("controllers.ihl=5");
    });
  });
});
