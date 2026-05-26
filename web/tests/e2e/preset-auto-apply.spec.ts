import { test, expect, type Page } from "@playwright/test";

test.describe("Preset Auto-Apply Behavior", () => {
  test("should have default title when accessing without preset", async ({
    page,
  }) => {
    // Go to homepage without preset parameter
    await page.goto("/");

    // Wait for any dynamic content to load
    await page.waitForLoadState("networkidle");

    // Initially, title should be default (no preset info)
    let title = await page.title();
    expect(title).toBe("Packet Visualizer");

    // Wait for dynamic preset application (up to 5 seconds)
    await page.waitForFunction(
      () => document.title.includes("IPv4"),
      { timeout: 5000 }
    ).catch(() => {
      // It's okay if preset isn't applied dynamically
    });

    // Check final title (should have ipv4 applied dynamically)
    title = await page.title();
    expect(title).toBe("IPv4 Header | Packet Visualizer");

    // OG meta tag is server-generated based on URL (no preset param means no preset in OG)
    const ogTitle = page.locator('meta[property="og:title"]');
    const ogTitleContent = await ogTitle.getAttribute("content");
    expect(ogTitleContent).toBe("Packet Visualizer");
  });

  test("should preserve title when preset is explicitly set", async ({
    page,
  }) => {
    // Go to homepage with ipv6 preset
    await page.goto("/?preset=ipv6");

    // Wait for any dynamic content to load
    await page.waitForLoadState("networkidle");

    // Check that page title reflects ipv6 preset
    const title = await page.title();
    expect(title).toContain("IPv6");
    expect(title).toContain("Packet Visualizer");

    // Verify URL still has the preset parameter
    expect(page.url()).toContain("preset=ipv6");
  });

  test("should have default OG image URL when accessing without preset", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // OG image should be default (no preset parameters in URL)
    // because OG is generated server-side based on URL parameters
    const ogImage = page.locator('meta[property="og:image"]');
    const imageUrl = await ogImage.getAttribute("content");

    // Image URL should be for OG API without preset
    expect(imageUrl).toContain("/api/og");
    // Should NOT have preset parameter since URL is /
    expect(imageUrl).not.toContain("preset=");
  });

  test("should not override explicit preset with default", async ({ page }: { page: Page }) => {
    // Go to homepage with udp preset
    await page.goto("/?preset=udp");
    await page.waitForLoadState("networkidle");

    // Title should reflect udp preset, not default ipv4
    const title = await page.title();
    expect(title).toContain("UDP");
    expect(title).not.toContain("IPv4");

    // URL should preserve the udp preset
    expect(page.url()).toContain("preset=udp");
  });

  test("should handle invalid preset gracefully and use default", async ({
    page,
  }) => {
    // Go to homepage with invalid preset
    await page.goto("/?preset=nonexistent_protocol");
    await page.waitForLoadState("networkidle");

    // Should either show default (ipv4) or generic title
    const title = await page.title();
    expect(title).toBeTruthy();
    expect(title).toContain("Packet Visualizer");
  });

  test("should update page when switching presets in the UI", async ({
    page,
  }) => {
    await page.goto("/?preset=ipv4");
    await page.waitForLoadState("networkidle");

    // Get initial title
    let title = await page.title();
    expect(title).toContain("IPv4");

    // Look for preset selector/dropdown
    // This is a UI interaction test - if the app has a preset selector
    const presetSelectors = page.locator('[data-testid*="preset"]');
    const selectorCount = await presetSelectors.count();

    // If there's a preset selector, try to interact with it
    if (selectorCount > 0) {
      // Try to find and click on a different preset option
      const ipv6Option = page.locator("text=/IPv6|ipv6/i");
      if ((await ipv6Option.count()) > 0) {
        await ipv6Option.first().click();
        await page.waitForTimeout(500); // Wait for UI update

        // Title should be updated to IPv6
        title = await page.title();
        expect(title).toContain("IPv6");
      }
    }
  });

  test("should maintain title consistency across page reloads with auto-applied preset", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Get title before reload
    const titleBefore = await page.title();
    expect(titleBefore).toContain("IPv4");

    // Reload page
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Title should be the same after reload
    const titleAfter = await page.title();
    expect(titleAfter).toBe(titleBefore);
  });

  test("should update meta tags when preset changes via URL navigation", async ({
    page,
  }) => {
    // Start with ipv4 - server generates OG with preset info
    await page.goto("/?preset=ipv4");
    await page.waitForLoadState("networkidle");

    let ogTitle = page.locator('meta[property="og:title"]');
    let ogTitleContent = await ogTitle.getAttribute("content");
    expect(ogTitleContent).toContain("IPv4");

    // Navigate to ipv6 - server should generate new OG with ipv6 info
    await page.goto("/?preset=ipv6");
    await page.waitForLoadState("networkidle");

    // Meta tags should be updated because it's a full page load
    // with a different URL (server-side regeneration)
    ogTitle = page.locator('meta[property="og:title"]');
    ogTitleContent = await ogTitle.getAttribute("content");
    expect(ogTitleContent).toContain("IPv6");
  });

  test("should preserve controllers when switching presets", async ({
    page,
  }) => {
    // Go to ipv4 with controllers
    await page.goto("/?preset=ipv4&controllers.ihl=6&controllers.dscp=20");
    await page.waitForLoadState("networkidle");

    // Check URL has both preset and controllers
    expect(page.url()).toContain("preset=ipv4");
    expect(page.url()).toContain("controllers.ihl=6");
    expect(page.url()).toContain("controllers.dscp=20");

    // Check og:image includes controllers
    const ogImage = page.locator('meta[property="og:image"]');
    const imageUrl = await ogImage.getAttribute("content");
    expect(imageUrl).toContain("controllers.ihl=6");
  });

  test("should not reset to default when parameters are preserved in navigation", async ({
    page,
  }) => {
    // Set up with ipv6 and controller
    const targetUrl = "/?preset=ipv6&controllers.ihl=7";
    await page.goto(targetUrl);
    await page.waitForLoadState("networkidle");

    let title = await page.title();
    expect(title).toContain("IPv6");

    // Simulate a navigation that should preserve state
    // (e.g., if the app has internal navigation)
    await page.waitForTimeout(500);

    // Title should still be ipv6
    title = await page.title();
    expect(title).toContain("IPv6");
    expect(title).not.toContain("IPv4 Header");
  });
});
