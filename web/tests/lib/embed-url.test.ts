import { describe, expect, it } from "vitest";

import { parseEmbedThemeParam } from "@/lib/embed-url";

describe("embed URL params", () => {
  it("parses supported theme values", () => {
    expect(parseEmbedThemeParam("?theme=light")).toBe("light");
    expect(parseEmbedThemeParam("?theme=dark")).toBe("dark");
    expect(parseEmbedThemeParam("?theme=system")).toBe("system");
  });

  it("distinguishes missing and invalid theme values", () => {
    expect(parseEmbedThemeParam("?preset=ipv4")).toBeNull();
    expect(parseEmbedThemeParam("?theme=nope")).toBe("system");
  });
});
