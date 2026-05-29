import { test, expect } from "@playwright/test";

const PSDL_CUSTOM_UDP =
  "N4IgRg9gJgniBcBtUBLKCQGcBOBjEANCAHYCGAtgKYYDKEArnpQAQAKE2ALoSJzAA7V4oANYpi6eOBSdMPYggCMANgC-qgLpEolTLmwp-nFBAVSAgs1z1MnCOWYBVACKsAtABsUIlv1K4fTmYAMw5mTl1jYgBzADoeUOxyUm4pfkwoD3kKIRAAYRs7BxdWHmwIAHcAIRk5eABmACYiADdKbEwTMxAABljGkFUgAA";

// toJson(PRESETS["ipv4"], {}) with top-level keys reversed — same content, different key order.
const PSDL_IPV4_PRESET_NONCANONICAL =
  "N4IgbgpgTgzglgewHYgFwgAwDoBMIA0IUCA7gEJwAuMaAzDoUgIYC2EaIAkgApgAsAAgASEJgBNoBEADMEUFk0ocADjDEAbKRJgBjKHGWVEKdD34CAFqIlQBACgBKAMQDCAgOwBOAIwBKAYAoBAKcQgAyAmL6kDAClFYCAPKGxjHqEEgA5nFYUjrIMJRQTHBI1GgA2qBiCDocIeF5AK6lMfQAtABGVAIkcmIwANyxCJRM6pbW0AIdAJ6UEDEAvMFhAgDrAnw5hOoWNKigTGig0nAQ6mIccBaahADWJZfoUBDSIAC-hB3HIA9ITyB1FQpGAxo12Kg-J9fo8OAhlFJ4RwAFQfQhQPY_U7nAFWcTQMhzBZSP4Al5vd7vAC6XyJCSgNg4ZAAolIOggxDMKqAdIoIBk5Fz0JQZsp2IQJNImI11JQAGpgiF8QhwAGQWDGKTMNgcOXQeDIKQisU_UkcLplRhoKGfHl8gVQIWA9JZCxaV7S2UK9TgtAAVhVAOutxA2ohXDCRtFENAZvQFpoVshlPwdvmDqdxvFIFVHH6OgRjFY4YAIgBlFzcKMmg4w_7mqiJ0NoABsKbT_MFHGk6iYGSbufQEB0KCLOvQzJcADlqzG6wCE1q0Dh2yBeemu-g0pk4lJByBKCMxqEXbux-GACpH8YnnduwhZn6L1DeFv3WHoEpKVfrzuOq4SKUcDYlAe5BoBRinOumrnnUEHAXA0GGg-0ZPo2aCvu-9afqUHy2muFhwBcLwmJUa72puMi9v2YHdtRMAAPovDA0CQJcsHoA4s6mh-ICLkm3g_hR_7oD2fYDgCYn9gxYhvBxIAlk43G1nGfHoQJQkbiJVHibRon0QxLByaGxYcAAskpKE1rGvH8c2L6UjSOaSfRFCWvOHAZMQjQIvhv4ZgB6SQWcoGBt2RQZAk0jSCxSjyU4EVsKUiTRbFyk2dhanuSY3i0Jpf5OqqQUIZIYXCpQIZhhwF4XqE6VZfsAAcWFBrh-UBcKqFlSAyjEIeeSVaZ6DcH1NQICGj61s-zUeTh35-cJTo6FYOh3DAjQsHpIB4jYLgrWtG1akNIAiPith7cOB2bVZc7Pphs05m1C1aU64iRAs8CZFtMBQDoACCYiREd44gGWCCNL9EACAD70wE2k2gM-9AtVcT2puRL0cG9zGfRkW39JQMOhSZIMlgsRjMEYyDQ4DOP1UjDAPV-eHo_5lGgvoTAdGkuTg7htbYhcVzKPwSRU0gMAuHzcUPeSaIgOcEBJUoAtnBc-xkbyLH7KAGBYmr_TchjBUcI-3VmyTl7Roses3TxmV2SYjWOd1EDjcD4bMgk4R2My_wCAg0iJMk1OhHABS-PL3j6ziGsdh1B5dc5ptJ1V6AXtb0d2yptnqfZzvUt1SBIvJU4JNw9hTggwfQIoxiR9C7gx-rRts9pFv7hbacgBnYqLE32cZQuedO-1lHbq6W0T2elscLeizeH69WqY7aAF6zi2BUBIFbcoCBfqVs_DYUy-59la9j9p2MfSUePddjttHyARMCFnifWQ1dCM6pzOX69tM3y-vfWmb9u4vzwIPT-qBkZMzRvHSi184a3y2tjCBT8X60HpuhaB39eK_0LsnZ4w4-gOHBvMD2HAHDEIZAIUhjRyHQhbI1ZuhtUCa03p1E05tU7HV7hARYTDT4OxHhfZ6JstynnvIQ50d4KHoHnt4NBCMHqr1QOveB2kirbxCrvfepRD7d24CfSBK8RFqL_nRXS3VA7qBID2O-T8oq2IAPROHUA45Rpjz7mLEQnLRwVD6dxgI_buF4yyvywWUHBKM5osw0YVeCO9zYwFAbw8JSjUJTWwTAn-T0nKdzgGwAorBCxPwvIU8mJSo60GjqrWOrcOHv2zJ3HhIM-ELxqUI4e3j1HGwTtPKR-4BlyJAAot-niz5NlHr4yi_iSrE33HvA-xNDHGKafbbpUzREb0xugRBuMUG0xCcdF-4zMmI2ybgzK-CdniJAPs5BwDIipJBuAyJ-wcl4Lyd1dQCAEAsTBhDHQEA6HkPkqEP5LEBCAshrQsh7BoS5SbnUlubD4kpy4dIruvDM60AHusnOwiekWIkbIn5kiRljK6Q2YlMzNGJJ0d1JZ-iVnHSMcTCZRKtk-NuQnB5QDpEPxGac95X8YmPXmryhBACkECv3NjF54Y3mQIZuK_B-SAQFH0DoSgMLgWguzN3MshREKUGheDWFBqWbSNmHwkkvEYAkCoMtREJgTgGzhIYO14q5Yu2kfCcWVC8gMnlvuANKR7WZReGKRQIyxYRupO8IAA";

