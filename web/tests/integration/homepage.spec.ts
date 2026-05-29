import { test, expect } from "@playwright/test";

const PSDL_CUSTOM_UDP =
  "N4KABGBEBmD2BOBbAhgF0gLigBwM4BMAbSAGnCgDcBTeXAS1gDtMoAGAOgCZTzJHlEVFpADCAV1ypYiMAFUAIgAUeESPFgB3AEJ1UuFgGZOZVfiq4AxvDrZUDZlkgBBMBYlSZCxQFpCdANZUYNjIFoGoYHDwYKjmdowA5uwqUABGsPgAniwA2uQQoBBFUHT4wrjwFinFfAJCjgDKsGKVQYoI6CbFUKiZ2PVghd2q-nSMZY6puvpdw3wsAIwAbPlFAL6rGxAAuiBrQA";

// toJson(PRESETS["ipv4"], new Map()) with top-level keys reversed — same content, different key order.
const PSDL_IPV4_PRESET_NONCANONICAL =
  "N4Igxg9gdgzgLgJwIYEspxiAXAbVAGwAtMtQBrNAE2xAgAcQAaWhrEAKiZCW3KpoQBTAGZdhKQfmpsUhfCAC+zAEa8QFKNJD4UcLgDck+AK6DsAFgVKQCYmo1aho5uMlbCgpJUEIAQgE84QUxrSggwGgBJAAkAGQACSGN0GHiAZgAmAFplXXiAdwgEShgAbni4CDgjeI8vH3jlQOD4gF54mISAdfjzADpFAF0VCEp-bDwQFC19HxgUaC4oJABbMzYANTmFqC44fzp1vk0aXIwli2swJCCAcyLxtn3Drm9hJGN8OA2jU0vGUDTGiyeTMZZrKJxPYHI7qfhsM6YMH-cA3QT3BCPbSCKC3OCEV4iD5fH4mdYAViUgK0JTADDBq3WIAAIgBlADCAAVoS9SHCTgjdEiQLssAA2K5ojFY55mKlTLSCMC7BkQtgAUXZADkebCHKchRcsBlJXcHjRhPgkLcQgCFTRKtV8LEcXiCaqmQAVKo1F24-G6+zwqboLiI7AARglzGuZsxNHwroD8qBMm86BQ4ljOyWjKi6bgmZQ2cWzFlQYFIb0KkNWCjpvR5rTOMLrgQijt+rYtwQEGM9PtbEt1pgvkNMcIKCkQlFk1TIGHNoA+kIYD5ZtQPTQAEqBvldkDh5F1hvSi1Wm0d6nnkdLyjOEV5tjMgBie+OWiPIsjp6bC4vtrXkOAFLisD7gkyACyb5ljCFafuO34njGUp-ouISDCmWjCMgtwAPLCMIa7Vo+aogC+uFrOg8QEURggkeW+7Bl+ooRmkv7xs2GZtleg4gHAcCgqRXqerE778loaAkeGWAABwcVi0wtkWPi8fOdC9pUkBCRBNCcpp4QQEJjEfsCoY1ucckKQ6cFYTQdTeAg7IeGAZAwMYKy5mR0SeI58TOUqbkeeJB5SWGtb1ihcZYmALlBZ5dlsDACBgAAgpQlDtlubCsn2KWCPE6WZcEwomRJZnSbWmTWWwXjFTA8y4mpNLwEVWXCTQzLBIWyyFtAhUZaupVwUxlZhRZJDVVFjacdwg0lWgty8QeQiHDcXDzvQfWwF5TJ4XQ23CrGM1YoYCAoEgyiJlwkiCFReh8ptB07NuSpFJuC4SFIJCTAeMD5LosUbZ+-ienBzCLKNjgiGIX1aFtYMvJKa4kKAAAMajzoIRm7TQ6p4QkAAU6qaPEEDCDRz39bEKDwAAlLDbg-UB-Hgx1bCI4IrQY7BvKmYK5zHvJ01nk8tmYcwEaY1oUD0LjbBanhnLxITWoQJTPg3DsDMuHDzN8eW2UgJzrRS7zerMYhorC6i0U2UjEsgAA7NLAhvcU259kE8sgK9kDFPEnvGN7utMxMLOG+zxswq0Lvm-BBqC0hNvHaLrNI3a86Jv67pR36pvkiFltJ9bNXYjnzU0HQEBSapRucogReVix2Ap6hs1KdxEjtolc2ZTzUdtfEZvpxbY3mYeVUmiLf51UNi2V7Vg0j7pbBDxkTeSRPMlTbbJ00HPC1Nb3c8b0bQ9pJvFXhZZu+p7P80NQvCiO2Ksmu08KBrPAqwDqvxtf26r-Rm31w4GzZv-E2b8r4C2FKXGes1yy92zm6H2+cIxn1HgnWBRo252zYCg5MmctDV1ru1f+Dd2plQPC3KyCDFIFhUj3YhNByb4HyJaJaRsCLsIAPQvnwFwrBUNE5wNbmXdCi9+IwAHpA1kw8YFVhvpNaee806d1bN3KRGAV5PmNvIzB1DgzjUnrfVR98O6MJ4i-awbEpaPS0PgCAEA1y5WMPlIOIc87OLXPENx+VA5ezMKHUBuAI4QL0SbOxijaF4P3mLDOLNCG53-ugkeRjm5W3EfQhMSYCS91IegOuUdKExKyXQtRf4NFMKkXPWReih7pJGvzJRE1sB33bliQ+T9j4sIXplXRZF16KJMTvcxnSD6P0aktGxks0guwcTQeA50wBwH8WAQQnjglR1ZIgYscA-F5Q2YE4O2zXChLnFoSOkCY5sTjsIlpsSy5IL6eXVBRs0llJLtkyps1klSMKUEchejSnxxETgoWZdqnWNeXUn2jSRnbynmXbp0zanL3hYNeIhjmnlRkEisxKKpnP0wlYR2SRQzgpsDDEJkk6D6HMPtQ67I+yhjJcwbwMAwDnSpqKEAkROQMtqL5BohNtwvnZPEJ2ABOCMdN4iABQCDocR4iZRQLMVI+ICpMp2KkZJAwVDNDwsUVSbBfDqi4L2fIY4zFGwFUKny9R2qzAQPMSGIA0Z9EwcIIoKx1psDoDASg8gFBAA";

