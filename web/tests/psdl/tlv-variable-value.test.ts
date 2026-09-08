// tlv-variable-value (critical): a TLV-shaped Repeat<Switch> case arm whose
// VALUE is a variable-length `bytes(ref L)` / delimited / varint member
// (dhcpv4 Code=3 `routerAddresses` = bytes(ref optionLength); tlsClientHelloFull
// / tlsExtensionsBlock extension data). `typeBits` cannot size such a member at
// design time → the catalog field got `bits: 0`, and `applyTlvInstances`
// materialised it as a literal `{kind:'bits', n:0}` field: a permanently
// zero-width, INVISIBLE value with NO per-instance control. The user could see
// the option in the catalog and a row in the diagram but the entire variable
// payload was un-renderable and un-editable — a "see-but-cannot-edit" bar
// violation on real built-in presets.
//
// The fix detects a variable-length value arm in `structToTlvCatalogShape`
// (shared.ts) and emits a `variableBytes` byte-count knob (keyed in
// `TlvInstance.extras`, defaulted via `defaultExtras`) plus a `fieldsFor`
// closure that sizes the value. `applyTlvInstances` resolves fields through
// `resolveTlvFields(entry, inst)` so the value materialises as a VISIBLE,
// non-zero-width cell, and TlvEditor surfaces the byte-count input.
//
// This test pins: the catalog carries the knob, an added instance renders a
// non-zero Value cell after `applyTlvInstances` + `resolveLayout`, editing the
// extra resizes the cell, and the extra round-trips through PSDL.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  psdlToRenderer,
  rendererToPsdl,
  applyTlvInstances,
} from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { controllersFromEnv } from "@/lib/psdl/renderer-helpers";
import type { Cell } from "@/lib/psdl/renderer";

/** All leaf field descriptors in a resolved layout (top-level + group subfields),
 *  matching a substring of the field id. */
function fieldsMatching(layout: { cells: Cell[] }, idPart: string) {
  const out: { id: string; bits: number }[] = [];
  for (const cell of layout.cells) {
    const f = cell.field;
    if (!f) continue;
    const consider = [f, ...(f.subfields ?? [])];
    for (const sf of consider) {
      if (String(sf.id).includes(idPart)) {
        out.push({ id: sf.id, bits: sf.bits ?? 0 });
      }
    }
  }
  return out;
}

function layoutForMirror(
  presetKey: string,
  mutate: (mirror: ReturnType<typeof psdlToRenderer>) => void,
) {
  const preset = PRESETS[presetKey];
  if (!preset) throw new Error(`missing preset ${presetKey}`);
  const mirror = psdlToRenderer(preset);
  mutate(mirror);
  const base = rendererToPsdl(mirror);
  const applied = applyTlvInstances(base, mirror, {});
  const env = controllersFromEnv(mirror, undefined);
  const layout = resolveLayout(applied, {
    env: new Map(Object.entries(env)),
  });
  return { mirror, applied, layout };
}