// encodePsdlParam(PRESETS["ipv4"]) — generated via tsx at build time.
const PSDL_IPV4_PRESET =
  "N4IgRg9gJgniBcBtUBjAhgFwKYHMICc54QMYAHLEAGhCiwDM0BXAGwwDU0WnL4AWGgEsoCEADcs-AM6CIAO2og5aALa8Q7STPmLSFBKADWguSOJhBGKYoX8AvnaqpMuAkRAsscnBgAWiukZWDi4eBABWITMQQV8WG1V1AEkACQAZXXJeIxNoiysbBD4HJxB0bDxCUT1KKNEoKRQyBLVRABEAZQBhAAVM_Xgc01F86xpbADYS5wq3UXoWNBwxmOisFAVxxNEAUS6AOX7skGNh80sV2wAmabKXSvdPbz9FYWqIDC40rx9_LdbiAAVD5cAAE32efxIWQM4AuCAAjBMaKdoiYMCBbuVXFViMIvBhBPRBJJXmi6HJCcTyrJNkptsQkhSqYIaToaDVYaNEciTrlROjMY5UL5BCwoPgvAhkHdZriQAslis3sRFcsAPqSqSSCQif7qABKR1hqJG8PGiKx9zmqsWyzJ8ztUnVUHoLXUbQAYsbBnyznCChb4AirXL3GrldEI-qVG79aIALLejkw32m86BpSWuwAXTqtqVACFzX7ojh8BAmM1hbKce58ZSiST8A7VfglgB5ej0bUY-PET3tnBqSmgrs9rB96EDIZ5Eu2BEAZlDdYFzKbpPzJAw8X7IEBgIyKZnAes8AAHCj-XjKULStiHtUYVuyBWMBAUBBd_SASAem-Py_H1QG5C8r39QUV0fYgUF8dZDCkJgVFbEA4LQOh8C6OCUAQpD3VEFIsHQyRQSw-DEOQ49jlApFwLRW8oJtEB0IlLApBkbwUKkfAUAAQSgCV8OIDpKx4rBQX41j2OA08EEXK46IFBiawfJiWK1DicBQhoMEkls9zaNjCWUQl5AkgSNJk0D5MUm8MUY-UxDQfBBDQMBPEUT8mFvX1iSwcUBTIMQ-A7MhTLkKQukrW9bJASU3UcEB_KwEcMV8klxTPGV0G1M9QAABlhPzMulGZV2ITkt0qn91EBLIAF5Cqok1r1koNzwcPNVlELAgL3HYOzSUEAAodlMUEIHoMcwtpcFBCkDAAEpMRoBEioyhpStraDp1qbqKufGrRDqih6rW5q01a7l2s6rc5AgZo932DsehG_YIGmyRMFpZbEqXNb0v8zakDKnbqpVXahP3Br_pk9M2qzC8HMeH4Xi3J5fihiEzvOyHLv9a7EY6lTrXlBsWU3faQDICB0Up5Rfx6DB9Lx2czUzWxifvUn3HUtjNJQ9SmqO4g9NBXHOV9ayFNLJT7JJsNRD59iTC0rd1Nxhn1DFq4rPheAbNluyhS6iGWAgCBtREpgxINStsCxi3tVBa2xNBO2mAdv7FwAdnWoGstBpjweiaqteOmHfbhq75wQLmg_lDG0appOoXD4hsYRCXUzZjNLjj5G1wJDcWYhmm6ZZ9O_2Z6OCdjpGFfK5iLP51XBYs4Wq7F7OT2l2LIMbnblYF9WLM1hkQB1vWCgNmX4YH03ogWlyUAwV2UCwD2Hb3DpmdZDAXdEjf3ftyhEomc9_ZKkHtuDw6IbDieTqweqL9rucOYLwemNTlDf73TOusLq5wRpzQueJ1x-VLtEculJ6YTyZizSWIDCZgO_vKCMKFJosAAO4LDViLEAXZcEAHpPQsAIcgo2oCv7c0VhA4uUCUJWE7k_Do4tp5nkNvPZSdCm7kxLswqQ49fyAnYUA1mslZ792Uovaogg1ALVUI9QhgIFFGWUStEAftAbX2yjzJ8-gqqHSrs_eqftgHUNQbQhOKNIR_1RmnCemdwjv3ZvnBufCdoCKYS-WmcDK4IJrpY-G1jPG2KVi3FWnFR4SlYb-bunC5Jz1agPLxakokjyphrKGU9LF92oWkiJxBh5t1ifgCRXcLKgkXEk6RhTZFbklJ-fAUAt57SrgadYBAoAn09mfRKEMwAwGfooeGUgcGWFgooHQujogPQwKM2K8UTZbgWbSLpLSRCDPmTNeQKx4aSgoJgKGoVwrWFzDQYZ2AOytNJMQQsOxPL7OZmgdEgdaAflEKkIaXlKRSBqVcAAtPkUEOCelSAANygnfJ8FgoI0IYVBNctioJ6qgh-aCAA66CPgAA6RQLBfB5WYlfNEcQxmtRWYlMALV_QsEsIoJy3BeDFFig9GZzRiAACotH4GJWS0QiLJCFhgNgA5VKGCrNoGxFALk9m2BAEkHowUEVESRcNA0nouigh9gATgRItUEgAUAgxekUEEpBASABX4cSZzaQAtTgSmg9ACAqBOcQMgUgoDfirsq1VhFiIswrDg4sM9DYSGkLSUQ-U8W6zsEAAA";

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
      expect(html).toContain("Packet Schema Visualizer");
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
      expect(html).toContain("Packet Schema Visualizer");
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

  test.describe("URL normalization — 307 redirect", () => {
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
