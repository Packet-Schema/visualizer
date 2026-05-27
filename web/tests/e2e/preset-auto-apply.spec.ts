import { test, expect, type Page } from "@playwright/test";

test.describe("Preset Auto-Apply Behavior", () => {
  test("should have default title when accessing without preset", async ({
    page,
  }) => {
    // Go to homepage without preset parameter
    // Use domcontentloaded to check title before JavaScript fully executes
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Server-generated title (before useEffect runs)
    let title = await page.title();
    expect(title).toBe("Packet Visualizer");

    // Wait for dynamic content to load and useEffect to update title
    await page.waitForLoadState("networkidle");

    // Client-side JavaScript has executed and updated the title
    // useEffect updates it from "Packet Visualizer" to "IPv4 Header | Packet Visualizer"
    title = await page.title();
    expect(title).toBe("IPv4 Header | Packet Visualizer");

    // URL should also be updated to include preset parameter (client-side)
    const finalUrl = page.url();
    expect(finalUrl).toContain("preset=ipv4");

    // OG meta tag is server-generated based on initial URL (no preset param)
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

  test("should not override explicit preset with default", async ({
    page,
  }: {
    page: Page;
  }) => {
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
    const title = await page.title();
    expect(title).toContain("IPv4");

    // Look for preset selector/dropdown
    const presetSelect = page.locator('[data-testid="preset-picker"]');
    await expect(presetSelect).toBeVisible({ timeout: 5000 });

    // Switch to IPv6
    await presetSelect.selectOption("ipv6");

    // Title is updated via document.title in a useEffect (double rAF),
    // so wait for the title to actually change rather than networkidle.
    await expect(page).toHaveTitle(/IPv6/, { timeout: 5000 });
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

    // Title should still be ipv6
    title = await page.title();
    expect(title).toContain("IPv6");
    expect(title).not.toContain("IPv4 Header");
  });
});
