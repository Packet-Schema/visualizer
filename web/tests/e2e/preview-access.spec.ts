import { test, expect } from "@playwright/test";

test.describe("Preview Server Access", () => {
  test("should load homepage without preset", async ({ page }) => {
    await page.goto("/");

    // Check page title (app auto-applies ipv4 preset when accessing /)
    const title = await page.title();
    expect(title).toContain("IPv4");
    expect(title).toContain("Packet Visualizer");

    // Check for main content
    await expect(page.locator("body")).toContainText("Packet Visualizer");

    // Check that page loaded (URL may be rewritten with auto-applied preset)
    expect(page.url()).toContain("localhost:8787");
  });

  test("should load homepage with preset parameter", async ({ page }) => {
    await page.goto("/?preset=ipv4");

    // Check page title contains IPv4
    const title = await page.title();
    expect(title).toContain("IPv4");
    expect(title).toContain("Packet Visualizer");

    // Check that page loaded successfully
    expect(page.url()).toContain("preset=ipv4");
  });

  test("should display OG meta tags for default page", async ({ page }) => {
    await page.goto("/");

    // App auto-applies ipv4 preset when accessing /
    // Check for og:title meta tag (should contain IPv4 from auto-apply)
    const ogTitle = page.locator('meta[property="og:title"]');
    const ogTitleContent = await ogTitle.getAttribute("content");
    expect(ogTitleContent).toContain("IPv4");
    expect(ogTitleContent).toContain("Packet Visualizer");

    // Check for og:description meta tag
    const ogDescription = page.locator('meta[property="og:description"]');
    const descriptionContent = await ogDescription.getAttribute("content");
    expect(descriptionContent).toBeTruthy();
    expect(descriptionContent).toContain("network");

    // Check for og:image meta tag (should have preset=ipv4 from auto-apply)
    const ogImage = page.locator('meta[property="og:image"]');
    const imageUrl = await ogImage.getAttribute("content");
    expect(imageUrl).toMatch(/^http:\/\/localhost:8787\/api\/og/);
    expect(imageUrl).toContain("preset=ipv4");
  });

  test("should display OG meta tags with preset", async ({ page }) => {
    await page.goto("/?preset=ipv4");

    // Check for og:title meta tag with preset info
    const ogTitle = page.locator('meta[property="og:title"]');
    const titleContent = await ogTitle.getAttribute("content");
    expect(titleContent).toContain("IPv4");
    expect(titleContent).toContain("Packet Visualizer");

    // Check for og:image meta tag with preset parameter
    const ogImage = page.locator('meta[property="og:image"]');
    const imageUrl = await ogImage.getAttribute("content");
    expect(imageUrl).toContain("preset=ipv4");
  });

  test("should load homepage with custom controllers", async ({ page }) => {
    await page.goto("/?preset=ipv4&controllers.ihl=6&controllers.dscp=20");

    // Check page loaded
    const title = await page.title();
    expect(title).toContain("IPv4");

    // Check URL parameters are preserved
    expect(page.url()).toContain("preset=ipv4");
    expect(page.url()).toContain("controllers.ihl=6");
    expect(page.url()).toContain("controllers.dscp=20");

    // Check og:image contains parameters
    const ogImage = page.locator('meta[property="og:image"]');
    const imageUrl = await ogImage.getAttribute("content");
    expect(imageUrl).toContain("preset=ipv4");
    expect(imageUrl).toContain("controllers.ihl=6");
  });

  test("should handle different presets", async ({ page }) => {
    const presets = ["ipv4", "ipv6", "udp"];

    for (const preset of presets) {
      await page.goto(`/?preset=${preset}`);

      // Check page loaded
      const title = await page.title();
      expect(title).toBeTruthy();
      expect(title).toContain("Packet Visualizer");

      // Check that URL has the preset
      expect(page.url()).toContain(`preset=${preset}`);

      // Check og:image has preset
      const ogImage = page.locator('meta[property="og:image"]');
      const imageUrl = await ogImage.getAttribute("content");
      expect(imageUrl).toContain(`preset=${preset}`);
    }
  });

  test("should have valid HTML structure", async ({ page }) => {
    await page.goto("/");

    // Check for HTML lang attribute
    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", "en");

    // Check for viewport meta tag
    const viewport = page.locator('meta[name="viewport"]');
    await expect(viewport).toHaveAttribute("content", /width=device-width/);

    // Check for charset meta tag
    const charset = page.locator("meta[charset]");
    expect(await charset.count()).toBeGreaterThan(0);
  });

  test("should not have console errors on default page load", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    await page.goto("/");

    // Wait a bit for any errors to appear
    await page.waitForTimeout(1000);

    // No critical errors should be present
    expect(errors.filter((e) => !e.includes("Not implemented"))).toHaveLength(
      0,
    );
  });

  test("should not have console errors with preset", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    await page.goto("/?preset=ipv4");

    // Wait a bit for any errors to appear
    await page.waitForTimeout(1000);

    // No critical errors should be present
    expect(errors.filter((e) => !e.includes("Not implemented"))).toHaveLength(
      0,
    );
  });
});