describe("TLV variable-length value renders and is editable", () => {
  it("dhcpv4 Code=3 catalog carries a variableBytes knob keyed to optionLength", () => {
    const mirror = psdlToRenderer(PRESETS.dhcpv4!);
    const opts = mirror.fields.find((f) => f.id === "options");
    if (!opts?.tlv) throw new Error("dhcpv4 options field missing tlv");
    const kind3 = opts.tlv.catalog.find((e) => e.kind === 3);
    expect(kind3, "Code=3 Router option present").toBeDefined();
    // The variable value field is in the catalog at bits:0 (static width
    // unknowable) but now carries a byte-count knob + a default.
    const ra = kind3!.fields?.find((f) => f.id === "routerAddresses");
    expect(ra?.bits).toBe(0);
    const vb = kind3!.variableBytes?.find(
      (v) => v.fieldId === "routerAddresses",
    );
    expect(vb, "routerAddresses has a variableBytes knob").toBeDefined();
    expect(vb!.lengthFieldId).toBe("optionLength");
    expect(kind3!.defaultExtras?.[vb!.key]).toBeGreaterThan(0);
    expect(typeof kind3!.fieldsFor).toBe("function");
  });

  it("renders a non-zero Value cell for dhcpv4 Code=3 after adding an instance", () => {
    const { layout } = layoutForMirror("dhcpv4", (mirror) => {
      const opts = mirror.fields.find((f) => f.id === "options")!;
      const entry = opts.tlv!.catalog.find((e) => e.kind === 3)!;
      // Mirror the TlvEditor "Add" path: seed defaultExtras onto the instance.
      opts.tlv!.instances = [
        { kind: 3, extras: { ...(entry.defaultExtras ?? {}) } },
      ];
    });
    const ra = fieldsMatching(layout, "routerAddresses");
    expect(ra.length, "routerAddresses cell rendered").toBeGreaterThan(0);
    // The whole point: a VISIBLE, non-zero-width value cell.
    expect(ra.every((f) => f.bits > 0)).toBe(true);
  });

  it("editing the byte-count extra resizes the rendered Value cell", () => {
    const widthFor = (bytes: number) => {
      const { layout } = layoutForMirror("dhcpv4", (mirror) => {
        const opts = mirror.fields.find((f) => f.id === "options")!;
        opts.tlv!.instances = [
          { kind: 3, extras: { routerAddresses__bytes: bytes } },
        ];
      });
      const ra = fieldsMatching(layout, "routerAddresses");
      return ra[0]?.bits ?? 0;
    };
    expect(widthFor(4)).toBe(32);
    expect(widthFor(8)).toBe(64);
  });

  it("round-trips the byte-count extra through PSDL", () => {
    const mirror = psdlToRenderer(PRESETS.dhcpv4!);
    const opts = mirror.fields.find((f) => f.id === "options")!;
    opts.tlv!.instances = [{ kind: 3, extras: { routerAddresses__bytes: 12 } }];
    const psdl = rendererToPsdl(mirror);
    const re = psdlToRenderer(psdl);
    const opts2 = re.fields.find((f) => f.id === "options")!;
    expect(opts2.tlv!.instances).toEqual([
      { kind: 3, extras: { routerAddresses__bytes: 12 } },
    ]);
    // And it still sizes a non-zero cell after the round-trip.
    const base = rendererToPsdl(re);
    const applied = applyTlvInstances(base, re, {});
    const env = controllersFromEnv(re, undefined);
    const layout = resolveLayout(applied, {
      env: new Map(Object.entries(env)),
    });
    const ra = fieldsMatching(layout, "routerAddresses");
    expect(ra.some((f) => f.bits === 96)).toBe(true); // 12 bytes
  });

  it("surfaces the same knob for tlsClientHelloFull / tlsExtensionsBlock", () => {
    for (const key of ["tlsClientHelloFull", "tlsExtensionsBlock"]) {
      const preset = PRESETS[key];
      if (!preset) continue;
      const mirror = psdlToRenderer(preset);
      // Find any TLV field whose catalog has a variable value member.
      const withVar = mirror.fields.find((f) =>
        f.tlv?.catalog.some((e) => (e.variableBytes?.length ?? 0) > 0),
      );
      expect(
        withVar,
        `${key} should expose a variable-value TLV knob`,
      ).toBeDefined();
      const tlvField = withVar!;
      const entry = tlvField.tlv!.catalog.find(
        (e) => (e.variableBytes?.length ?? 0) > 0,
      )!;
      // Adding such a record renders a non-zero value cell for the variable
      // member (whatever its id is).
      const vb = entry.variableBytes![0];
      tlvField.tlv!.instances = [
        { kind: entry.kind, extras: { ...(entry.defaultExtras ?? {}) } },
      ];
      const base = rendererToPsdl(mirror);
      const applied = applyTlvInstances(base, mirror, {});
      const env = controllersFromEnv(mirror, undefined);
      const layout = resolveLayout(applied, {
        env: new Map(Object.entries(env)),
      });
      const cells = fieldsMatching(layout, vb.fieldId);
      expect(
        cells.some((f) => f.bits > 0),
        `${key} variable member ${vb.fieldId} renders a visible cell`,
      ).toBe(true);
    }
  });
});
