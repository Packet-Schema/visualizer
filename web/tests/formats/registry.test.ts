// FormatAdapter registry — exercises the wrapper layer that lib/formats/*
// modules are routed through. The underlying codecs are covered by their
// own test files; here we confirm the registry surface contracts hold.

import { describe, expect, it } from "vitest";

import {
  EXPORTABLE_FORMATS,
  FORMATS,
  IMPORTABLE_FORMATS,
  extToFormat,
  getFormat,
  type FormatKey,
} from "../../lib/formats/registry";
import { PRESETS } from "../../lib/psdl/presets";

describe("format registry shape", () => {
  it("exposes every format with id, label, extension and mime", () => {
    expect(FORMATS.length).toBeGreaterThan(0);
    for (const f of FORMATS) {
      expect(typeof f.id).toBe("string");
      expect(typeof f.label).toBe("string");
      expect(f.extension).toMatch(/^[\w.]+$/);
      expect(f.mime).toMatch(/\//);
    }
  });

  it("computes the importable / exportable subsets", () => {
    expect(IMPORTABLE_FORMATS).toEqual(
      FORMATS.filter((f) => !!f.parse).map((f) => f.id),
    );
    expect(EXPORTABLE_FORMATS).toEqual(
      FORMATS.filter((f) => f.exportable === true || !!f.render).map(
        (f) => f.id,
      ),
    );
    // AAD is import-only, rfc-ascii is export-only.
    expect(IMPORTABLE_FORMATS).toContain("aug-ascii");
    expect(EXPORTABLE_FORMATS).not.toContain("aug-ascii");
    expect(EXPORTABLE_FORMATS).toContain("rfc-ascii");
    expect(IMPORTABLE_FORMATS).not.toContain("rfc-ascii");
    expect(EXPORTABLE_FORMATS).toContain("svg");
    expect(EXPORTABLE_FORMATS).toContain("png");
  });

  it("looks up adapters by id and throws on unknown", () => {
    expect(getFormat("json").id).toBe("json");
    expect(getFormat("ksy").label).toContain("Kaitai");
    expect(() => getFormat("nope" as FormatKey)).toThrow(/Unknown format/);
  });
});

describe("extToFormat", () => {
  it("matches each format's canonical extension", () => {
    for (const f of FORMATS) {
      expect(extToFormat(`packet.${f.extension}`)).toBe(f.id);
    }
  });

  it("prefers the longer compound extension (.psdl.json over .json)", () => {
    expect(extToFormat("foo.psdl.json")).toBe("json");
  });

  it("falls back to the friendly .json alias", () => {
    expect(extToFormat("anything.json")).toBe("json");
  });

  it("returns null for non-strings and unknown extensions", () => {
    expect(extToFormat("noext")).toBeNull();
    expect(extToFormat("foo.bin")).toBeNull();
    expect(extToFormat(undefined as unknown as string)).toBeNull();
  });
});

describe("adapter wrappers — round-trip", () => {
  it("JSON parse round-trips the env produced by render", () => {
    const json = getFormat("json").render!(PRESETS.ipv4, new Map());
    const parsed = getFormat("json").parse!(json);
    expect(parsed.packet.name).toBe(PRESETS.ipv4.name);
    expect(parsed.env).toBeDefined();
  });

  it("KSY parse exposes warnings array", () => {
    const ksy = getFormat("ksy").render!(PRESETS.ipv4, new Map());
    const parsed = getFormat("ksy").parse!(ksy);
    expect(parsed.packet).toBeDefined();
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });

  it("rfc-ascii is export-only (no parse)", () => {
    expect(getFormat("rfc-ascii").parse).toBeUndefined();
    // Ethernet has no Repeat / Switch refs so the env can be empty.
    const text = getFormat("rfc-ascii").render!(PRESETS.ethernet, new Map());
    // The output is a bit-ruler diagram; we just need to verify rendering
    // succeeded with non-empty output.
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("+");
  });

  it("aug-ascii is import-only (no render)", () => {
    expect(getFormat("aug-ascii").render).toBeUndefined();
    expect(getFormat("aug-ascii").parse).toBeDefined();
    const aad = `
A Frame is formatted as follows:

 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|     Source Address            |          Checksum             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
`;
    const result = getFormat("aug-ascii").parse!(aad);
    expect(result.packet.body.length).toBe(2);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("svg/png are export-only selector entries without text renderers", () => {
    expect(getFormat("svg").render).toBeUndefined();
    expect(getFormat("png").render).toBeUndefined();
    expect(getFormat("svg").exportable).toBe(true);
    expect(getFormat("png").exportable).toBe(true);
  });
});
