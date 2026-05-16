// PSML 0.2 — PSML → runtime adapter.
//
// Lowers a PSML Packet to the renderer-facing runtime shape so existing
// components (DetailPanel, HybridDiagram, HexStrip, …) can consume it.
// This is the import side of the format hub: every format produces a PSML
// Packet, which then flows through here on its way to the renderer.
//
// The lowering is intentionally lossy: PSML's Repeat<Switch> over a TLV-
// like discriminator collapses to a flat "variable" field with zero bits
// when the env doesn't seed the count, mirroring the v1 default.
// Constraints don't survive lowering — the runtime model uses ad-hoc
// `controlsLength` / TLV `drivesController` plumbing instead.

import { evalExpr, MissingRefError } from "./expr";
import type {
  Container,
  Field as PsmlField,
  Group,
  Packet as PsmlPacket,
  Repeat,
  Switch,
} from "./types";
import type {
  Field as RuntimeField,
  Packet as RuntimePacket,
  SubField,
} from "./runtime-types";

function isField(c: Container): c is PsmlField {
  return !("kind" in c) || c.kind === "field";
}

function typeBits(type: PsmlField["type"]): number {
  switch (type.kind) {
    case "int":
    case "enum":
      return type.bits;
    case "bits":
      return type.n;
    case "bytes":
      // No env at lowering time — try to evaluate constants only; default 0.
      try {
        return evalExpr(type.n, new Map()) * 8;
      } catch (e) {
        if (e instanceof MissingRefError) return 0;
        throw e;
      }
    case "varint":
      // Variable-length encoding — width unknown at design-time without an
      // env override; the runtime adapter is not the right place to consult
      // one, so report 0 bits and let the renderer treat it accordingly.
      return 0;
  }
}

/** Flatten a Group whose direct children are leaf bit-fields into a runtime
 *  Field with `subfields[]`. Returns null if the group isn't representable
 *  that way (e.g. nested non-leaf children). */
function groupToSubfieldField(g: Group): RuntimeField | null {
  const subs: SubField[] = [];
  let total = 0;
  for (const child of g.children) {
    if (!isField(child)) return null;
    const bits = typeBits(child.type);
    subs.push({ id: child.id, name: child.name, bits, ...(child.doc ? { description: child.doc } : {}) });
    total += bits;
  }
  if (subs.length === 0) return null;
  return {
    id: g.id,
    name: g.name ?? g.id,
    bits: total,
    subfields: subs,
  };
}

function repeatToVariableField(r: Repeat): RuntimeField {
  return {
    id: r.id,
    name: r.name ?? r.id,
    variable: true,
    lengthFrom: `${r.id}_count`,
    formula: "psml_repeat",
    toBits: () => 0,
    ...(r.category ? { category: r.category } : {}),
    ...(r.doc ? { description: r.doc } : {}),
  };
}

function switchToVariableField(s: Switch): RuntimeField {
  // Lone Switch — render as a 0-bit placeholder; the diagram still surfaces
  // the field name. Real coverage comes from being wrapped in a Repeat.
  return {
    id: s.id,
    name: s.name ?? s.id,
    bits: 0,
    ...(s.doc ? { description: s.doc } : {}),
  };
}

/**
 * Lower a PSML Packet to the runtime Packet shape consumed by the renderer.
 * Repeat/Switch/Group are flattened to runtime equivalents; constraints are
 * dropped because the runtime model uses ad-hoc controller plumbing.
 */
export function psmlToRuntime(packet: PsmlPacket): RuntimePacket {
  const fields: RuntimeField[] = [];
  for (const c of packet.body) {
    if (isField(c)) {
      fields.push({
        id: c.id,
        name: c.name,
        bits: typeBits(c.type),
        ...(c.category ? { category: c.category } : {}),
        ...(c.doc ? { description: c.doc } : {}),
        ...(c.defaultValue !== undefined ? { defaultValue: c.defaultValue } : {}),
      });
      continue;
    }
    if (c.kind === "group") {
      const flat = groupToSubfieldField(c);
      if (flat) fields.push(flat);
      else for (const child of c.children) {
        // Splice nested non-leaf groups inline by reusing the lowering path
        // through a synthetic packet — simpler than mutual recursion.
        const sub = psmlToRuntime({ name: c.name ?? c.id, rowBits: packet.rowBits, body: [child] });
        fields.push(...sub.fields);
      }
      continue;
    }
    if (c.kind === "repeat") {
      fields.push(repeatToVariableField(c));
      continue;
    }
    if (c.kind === "switch") {
      fields.push(switchToVariableField(c));
      continue;
    }
  }
  return {
    name: packet.name,
    rowBits: packet.rowBits,
    fields,
    ...(packet.description ? { description: packet.description } : {}),
    ...(packet.byteOrder ? { byteOrder: packet.byteOrder } : {}),
  };
}
