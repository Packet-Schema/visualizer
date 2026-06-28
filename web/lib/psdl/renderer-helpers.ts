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
  SubField,
  TlvBlock,
  TlvCatalogEntry,
  TlvCatalogField,
  TlvInstance,
} from "./renderer";
import {
  BER_LENGTH_DEFAULT_BITS,
  DELIMITED_DEFAULT_BYTES,
  VARINT_DEFAULT_BITS,
} from "./dynamic-width-defaults";
import { berLenEnvKey } from "./normalize";

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
  // Seed the SAME dynamic-width default the diagram layout seeds
  // (`seedDynamicWidthDefaults`) into the bootstrap `controllers` state, so the
  // OverridePanel WidthPicker's active option matches the rendered cell on load.
  // Without this the picker falls back to `pickerWidths(target)[0]` — 1 byte for
  // a delimiter-terminated `bytes` field — while the diagram already shows the
  // seeded 4-byte cell, an inert-looking control that contradicts the diagram
  // until the user clicks (syslog's pri/version/… delimited fields). A field
  // that is ALSO a switch discriminator (`switchCases`) overloads env[id] for
  // the case value, so it is skipped here exactly as `collectSwitchOnRefIds`
  // carves it out in the layout seed. Only fills an unset key, so a user /
  // saved-env width still wins, and (via `nonDefaultControllerEnv`) it stays out
  // of the share URL.
  const seedDynamicWidth = (f: Field | SubField): void => {
    if (f.switchCases) return;
    // A berLength's wire width lives on the DEDICATED `__berLen__<id>` key (its
    // bare key can carry the length VALUE that sizes a sibling `bytes(ref id)`);
    // the WidthPicker drives the same key, so seed there to keep the picker's
    // active option in step with the seeded octet cell. Mirrors the dedicated-key
    // seed in `seedDynamicWidthDefaults`.
    if (f.isBerLength) {
      const key = berLenEnvKey(f.id);
      if (state[key] === undefined) state[key] = BER_LENGTH_DEFAULT_BITS;
      return;
    }
    if (state[f.id] !== undefined) return;
    if (f.isDelimited) state[f.id] = DELIMITED_DEFAULT_BYTES;
    else if (f.varintEncoding) state[f.id] = VARINT_DEFAULT_BITS;
  };
  for (const field of packet.fields) {
    seedDynamicWidth(field);
    for (const sub of field.subfields ?? []) seedDynamicWidth(sub);
  }
  // Dynamic-width leaves nested inside a Switch case / Repeat element / Group
  // never reach `packet.fields`, so the loop above can't seed them. The diagram
  // layout DOES seed them (`seedDynamicWidthDefaults`), so without this the
  // WidthPicker's active option (`controllers[id] ?? widths[0]` -> 1B for
  // delimited) would contradict the seeded ~4-byte diagram cell on load (tftp's
  // rrqFilename/rrqMode/wrqFilename/wrqMode/errMsg). `psdlToRenderer` collected
  // these ids (switch-`on:ref` discriminators already carved out). Only fills an
  // unset key, so a user / saved-env width still wins and it stays out of the
  // share URL (via `nonDefaultControllerEnv`).
  for (const leaf of packet.dynamicWidthLeaves ?? []) {
    // berLength seeds its DEDICATED width key (see seedDynamicWidth above);
    // varint/delimited seed their bare value key (bridged in layout.ts).
    const key = leaf.kind === "berLength" ? berLenEnvKey(leaf.id) : leaf.id;
    if (state[key] !== undefined) continue;
    state[key] =
      leaf.kind === "berLength"
        ? BER_LENGTH_DEFAULT_BITS
        : leaf.kind === "delimited"
          ? DELIMITED_DEFAULT_BYTES
          : VARINT_DEFAULT_BITS;
  }
  // Packet-level length controllers (bounded scopes whose length field is
  // group-nested) seed the same way as top-level controlsLength fields.
  for (const lc of packet.lengthControllers ?? []) {
    if (lc.controlsLength) {
      state[lc.controlsLength] = lc.defaultValue ?? 0;
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
    // Seed a representative PER-RECORD length (isisLsp's `tlvLength`) so the
    // picked record-variant arm's `bytes(ref length)` Value renders non-empty
    // instead of width 0. Without this the picker would be inert — selecting any
    // tlvType yields a byte-identical (empty) record. Only fills unset/0 so a
    // user width still wins; share-url-safe (same default-set reasoning).
    for (const seed of rs.lengthSeeds ?? []) {
      if (!state[seed.key]) state[seed.key] = seed.value;
    }
  }
  for (const ps of packet.peekSwitches ?? []) {
    if (state[ps.peekKey] === undefined && ps.cases[0]) {
      state[ps.peekKey] = ps.cases[0].value;
    }
  }
  // Seed the message-type discriminator a switch-case-nested freeRepeat is gated
  // on (icmpv6Ndp's `type`) to its owning case value, so the chosen arm — and
  // ONLY that arm — is rendered and its surfaced "Type=N → Options" stepper
  // agrees with the diagram on load. Without this `type` 0-fills to 0, the
  // ndpBody switch takes its `_` default arm, NONE of the per-case Options
  // repeats instantiate, and every surfaced stepper (plus the peek picker) reads
  // as live over a diagram with ZERO option records (a panel-vs-diagram
  // contradiction). OverridePanel surfaces only the gated steppers whose
  // discriminator matches, so the surfaced count always agrees with the rendered
  // records. Runs AFTER the refSwitch / peekSwitch loops so when a discriminator
  // ALSO has its own picker (dnsResponse's `dnsRrType`) the picker's cases[0]
  // seed wins and the gated SOA steppers stay hidden until that record type is
  // picked — only an unset discriminator (icmpv6Ndp's pickerless `type`) takes
  // the gate seed. The FIRST gated repeat for a given key wins. Only fills an
  // unset discriminator (a user / saved-env value still wins) and is
  // share-url-safe (same default-set reasoning as the seeds above).
  for (const fr of packet.freeRepeats ?? []) {
    if (fr.gate && state[fr.gate.key] === undefined) {
      state[fr.gate.key] = fr.gate.value;
    }
  }
  // Seed the PER-RECORD inner-scope length of a TLV-extension boundedRepeat
  // (tlsClientHello's `extLen`) so the representative record fits its own nested
  // bounded. Without this the inner length 0-fills to 0 and the budget-derived
  // record over-consumes the empty inner scope (a frozen diagram). Seeded only
  // when unset/0 — a user width still wins — and share-url-safe (same
  // default-set reasoning as the discriminator seeds above).
  for (const br of packet.boundedRepeats ?? []) {
    for (const seed of br.innerScopeSeeds ?? []) {
      if (!state[seed.key]) state[seed.key] = seed.value;
    }
    // Seed the OUTER boundedRepeat budget so ONE representative record renders
    // at load. Without this the outer length (tlsClientHello's `extensionsLen`)
    // 0-fills → `floor(0/perRecord)=0` records → the surfaced refSwitch variant
    // picker (extType) is INERT and contradicts an empty diagram (#11/#12).
    // Only set when unset/0 — a user width still wins — and surfaced via
    // initialState, so it stays out of the share URL (same default-set reasoning
    // as the innerScopeSeeds / freeRepeat defaultCount / discriminator seeds).
    if (br.defaultLength !== undefined && !state[br.lengthKey]) {
      state[br.lengthKey] = br.defaultLength;
    }
  }
  syncTlvControllers(packet, state);
  // `syncChainControllers` now returns a fresh object so callers that
  // depend on reference equality see the update; for the bootstrap
  // path we still want a single state — chain it through.
  return syncChainControllers(packet, state);
}

