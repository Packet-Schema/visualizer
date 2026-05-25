import { describe, it, expect } from "vitest";
import {
  buildShareQueryFromParams,
  isShareQueryLengthValid,
  parseShareParams,
} from "@/lib/share-url";
import { PRESETS } from "@/lib/psdl/presets";

describe("OG API integration - share URL utilities", () => {
  it("generates valid share query from URL params", () => {
    const params = new URLSearchParams("preset=ipv4&controllers.ihl=5");
    const query = buildShareQueryFromParams(params);
    expect(query).toContain("preset=ipv4");
    expect(query).toContain("controllers.ihl=5");
  });

  it("validates query length constraints", () => {
    const shortQuery = "preset=ipv4";
    expect(isShareQueryLengthValid(shortQuery)).toBe(true);

    const longQuery = "preset=" + "x".repeat(3000);
    expect(isShareQueryLengthValid(longQuery)).toBe(false);
  });

  it("parses preset parameters for OG image generation", () => {
    const parsed = parseShareParams(
      "?preset=ipv4&controllers.ihl=6",
      Object.keys(PRESETS),
    );
    expect(parsed.kind).toBe("preset");
    if (parsed.kind === "preset") {
      expect(parsed.presetKey).toBe("ipv4");
      expect(parsed.controllers.ihl).toBe(6);
    }
  });

  it("handles unknown presets gracefully", () => {
    const parsed = parseShareParams(
      "?preset=nonexistent",
      Object.keys(PRESETS),
    );
    expect(parsed.kind).toBe("none");
    if (parsed.kind === "none") {
      expect(parsed.error).toMatch(/Unknown preset/);
    }
  });

  it("validates controller values are integers", () => {
    const parsed = parseShareParams(
      "?preset=ipv4&controllers.ihl=10&controllers.bad=NaN",
      Object.keys(PRESETS),
    );
    expect(parsed.kind).toBe("preset");
    if (parsed.kind === "preset") {
      expect(parsed.controllers.ihl).toBe(10);
      expect(parsed.controllers.bad).toBeUndefined();
    }
  });

  it("clamps controller values to safe integer range", () => {
    const parsed = parseShareParams(
      "?preset=ipv4&controllers.ihl=999",
      Object.keys(PRESETS),
    );
    expect(parsed.kind).toBe("preset");
    if (parsed.kind === "preset") {
      expect(typeof parsed.controllers.ihl).toBe("number");
      expect(parsed.controllers.ihl).toBe(999);
    }
  });

  it("backwards compatibility: empty controllers defaults to ipv4", () => {
    const parsed = parseShareParams("?", Object.keys(PRESETS));
    expect(parsed.kind).toBe("none");

    const withControllers = parseShareParams(
      "?controllers.x=1",
      Object.keys(PRESETS),
    );
    expect(withControllers.kind).toBe("preset");
    if (withControllers.kind === "preset") {
      expect(withControllers.presetKey).toBe("ipv4");
    }
  });

  it("handles multiple controller values", () => {
    const params = new URLSearchParams();
    params.set("preset", "ipv4");
    params.set("controllers.ihl", "5");
    params.set("controllers.dscp", "10");
    const query = buildShareQueryFromParams(params);
    const parsed = parseShareParams(query, Object.keys(PRESETS));
    expect(parsed.kind).toBe("preset");
    if (parsed.kind === "preset") {
      expect(parsed.controllers.ihl).toBe(5);
      expect(parsed.controllers.dscp).toBe(10);
    }
  });
});
