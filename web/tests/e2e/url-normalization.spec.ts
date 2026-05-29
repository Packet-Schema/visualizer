import { test, expect } from "@playwright/test";

const PSDL_CUSTOM_UDP =
  "N4IgRg9gJgniBcBtUBLKCQGcBOBjEANCAHYCGAtgKYYDKEArnpQAQAKE2ALoSJzAA7V4oANYpi6eOBSdMPYggCMANgC-qgLpEolTLmwp-nFBAVSAgs1z1MnCOWYBVACKsAtABsUIlv1K4fTmYAMw5mTl1jYgBzADoeUOxyUm4pfkwoD3kKIRAAYRs7BxdWHmwIAHcAIRk5eABmACYiADdKbEwTMxAABljGkFUgAA";

test.describe("URL normalization — final URL after redirect + hydration", () => {
  test("strips unknown params", async ({ page }) => {
    await page.goto("/?preset=ipv4&unknown=foo");
    await page.waitForURL((url) => !url.searchParams.has("unknown"));
    const params = new URL(page.url()).searchParams;
    expect(params.has("unknown")).toBe(false);
    expect(params.get("preset")).toBe("ipv4");
  });

  test("drops invalid psdl and keeps preset", async ({ page }) => {
    await page.goto("/?psdl=GARBAGE&preset=ipv4");
    await page.waitForURL((url) => !url.searchParams.has("psdl"));
    const params = new URL(page.url()).searchParams;
    expect(params.has("psdl")).toBe(false);
    expect(params.get("preset")).toBe("ipv4");
  });

  test("drops preset when valid psdl is present", async ({ page }) => {
    await page.goto(`/?preset=ipv4&psdl=${PSDL_CUSTOM_UDP}`);
    await page.waitForURL((url) => !url.searchParams.has("preset"));
    const params = new URL(page.url()).searchParams;
    expect(params.has("preset")).toBe(false);
    expect(params.has("psdl")).toBe(true);
  });

  test("deduplicates repeated preset, keeping first valid", async ({
    page,
  }) => {
    await page.goto("/?preset=nope&preset=ipv4");
    await page.waitForURL(
      (url) => url.searchParams.getAll("preset").length === 1,
    );
    const params = new URL(page.url()).searchParams;
    expect(params.getAll("preset").length).toBe(1);
    expect(params.get("preset")).toBe("ipv4");
  });
});
