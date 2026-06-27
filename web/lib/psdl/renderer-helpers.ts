// PSDL 0.3 — renderer-side helpers.
//
// Utility functions operating against the renderer-shaped Packet/Field model
// in `./renderer.ts`. After Round 6 the diagram layout always goes through
// `resolveLayout` (PSDL), so this file only retains the helpers needed by
// the UI's editing affordances: controller-state seeding, TLV record-bit
// arithmetic, chain resolution, and per-packet category enumeration.

import type {
  ChainBlock,
  ControllerState,
  Field,
  Packet,
  ResolvedTlv,
  TlvBlock,
  TlvCatalogEntry,
  TlvCatalogField,
  TlvInstance,
} from "./renderer";

/**
 * Validate renderer-Packet structural invariants:
 *   - subfield bit sums must match parent's bit width;
 *   - subfields cannot appear on variable-length fields;
 *   - subfields cannot coexist with TLV containers;
 *   - TLV containers must have a non-empty catalog.
 */
export function validatePacket(packet: Packet): void {
  for (const field of packet.fields) {
    if (field.subfields) {
      if (field.variable) {
        throw new Error(
          `Packet "${packet.name}": field "${field.id}" is variable-length and cannot have subfields.`,
        );
      }
      if (field.tlv) {
        throw new Error(
          `Packet "${packet.name}": field "${field.id}" cannot have both subfields and a TLV container.`,
        );
      }
      const sum = field.subfields.reduce((acc, sf) => acc + sf.bits, 0);
      if (typeof field.bits !== "number" || sum !== field.bits) {
        throw new Error(
          `Packet "${packet.name}": subfields of "${field.id}" sum to ${sum} bits ` +
            `but parent declares ${field.bits ?? "?"} bits.`,
        );
      }
      for (const sf of field.subfields) {
        if (!Number.isInteger(sf.bits) || sf.bits <= 0) {
          throw new Error(
            `Packet "${packet.name}": subfield "${field.id}.${sf.id}" must have positive integer bits.`,
          );
        }
      }
    }
    if (field.tlv) {
      if (!Array.isArray(field.tlv.catalog) || field.tlv.catalog.length === 0) {
        throw new Error(
          `Packet "${packet.name}": field "${field.id}" has tlv but empty catalog.`,
        );
      }
    }
  }
}

function catalogFieldsFor(
  entry: TlvCatalogEntry,
  extras: Record<string, number>,
): TlvCatalogField[] {
  if (typeof entry.fieldsFor === "function") {
    return entry.fieldsFor(extras);
  }
  return entry.fields ?? [];
}

/** Resolve a TLV field given its current instances. */
export function resolveTlv(
  field: Field,
  instances: TlvInstance[] | undefined,
): ResolvedTlv {
  if (!field || !field.tlv) return { totalBits: 0, blocks: [] };
  const blocks: TlvBlock[] = [];
  let totalBits = 0;
  const catalogByKind = new Map<number, TlvCatalogEntry>(
    field.tlv.catalog.map((c) => [c.kind, c]),
  );

  for (const inst of instances ?? []) {
    const entry = catalogByKind.get(inst.kind);
    if (!entry) continue;
    const extras: Record<string, number> = {
      ...(entry.defaultExtras ?? {}),
      ...(inst.extras ?? {}),
    };
    const blockFields = catalogFieldsFor(entry, extras);
    if (!blockFields || blockFields.length === 0) continue;
    const bits = blockFields.reduce((acc, f) => acc + f.bits, 0);
    blocks.push({
      kind: entry.kind,
      name: entry.name,
      bits,
      fields: blockFields,
      extras,
      description: entry.description ?? "",
      variableCount: entry.variableCount ?? null,
    });
    totalBits += bits;
  }

  const pad = field.tlv.padToBoundary ?? 0;
  if (pad > 0 && totalBits % pad !== 0) {
    const padBits = pad - (totalBits % pad);
    blocks.push({
      kind: null,
      name: "Padding",
      bits: padBits,
      fields: [{ id: "padding", name: "Padding", bits: padBits }],
      extras: {},
      description:
        "Zero-bit padding inserted to round the TLV block up to the required boundary.",
      isPadding: true,
    });
    totalBits += padBits;
  }
  return { totalBits, blocks };
}

/**
 * Compute the controller value driven by a TLV field's current instances.
 */
export function tlvControllerValue(
  field: Field,
  instances: TlvInstance[] | undefined,
): number | null {
  if (!field || !field.tlv || !field.tlv.drivesController) return null;
  const { totalBits } = resolveTlv(field, instances);
  const bytes = Math.ceil(totalBits / 8);
  const unit = field.tlv.bytesPerUnit ?? 1;
  const base = field.tlv.baseControllerValue ?? 0;
  return base + Math.ceil(bytes / unit);
}

/** Resolve a chain (IPv6 ext headers) into per-instance block descriptors. */
export function resolveChain(packet: Packet): ChainBlock[] {
  const out: ChainBlock[] = [];
  for (const field of packet.fields) {
    if (!field.chainCatalog || !field.chainInstances) continue;
    const catalogByProto = new Map<
      number,
      NonNullable<Field["chainCatalog"]>[number]
    >(field.chainCatalog.map((c) => [c.proto, c]));
    for (let i = 0; i < field.chainInstances.length; i++) {
      const inst = field.chainInstances[i];
      const entry = catalogByProto.get(inst.proto);
      if (!entry) continue;
      const bits = entry.fields.reduce((acc, f) => acc + f.bits, 0);
      out.push({
        chainOwnerFieldId: field.id,
        chainIndex: i,
        proto: entry.proto,
        name: entry.name,
        bits,
        fields: entry.fields,
        description: entry.description ?? "",
      });
    }
  }
  return out;
}