/**
 * The non-default subset of `controllers` relative to a renderer Packet's
 * seeded defaults — the same delta Share embeds in its URL (see
 * `buildShareUrl`'s `defaultControllers` skip). Used by "Save as preset" to
 * bake only the user's actual edits into the persisted packet's `env`, so a
 * reload restores e.g. `dnsAnCount=3` without freezing every default value.
 * Returns `undefined` when nothing differs from defaults (so callers can omit
 * an empty `env` block entirely).
 */
export function nonDefaultControllerEnv(
  packet: Packet,
  controllers: ControllerState,
): Record<string, number> | undefined {
  const defaults = initialState(packet);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(controllers)) {
    if (!Number.isFinite(value)) continue;
    if (defaults[key] === value) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Merge a persisted packet `env` block back onto a renderer Packet's seeded
 * defaults, producing the controller state to hydrate on load. Mirrors the
 * Share path's `{ ...initialState(...), ...parsed.controllers }` precedence:
 * saved env values win over defaults, and keys that `initialState` does not
 * seed (freeRepeat counts, refSwitch / peek discriminator picks) are still
 * carried so the user's choices come back.
 */
export function controllersFromEnv(
  packet: Packet,
  env: Record<string, number> | undefined,
): ControllerState {
  const state = initialState(packet);
  if (!env) return state;
  for (const [key, value] of Object.entries(env)) {
    if (Number.isFinite(value)) state[key] = value;
  }
  return state;
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