// encodePsdlParam(PRESETS["ipv4"]) — generated via tsx at build time.
const PSDL_IPV4_PRESET =
  "N4IgRg9gJgniBcBtUBjAhgFwKYHMICc54QMYAHLEAGhCiwDM0BXAGwwDU0WnL4AWGgEsoCEADcs+AM6CIAO2og5aALa8Q7STPmLSFBKADWguSOJhBGKYoX8AvnaqpMuAkRAsscnBgAWiukZWDi4eBABWITMQQV8WG1V1AEkACQAZXXJeIxNoiysbBD4HJxB0bDxCUT1KKNEoKRQyBLVRABEAZQBhAAVM-Xgc01F86xpbADYS5wq3UXoWNBwxmOisFAVxxNEAUS6AOX7skGNh80sV2wAmabKXSvdPbz9FYWqIDC40rx9-LdbiAAVD5cAAE32efxIWQM4AuCAAjBMaKdoiYMCBbuVXFViMIvBhBPRBJJXmi6HJCcTyrJNkptsQkhSqYIaToaDVYaNEciTrlROjMY5UL5BCwoPgvAhkHdZriQAslis3sRFcsAPqSqSSCQif7qABKR1hqJG8PGiKx9zmqsWyzJ8ztUnVUHoLXUbQAYsbBnyznCChb4AirXL3GrldEI+qVG79aIALLejkw32m86BpSWuwAXTqtqVACFzX7ojh8BAmM1hbKce58ZSiST8A7VfglgB5ej0bUY+PET3tnBqSmgrs9rB96EDIZ5Eu2BEAZlDdYFzKbpPzJAw8X7IEBgIyKZnAes8AAHCj+XjKULStiHtUYVuyBWMBAUBBd-SASAem+Py-H1QG5C8r39QUV0fYgUF8dZDCkJgVFbEA4LQOh8C6OCUAQpD3VEFIsHQyRQSw+DEOQ49jlApFwLRW8oJtEB0IlLApBkbwUKkfAUAAQSgCV8OIDpKx4rBQX41j2OA08EEXK46IFBiawfJiWK1DicBQhoMEkls9zaNjCWUQl5AkgSNJk0D5MUm8MUY+UxDQfBBDQMBPEUT8mFvX1iSwcUBTIMQ+A7MhTLkKQukrW9bJASU3UcEB-KwEcMV8klxTPGV0G1M9QAABlhPzMulGZV2ITkt0qn91EBLIAF5Cqok1r1koNzwcPNVlELAgL3HYOzSUEAAodlMUEIHoMcwtpcFBCkDAAEpMRoBEioyhpStraDp1qbqKufGrRDqih6rW5q01a7l2s6rc5AgZo932DsehG-YIGmyRMFpZbEqXNb0v8zakDKnbqpVXahP3Br-pk9M2qzC8HMeH4Xi3J5fihiEzvOyHLv9a7EY6lTrXlBsWU3faQDICB0Up5Rfx6DB9Lx2czUzWxifvUn3HUtjNJQ9SmqO4g9NBXHOV9ayFNLJT7JJsNRD59iTC0rd1Nxhn1DFq4rPheAbNluyhS6iGWAgCBtREpgxINStsCxi3tVBa2xNBO2mAdv7FwAdnWoGstBpjweiaqteOmHfbhq75wQLmg-lDG0appOoXD4hsYRCXUzZjNLjj5G1wJDcWYhmm6ZZ9O-2Z6OCdjpGFfK5iLP51XBYs4Wq7F7OT2l2LIMbnblYF9WLM1hkQB1vWCgNmX4YH03ogWlyUAwV2UCwD2Hb3DpmdZDAXdEjf3ftyhEomc9-ZKkHtuDw6IbDieTqweqL9rucOYLwemNTlDf73TOusLq5wRpzQueJ1x+VLtEculJ6YTyZizSWIDCZgO-vKCMKFJosAAO4LDViLEAXZcEAHpPQsAIcgo2oCv7c0VhA4uUCUJWE7k-Do4tp5nkNvPZSdCm7kxLswqQ49fyAnYUA1mslZ792Uovaogg1ALVUI9QhgIFFGWUStEAftAbX2yjzJ8+gqqHSrs-eqftgHUNQbQhOKNIR-1RmnCemdwjv3ZvnBufCdoCKYS+WmcDK4IJrpY+G1jPG2KVi3FWnFR4SlYb+bunC5Jz1agPLxakokjyphrKGU9LF92oWkiJxBh5t1ifgCRXcLKgkXEk6RhTZFbklJ+fAUAt57SrgadYBAoAn09mfRKEMwAwGfooeGUgcGWFgooHQujogPQwKM2K8UTZbgWbSLpLSRCDPmTNeQKx4aSgoJgKGoVwrWFzDQYZ2AOytNJMQQsOxPL7OZmgdEgdaAflEKkIaXlKRSBqVcAAtPkUEOCelSAANygnfJ8FgoI0IYVBNctioJ6qgh+aCAA66CPgAA6RQLBfB5WYlfNEcQxmtRWYlMALV-QsEsIoJy3BeDFFig9GZzRiAACotH4GJWS0QiLJCFhgNgA5VKGCrNoGxFALk9m2BAEkHowUEVESRcNA0nouigh9gATgRItUEgAUAgxekUEEpBASABX4cSZzaQAtTgSmg9ACAqBOcQMgUgoDfirsq1VhFiIswrDg4sM9DYSGkLSUQ+U8W6zsEAA";

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
    test("/ alone is not redirected", async ({ request }) => {
      const response = await request.get("/");
      expect(response.status()).toBe(200);
    });

    test("strips unknown params — redirects to clean URL", async ({
      request,
    }) => {
      const response = await request.get("/?preset=ipv4&unknown=foo", {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      const location = response.headers()["location"];
      const params = new URL(location, "http://localhost").searchParams;
      expect(params.has("unknown")).toBe(false);
      expect(params.get("preset")).toBe("ipv4");
    });

    test("drops invalid psdl and keeps preset — redirects", async ({
      request,
    }) => {
      const response = await request.get("/?psdl=GARBAGE&preset=ipv4", {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      const location = response.headers()["location"];
      const params = new URL(location, "http://localhost").searchParams;
      expect(params.has("psdl")).toBe(false);
      expect(params.get("preset")).toBe("ipv4");
    });

    test("drops preset when valid psdl is present — redirects", async ({
      request,
    }) => {
      const response = await request.get(
        `/?preset=ipv4&psdl=${PSDL_CUSTOM_UDP}`,
        { maxRedirects: 0 },
      );
      expect(response.status()).toBe(307);
      const location = response.headers()["location"];
      const params = new URL(location, "http://localhost").searchParams;
      expect(params.has("preset")).toBe(false);
      expect(params.has("psdl")).toBe(true);
    });

    test("deduplicates repeated preset keeping first valid — redirects", async ({
      request,
    }) => {
      const response = await request.get("/?preset=nope&preset=ipv4", {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      const location = response.headers()["location"];
      const params = new URL(location, "http://localhost").searchParams;
      expect(params.getAll("preset").length).toBe(1);
      expect(params.get("preset")).toBe("ipv4");
    });

    test("unknown-only params — redirects to /", async ({ request }) => {
      const response = await request.get("/?foo=1&bar=2", {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      expect(response.headers()["location"]).toBe("/");
    });
  });

  test.describe("psdl-matches-preset redirect", () => {
    test("psdl matching a built-in preset redirects to ?preset=<key>", async ({
      request,
    }) => {
      const response = await request.get(`/?psdl=${PSDL_IPV4_PRESET}`, {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      const location = response.headers()["location"];
      const params = new URL(location, "http://localhost").searchParams;
      expect(params.get("preset")).toBe("ipv4");
      expect(params.has("psdl")).toBe(false);
    });

    test("psdl matching a built-in preset carries over controllers", async ({
      request,
    }) => {
      const response = await request.get(
        `/?psdl=${PSDL_IPV4_PRESET}&controllers.ihl=6`,
        { maxRedirects: 0 },
      );
      expect(response.status()).toBe(307);
      const location = response.headers()["location"];
      const params = new URL(location, "http://localhost").searchParams;
      expect(params.get("preset")).toBe("ipv4");
      expect(params.get("controllers.ihl")).toBe("6");
      expect(params.has("psdl")).toBe(false);
    });

    test("psdl with different key order but same content as preset redirects to preset", async ({
      request,
    }) => {
      // Two redirect hops: normalizeShareQuery canonicalizes → findPresetKeyForPacket matches.
      const response = await request.get(
        `/?psdl=${PSDL_IPV4_PRESET_NONCANONICAL}`,
      );
      const params = new URL(response.url()).searchParams;
      expect(params.get("preset")).toBe("ipv4");
      expect(params.has("psdl")).toBe(false);
    });

    test("psdl with content different from all presets is not redirected to preset", async ({
      request,
    }) => {
      const response = await request.get(`/?psdl=${PSDL_CUSTOM_UDP}`, {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(200);
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
