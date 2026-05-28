import { test, expect } from "@playwright/test";

test.describe("Homepage and Meta Tags", () => {
  test.describe("Homepage access", () => {
    test("returns 200 status when accessing homepage", async ({ request }) => {
      const response = await request.get("/");
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/html");
    });

    test("returns 200 status when accessing homepage with preset parameter", async ({
      request,
    }) => {
      const response = await request.get("/?preset=ipv4");
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/html");
    });

    test("returns valid HTML with proper structure", async ({ request }) => {
      const response = await request.get("/");
      const html = await response.text();

      expect(html).toContain("<html");
      expect(html).toContain("<head");
      expect(html).toContain("<body");
      expect(html).toContain("</html>");
    });
  });

  test.describe("Meta tags - without preset", () => {
    test("includes title tag when accessing without preset", async ({
      request,
    }) => {
      const response = await request.get("/");
      const html = await response.text();

      expect(html).toContain("<title>");
      expect(html).not.toContain('data-preset="ipv4"');
    });

    test("includes OGP meta tags when accessing without preset", async ({
      request,
    }) => {
      const response = await request.get("/");
      const html = await response.text();

      expect(html).toContain('property="og:title"');
      expect(html).toContain('property="og:description"');
      expect(html).toContain('property="og:image"');
    });

    test("includes correct og:description content without preset", async ({
      request,
    }) => {
      const response = await request.get("/");
      const html = await response.text();

      expect(html).toContain(
        'property="og:description" content="Visual viewer for common network packet headers."',
      );
    });

    test("includes description meta tag without preset", async ({
      request,
    }) => {
      const response = await request.get("/");
      const html = await response.text();

      expect(html).toContain(
        'name="description" content="Visual viewer for common network packet headers."',
      );
    });

    test("does not include og:url meta tag when accessing without preset", async ({
      request,
    }) => {
      const response = await request.get("/");
      const html = await response.text();

      expect(html).not.toContain('property="og:url"');
    });
  });

  test.describe("Meta tags - with preset", () => {
    test("includes title tag with preset info when accessing with preset", async ({
      request,
    }) => {
      const response = await request.get("/?preset=ipv4");
      const html = await response.text();

      expect(html).toContain("<title>");
      expect(html).toContain("IPv4");
      expect(html).toContain("Packet Visualizer");
    });

    test("includes OGP meta tags with preset info when accessing with preset", async ({
      request,
    }) => {
      const response = await request.get("/?preset=ipv4&controllers.ihl=6");
      const html = await response.text();

      expect(html).toContain('property="og:title"');
      expect(html).toContain("IPv4");
      expect(html).toContain('property="og:description"');
      expect(html).toContain('property="og:image"');
      expect(html).toContain("preset=ipv4");
    });

    test("includes correct og:description with preset", async ({ request }) => {
      const response = await request.get("/?preset=ipv4");
      const html = await response.text();

      expect(html).toContain(
        'property="og:description" content="IPv4 header (RFC 791) — IHL drives the Options length."',
      );
    });

    test("includes description meta tag with preset", async ({ request }) => {
      const response = await request.get("/?preset=ipv4");
      const html = await response.text();

      expect(html).toContain(
        'name="description" content="IPv4 header (RFC 791) — IHL drives the Options length."',
      );
    });

    test("includes og:image with preset parameters in URL", async ({
      request,
    }) => {
      const response = await request.get("/?preset=ipv6");
      const html = await response.text();

      expect(html).toContain('property="og:image"');
      expect(html).toContain("preset=ipv6");
    });

    test("includes correct og:description with different preset", async ({
      request,
    }) => {
      const response = await request.get("/?preset=ipv6");
      const html = await response.text();

      expect(html).toContain(
        'property="og:description" content="Internet Protocol version 6 header (RFC 8200 §3). Fixed 40 bytes; optional features such as fragmentation and routing live in chained extension headers selected by Next Header."',
      );
    });
  });

  test.describe("Meta tags - with PSDL custom packet", () => {
    // PSDL for: { name: "Custom UDP", description: "A custom UDP-like packet for testing.", rowBits: 32, body: [...] }
    const PSDL_CUSTOM_UDP =
      "N4KABGBEBmD2BOBbAhgF0gLigBwM4BMAbSAGnCgDcBTeXAS1gDtMoAGAOgCZTzJHlEVFpADCAV1ypYiMAFUAIgAUeESPFgB3AEJ1UuFgGZOZVfiq4AxvDrZUDZlkgBBMBYlSZCxQFpCdANZUYNjIFoGoYHDwYKjmdowA5uwqUABGsPgAniwA2uQQoBBFUHT4wrjwFinFfAJCjgDKsGKVQYoI6CbFUKiZ2PVghd2q-nSMZY6puvpdw3wsAIwAbPlFAL6rGxAAuiBrQA";

    test("includes og:title with custom packet name", async ({ request }) => {
      const response = await request.get(`/?psdl=${PSDL_CUSTOM_UDP}`);
      const html = await response.text();

      expect(html).toContain('property="og:title"');
      expect(html).toContain("Custom UDP");
      expect(html).toContain("Packet Visualizer");
    });

    test("includes correct og:description with custom packet description", async ({
      request,
    }) => {
      const response = await request.get(`/?psdl=${PSDL_CUSTOM_UDP}`);
      const html = await response.text();

      expect(html).toContain(
        'property="og:description" content="A custom UDP-like packet for testing."',
      );
    });

    test("includes description meta tag with custom packet description", async ({
      request,
    }) => {
      const response = await request.get(`/?psdl=${PSDL_CUSTOM_UDP}`);
      const html = await response.text();

      expect(html).toContain(
        'name="description" content="A custom UDP-like packet for testing."',
      );
    });

    test("includes og:image with psdl parameter", async ({ request }) => {
      const response = await request.get(`/?psdl=${PSDL_CUSTOM_UDP}`);
      const html = await response.text();

      expect(html).toContain('property="og:image"');
      expect(html).toContain("psdl=");
    });
  });

  test.describe("URL normalization — 302 redirect", () => {
    test("strips unknown params", async ({ page }) => {
      await page.goto("/?preset=ipv4&unknown=foo");
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.has("unknown")).toBe(false);
      expect(new URL(page.url()).searchParams.get("preset")).toBe("ipv4");
    });

    test("/ alone is not redirected", async ({ request }) => {
      const response = await request.get("/");
      expect(response.status()).toBe(200);
    });

    test("drops invalid psdl and keeps preset", async ({ page }) => {
      await page.goto("/?psdl=GARBAGE&preset=ipv4");
      await page.waitForLoadState("networkidle");
      const params = new URL(page.url()).searchParams;
      expect(params.has("psdl")).toBe(false);
      expect(params.get("preset")).toBe("ipv4");
    });

    test("drops preset when valid psdl is present", async ({ page }) => {
      // Use the known-good PSDL fixture from the PSDL tests
      const PSDL_CUSTOM_UDP =
        "N4KABGBEBmD2BOBbAhgF0gLigBwM4BMAbSAGnCgDcBTeXAS1gDtMoAGAOgCZTzJHlEVFpADCAV1ypYiMAFUAIgAUeESPFgB3AEJ1UuFgGZOZVfiq4AxvDrZUDZlkgBBMBYlSZCxQFpCdANZUYNjIFoGoYHDwYKjmdowA5uwqUABGsPgAniwA2uQQoBBFUHT4wrjwFinFfAJCjgDKsGKVQYoI6CbFUKiZ2PVghd2q-nSMZY6puvpdw3wsAIwAbPlFAL6rGxAAuiBrQA";
      await page.goto(`/?preset=ipv4&psdl=${PSDL_CUSTOM_UDP}`);
      await page.waitForLoadState("networkidle");
      const params = new URL(page.url()).searchParams;
      expect(params.has("preset")).toBe(false);
      expect(params.has("psdl")).toBe(true);
    });

    test("deduplicates repeated preset, keeping first valid", async ({
      page,
    }) => {
      await page.goto("/?preset=nope&preset=ipv4");
      await page.waitForLoadState("networkidle");
      const params = new URL(page.url()).searchParams;
      expect(params.getAll("preset").length).toBe(1);
      expect(params.get("preset")).toBe("ipv4");
    });
  });

  test.describe("Meta tags - with controllers", () => {
    test("includes OGP meta tags when accessing with multiple controller parameters", async ({
      request,
    }) => {
      const response = await request.get(
        "/?preset=ipv4&controllers.ihl=5&controllers.dscp=20&controllers.ecn=3",
      );
      const html = await response.text();

      expect(html).toContain('property="og:title"');
      expect(html).toContain("IPv4");
      expect(html).toContain('property="og:description"');
      expect(html).toContain('property="og:image"');
      expect(html).toContain("preset=ipv4");
      expect(html).toContain("controllers.ihl=5");
    });

    test("includes correct og:description with controller parameters", async ({
      request,
    }) => {
      const response = await request.get(
        "/?preset=ipv4&controllers.ihl=5&controllers.dscp=20",
      );
      const html = await response.text();

      expect(html).toContain(
        'property="og:description" content="IPv4 header (RFC 791) — IHL drives the Options length."',
      );
    });

    test("includes description meta tag with controller parameters", async ({
      request,
    }) => {
      const response = await request.get(
        "/?preset=ipv4&controllers.ihl=5&controllers.dscp=20",
      );
      const html = await response.text();

      expect(html).toContain(
        'name="description" content="IPv4 header (RFC 791) — IHL drives the Options length."',
      );
    });
  });
});