/** Initial controller state from each field's defaultValue, then synced
 *  against any current TLV / chain instances. */
export function initialState(packet: Packet): ControllerState {
  const state: ControllerState = {};
  for (const field of packet.fields) {
    if (field.controlsLength) {
      state[field.controlsLength] = field.defaultValue ?? 0;
    }
  }
  // Seed a default iteration count for plain (non-TLV/non-chain) repeats that
  // declare one, so the diagram shows a representative record on load instead
  // of an empty section (e.g. lldp's body is a single until-repeat → otherwise
  // a blank diagram). Seeded via initialState, which feeds BOTH the active
  // controllers and the share-url default set, so it stays out of the URL.
  for (const fr of packet.freeRepeats ?? []) {
    if (fr.defaultCount !== undefined && state[fr.countKey] === undefined) {
      state[fr.countKey] = fr.defaultCount;
    }
  }
  // Seed the discriminator for record-variant / peek pickers to their first
  // case, so the picker label agrees with the diagram on load. Without this the
  // discriminator 0-fills to 0 (often the `_` default arm or an absent variant)
  // while the picker shows cases[0] — a label/diagram contradiction
  // (override-design-audit). Also share-url-safe (same default-set reasoning).
  for (const rs of packet.refSwitches ?? []) {
    if (state[rs.refKey] === undefined && rs.cases[0]) {
      state[rs.refKey] = rs.cases[0].value;
    }
  }
  for (const ps of packet.peekSwitches ?? []) {
    if (state[ps.peekKey] === undefined && ps.cases[0]) {
      state[ps.peekKey] = ps.cases[0].value;
    }
  }
  syncTlvControllers(packet, state);
  // `syncChainControllers` now returns a fresh object so callers that
  // depend on reference equality see the update; for the bootstrap
  // path we still want a single state — chain it through.
  return syncChainControllers(packet, state);
}

/** Recompute every TLV-driven controller against the current instances. */
export function syncTlvControllers(
  packet: Packet,
  state: ControllerState,
): ControllerState {
  for (const field of packet.fields) {
    if (field.tlv && field.tlv.drivesController) {
      const v = tlvControllerValue(field, field.tlv.instances ?? []);
      if (v != null) state[field.tlv.drivesController] = v;
    }
  }
  return state;
}

/** Recompute renderer chain-derived env keys used by PSDL Repeat<Switch>.
 *
 *  Returns a *new* ControllerState object so React's reference-equality
 *  reconciler (and downstream `useMemo([... controllers])` callers) see
 *  the update. The earlier in-place mutation form returned the same
 *  `state` reference and silently kept `layout` cached against the
 *  pre-edit env — Chain edits applied to controllers internally but
 *  never reached the diagram (Codex P1).
 */
export function syncChainControllers(
  packet: Packet,
  state: ControllerState,
): ControllerState {
  const next: ControllerState = { ...state };
  for (const field of packet.fields) {
    if (!field.chainCatalog) continue;

    const instances = field.chainInstances ?? [];
    const baseId = field.id.endsWith("_chain")
      ? field.id.slice(0, -"_chain".length)
      : field.id;
    const proto = instances[0]?.proto ?? field.chainFinalProto ?? 59;

    next[`${field.id}Count`] = instances.length;
    next[`${field.id}_chainCount`] = instances.length;
    next[`${baseId}_chainCount`] = instances.length;
    next[`${field.id}_proto`] = proto;
    next[`${baseId}_proto`] = proto;
  }
  return next;
}

/** Effective field list for a TLV catalog entry given an instance. */
export function resolveTlvFields(
  entry: TlvCatalogEntry,
  inst: TlvInstance,
): TlvCatalogField[] {
  const extras = { ...(entry.defaultExtras || {}), ...(inst.extras || {}) };
  if (typeof entry.fieldsFor === "function") {
    return entry.fieldsFor(extras) || [];
  }
  return entry.fields || [];
}

/** Total bit width of one TLV record. */
export function tlvRecordBits(
  entry: TlvCatalogEntry,
  inst: TlvInstance,
): number {
  return resolveTlvFields(entry, inst).reduce((acc, f) => acc + f.bits, 0);
}

/** Total bit width of all instances + optional padding. */
export function tlvTotalBits(field: Field): {
  totalBits: number;
  paddedBits: number;
} {
  if (!field.tlv) return { totalBits: 0, paddedBits: 0 };
  const { catalog, instances, padToBoundary } = field.tlv;
  const byKind = new Map(catalog.map((c) => [c.kind, c]));
  let total = 0;
  for (const inst of instances) {
    const entry = byKind.get(inst.kind);
    if (!entry) continue;
    total += tlvRecordBits(entry, inst);
  }
  const padded =
    padToBoundary && padToBoundary > 0 && total % padToBoundary !== 0
      ? total + (padToBoundary - (total % padToBoundary))
      : total;
  return { totalBits: total, paddedBits: padded };
}

/** Categories present in the packet, in first-appearance order. */
export function packetCategories(packet: Packet): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const field of packet.fields) {
    if (field.category && !seen.has(field.category)) {
      seen.add(field.category);
      out.push(field.category);
    }
  }
  return out;
}
