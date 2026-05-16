// @vitest-environment jsdom
//
// Tests for the preset file-I/O helpers. Runs under jsdom because the
// download path touches Blob / URL / document, and readFileAsText needs the
// browser FileReader.

import { describe, expect, it, vi } from "vitest";
import {
  MY_PRESETS_FILE_FORMAT_VERSION,
  buildMyPresetsBundle,
  downloadBlob,
  extensionToFormat,
  formatToExtension,
  isMyPresetsBundle,
  readFileAsText,
  slugify,
  uniqueKey,
  type FormatKey,
} from "../../lib/preset-file-io";
import type { PsmlPacket } from "../../lib/psml/types";

describe("slugify", () => {
  it("converts ASCII names to kebab-case", () => {
    expect(slugify("IPv4 Header")).toBe("ipv4-header");
    expect(slugify("Hello World")).toBe("hello-world");
  });
  it("collapses runs of non-alphanumerics", () => {
    expect(slugify("A__B!!C")).toBe("a-b-c");
    expect(slugify("  spaces   here  ")).toBe("spaces-here");
  });
  it("handles unicode by stripping it", () => {
    expect(slugify("日本語")).toBe("untitled");
    expect(slugify("hello 日本 world")).toBe("hello-world");
  });
  it("returns 'untitled' for empty / whitespace / non-string input", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("   ")).toBe("untitled");
    expect(slugify("---")).toBe("untitled");
    // Defensive non-string path.
    expect(slugify(undefined as unknown as string)).toBe("untitled");
  });
});

describe("formatToExtension / extensionToFormat", () => {
  const formats: FormatKey[] = ["json", "rfc-ascii", "aug-ascii", "ksy"];
  it("round-trips every format", () => {
    for (const f of formats) {
      const ext = formatToExtension(f);
      const filename = `pkt.${ext}`;
      expect(extensionToFormat(filename)).toBe(f);
    }
  });
  it("returns expected extensions", () => {
    expect(formatToExtension("json")).toBe("psml.json");
    expect(formatToExtension("rfc-ascii")).toBe("txt");
    expect(formatToExtension("aug-ascii")).toBe("aad");
    expect(formatToExtension("ksy")).toBe("ksy");
  });
  it("treats bare .json as PSML JSON", () => {
    expect(extensionToFormat("foo.json")).toBe("json");
  });
  it("returns null for unknown / invalid input", () => {
    expect(extensionToFormat("foo.xyz")).toBeNull();
    expect(extensionToFormat("noext")).toBeNull();
    expect(extensionToFormat(undefined as unknown as string)).toBeNull();
  });
  it("is case-insensitive", () => {
    expect(extensionToFormat("PKT.PSML.JSON")).toBe("json");
    expect(extensionToFormat("PKT.AAD")).toBe("aug-ascii");
    expect(extensionToFormat("PKT.KSY")).toBe("ksy");
    expect(extensionToFormat("PKT.TXT")).toBe("rfc-ascii");
  });
});

describe("downloadBlob", () => {
  it("constructs a Blob URL and clicks a synthesized anchor", () => {
    const created: HTMLAnchorElement[] = [];
    const origCreate = document.createElement.bind(document);
    const createSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = origCreate(tag);
        if (tag === "a") created.push(el as HTMLAnchorElement);
        return el;
      });
    const createUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    vi.useFakeTimers();
    downloadBlob("foo.txt", "text/plain", "hello");
    expect(createUrlSpy).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0].download).toBe("foo.txt");
    expect(created[0].href).toContain("blob:mock");
    // Revoke happens on a 1s timer.
    expect(revokeSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1100);
    expect(revokeSpy).toHaveBeenCalledWith("blob:mock");
    vi.useRealTimers();

    createSpy.mockRestore();
    createUrlSpy.mockRestore();
    revokeSpy.mockRestore();
  });

  it("swallows errors from URL.revokeObjectURL", () => {
    const createUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock2");
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {
        throw new Error("boom");
      });
    vi.useFakeTimers();
    expect(() => downloadBlob("a.txt", "text/plain", "x")).not.toThrow();
    expect(() => vi.advanceTimersByTime(1100)).not.toThrow();
    vi.useRealTimers();
    createUrlSpy.mockRestore();
    revokeSpy.mockRestore();
  });
});

describe("readFileAsText", () => {
  it("resolves with the file contents", async () => {
    const file = new File(["alpha-beta"], "x.txt", { type: "text/plain" });
    const text = await readFileAsText(file);
    expect(text).toBe("alpha-beta");
  });
});

describe("buildMyPresetsBundle / isMyPresetsBundle", () => {
  const samplePacket: PsmlPacket = {
    name: "Demo",
    rowBits: 32,
    body: [{ id: "a", name: "A", type: { kind: "int", bits: 8 } }],
  };

  it("builds a bundle with a current ISO timestamp and the right schema version", () => {
    const bundle = buildMyPresetsBundle({ "custom:demo": samplePacket });
    expect(bundle.schemaVersion).toBe(MY_PRESETS_FILE_FORMAT_VERSION);
    expect(bundle.presets["custom:demo"]).toEqual(samplePacket);
    expect(() => new Date(bundle.exportedAt)).not.toThrow();
    expect(Number.isNaN(Date.parse(bundle.exportedAt))).toBe(false);
  });

  it("recognises valid bundles", () => {
    const bundle = buildMyPresetsBundle({ "custom:demo": samplePacket });
    expect(isMyPresetsBundle(bundle)).toBe(true);
  });

  it("rejects malformed payloads", () => {
    expect(isMyPresetsBundle(null)).toBe(false);
    expect(isMyPresetsBundle("string")).toBe(false);
    expect(isMyPresetsBundle({})).toBe(false);
    expect(isMyPresetsBundle({ schemaVersion: "x" })).toBe(false);
    expect(isMyPresetsBundle({ schemaVersion: "x", presets: [] })).toBe(false);
    expect(isMyPresetsBundle({ schemaVersion: 1, presets: {} })).toBe(false);
  });
});

describe("uniqueKey", () => {
  it("returns the desired key when free", () => {
    expect(uniqueKey("custom:foo", new Set())).toBe("custom:foo");
  });
  it("appends -2, -3 ... on collisions", () => {
    const set = new Set(["custom:foo"]);
    expect(uniqueKey("custom:foo", set)).toBe("custom:foo-2");
    set.add("custom:foo-2");
    expect(uniqueKey("custom:foo", set)).toBe("custom:foo-3");
  });
});
