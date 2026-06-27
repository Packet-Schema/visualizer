// TLV expansion: rewrite a PSDL body's TLV `Repeat<Switch>` into one of
// three shapes depending on the renderer mirror's `tlv.instances` and the
// caller-supplied `slotBytes` map (= the size of the Options *slot*
// derived from the upstream length controller, e.g. `(IHL − 5) × 4` for
// IPv4).
//
// Three stages mirror the user-facing workflow:
//
//   1. **Slot only** (`instances.length === 0` and `slotBytes > 0`)
//      Emit ONE placeholder `bytes(slotBytes)` Field carrying the TLV's
//      id. The diagram shows a single empty "Options" cell. Clicking it
//      lands on `packet.fields[tlvId]` (which still has the catalog) so
//      OverridePanel opens TlvEditor → user picks which Option records
//      to fill the slot with.
//
//   2. **Populated** (`instances.length > 0`)
//      Emit one PSDL `Group` per instance. Layout collapses each Group
//      into a single cell whose `subCells[]` shows the variant's
//      Type / Length / etc. internals. When the instances total < slot,
//      a trailing `bytes(remaining)` placeholder fills the rest so the
//      slot visually closes at the controller boundary.
//
//   3. **Neither** (no instances and no slot — e.g. IHL = 5 on IPv4)
//      Keep the original Repeat so normalize falls back to env-driven
//      iteration (currently 0 → no cells at all). No mutation needed.

import type {
  Container,
  Field as PsdlField,
  Group as PsdlGroup,
  Packet as PsdlPacket,
} from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";

export type TlvSlotBytes = Record<string, number>;

// Does the body collapse, modulo transparent wire-scopes (bounded / group /
// optional), to a SINGLE cell-producing container that is a TLV Repeat — with
// no other header fields, switches, or non-TLV repeats alongside it? That is
// the `tlsExtensionsBlock` shape: a body that is entirely one
// `repeat{count:eos, element:[switch on peek]}`. Such a body renders blank at
// load (Stage 3) because there is nothing else to draw, so we seed a
// representative default slot. Presets like IPv4/TCP, whose options Repeat
// sits among many header fields, fail this check and keep Stage-3 behaviour.
function bodyIsSoleTlvRepeat(
  body: Container[],
  tlvByRepeatId: Map<string, NonNullable<RendererField["tlv"]>>,
): boolean {
  // Count cell-producing leaves: a TLV repeat counts as a TLV leaf, anything
  // else (plain field, switch, encrypted, non-TLV repeat) counts as "other".
  let tlvLeaves = 0;
  let otherLeaves = 0;
  const walk = (containers: Container[]): void => {
    for (const c of containers) {
      switch (c.kind) {
        case "bounded":
          walk(c.fields);
          break;
        case "group":
          walk(c.children);
          break;
        case "optional":
          walk([c.container]);
          break;
        case "repeat":
          if (tlvByRepeatId.has(c.id)) tlvLeaves++;
          else otherLeaves++;
          break;
        default:
          otherLeaves++;
          break;
      }
    }
  };
  walk(body);
  return tlvLeaves === 1 && otherLeaves === 0;
}

// Byte size of a TLV catalog entry's fixed (byte-aligned, positive-width)
// fields. Used to seed a representative Stage-1 slot for a body-dominating
// TLV Repeat that would otherwise render nothing at load. Variable members
// (`bytes:ref`, varint, …) collapse to width 0 in the catalog, so they
// contribute nothing here; we only need a positive byte count for the
// placeholder. Falls back to 1 so the slot is always > 0.
function catalogEntryFixedBytes(
  entry: NonNullable<RendererField["tlv"]>["catalog"][number],
): number {
  const bits = (entry.fields ?? []).reduce(
    (a, f) => a + (f.bits > 0 ? f.bits : 0),
    0,
  );
  return Math.max(1, Math.ceil(bits / 8));
}

export function applyTlvInstances(
  psdl: PsdlPacket,
  mirror: RendererPacket,
  slotBytes: TlvSlotBytes = {},
): PsdlPacket {
  const tlvByRepeatId = new Map<string, NonNullable<RendererField["tlv"]>>();
  for (const f of mirror.fields) {
    if (f.tlv) tlvByRepeatId.set(f.id, f.tlv);
  }
  if (tlvByRepeatId.size === 0) return psdl;

  // Seed a representative default slot for a TLV Repeat that constitutes the
  // ENTIRE body (e.g. the `tlsExtensionsBlock` preset: a single
  // `repeat{count:eos, element:[switch on peek]}` with no surrounding header
  // fields and no length controller). Without instances and without a slot,
  // Stage 3 below would keep the raw Repeat and normalize yields 0 cells — a
  // blank diagram at load with nothing to click. This mirrors the
  // `defaultCount` (lldp until-repeat) and `defaultLength` (tlsClientHello
  // bounded) seeds that exist elsewhere precisely to avoid a blank diagram.
  //
  // Only applied when the TLV Repeat is the body's sole cell-producing
  // container AND no slot was supplied for it — so IPv4/TCP (whose options
  // Repeat is one of many header fields, sized by an IHL/dataOffset
  // controller) keep their genuine Stage-3 "empty options" behaviour.
  const effectiveSlotBytes: TlvSlotBytes = { ...slotBytes };
  if (bodyIsSoleTlvRepeat(psdl.body, tlvByRepeatId)) {
    for (const [id, tlv] of tlvByRepeatId) {
      const hasInstances = tlv.instances.length > 0;
      const hasSlot = Math.max(0, Math.floor(slotBytes[id] ?? 0)) > 0;
      if (!hasInstances && !hasSlot && tlv.catalog.length > 0) {
        effectiveSlotBytes[id] = catalogEntryFixedBytes(tlv.catalog[0]);
      }
    }
  }
  slotBytes = effectiveSlotBytes;

  let mutated = false;

  // Will this TLV Repeat actually be rewritten (vs. left as a Repeat in
  // Stage 3 — no instances and no slot)? Mirrors the Stage-3 guard below.
  const tlvExpands = (id: string): boolean => {
    const tlv = tlvByRepeatId.get(id);
    if (!tlv) return false;
    const slot = Math.max(0, Math.floor(slotBytes[id] ?? 0));
    return !(tlv.instances.length === 0 && slot === 0);
  };

  // Does this container list (recursively through transparent scopes /
  // groups) hold a TLV Repeat that will be expanded? Used to decide whether
  // a `bounded` scope should be spliced inline (so the flattened TLV ids
  // match the renderer mirror) or kept intact.
  const containsExpandedTlv = (containers: Container[]): boolean =>
    containers.some((c) => {
      if (c.kind === "repeat") return tlvExpands(c.id);
      if (c.kind === "bounded") return containsExpandedTlv(c.fields);
      if (c.kind === "group") return containsExpandedTlv(c.children);
      if (c.kind === "optional") return containsExpandedTlv([c.container]);
      return false;
    });

  // Expand a single container into its replacement list. A TLV Repeat becomes
  // the per-instance Groups (+ placeholders); `group`s are descended so a
  // nested TLV Repeat is still found and replaced in place.
  //
  // `bounded` (e.g. IPv4's `optionsArea` wrapping the options Repeat) is a
  // PSDL 0.5 transparent wire-scope. The renderer mirror flattens it
  // (`flattenForMirror`), so the TLV id (`options`) surfaces at the top
  // level there. To keep the expanded body addressable by the same flat ids
  // — and so the per-instance Groups land where the diagram / downstream
  // walkers expect them — we splice the bounded's expanded children inline
  // here too rather than re-wrapping them. Only do so when the bounded
  // actually contains a TLV Repeat we expanded; otherwise leave it intact so
  // unrelated wire-scopes round-trip untouched.
  const expand = (c: Container): Container[] => {
    if (c.kind === "bounded") {
      // Detect whether this scope holds a TLV Repeat we will expand, so the
      // splice-vs-wrap decision keys off *this* bounded rather than the
      // shared `mutated` flag (which a prior sibling may already have set).
      const expandsHere = containsExpandedTlv(c.fields);
      const inner = c.fields.flatMap(expand);
      return expandsHere ? inner : [{ ...c, fields: inner }];
    }
    if (c.kind === "group") {
      return [{ ...c, children: c.children.flatMap(expand) }];
    }
    // `optional` (PSDL 0.5 §10.8) wraps exactly one container, which may be a
    // TLV Repeat (or a group/bounded that holds one). Descend into the wrapped
    // container so the TLV is expanded in place; otherwise the diagram would
    // show the raw Repeat. Expanding may yield multiple containers (the TLV's
    // per-instance Groups, or a spliced bounded) — since an Optional wraps a
    // single container, collapse a multi-result into a Group so the Optional
    // keeps wrapping exactly one container.
    if (c.kind === "optional") {
      const inner = expand(c.container);
      const wrapped: Container =
        inner.length === 1
          ? inner[0]
          : {
              kind: "group",
              id: `${c.id}__opt`,
              name:
                "name" in c.container
                  ? (c.container.name ?? "Options")
                  : "Options",
              children: inner,
            };
      return [{ ...c, container: wrapped }];
    }
    if (c.kind === "repeat" && tlvByRepeatId.has(c.id)) {
      const tlv = tlvByRepeatId.get(c.id)!;
      const slot = Math.max(0, Math.floor(slotBytes[c.id] ?? 0));
      const newBody: Container[] = [];

      // Stage 3: neither instances nor a slot → leave the Repeat alone.
      if (tlv.instances.length === 0 && slot === 0) {
        return [c];
      }

      mutated = true;

      // Stage 1: slot only → one empty placeholder Field of bytes(slot).
      if (tlv.instances.length === 0) {
        newBody.push({
          id: c.id,
          name: c.name ?? "Options",
          type: { kind: "bytes", n: { kind: "lit", value: slot } },
          ...(c.category ? { category: c.category } : {}),
          ...(c.doc ? { doc: c.doc } : {}),
        });
        return newBody;
      }

      // Stage 2: populated → one Group per instance.
      let instanceBytes = 0;
      for (let i = 0; i < tlv.instances.length; i++) {
        const inst = tlv.instances[i];
        const entry = tlv.catalog.find((e) => e.kind === inst.kind);
        if (!entry?.fields || entry.fields.length === 0) continue;
        const bits = entry.fields.reduce((a, f) => a + f.bits, 0);
        if (bits % 8 !== 0) {
          // The slot accounting (and the trailing "remaining" placeholder)
          // assumes byte-aligned variants. Real-world TLV catalogs all are,
          // but a bespoke preset could declare a non-aligned variant — fail
          // loudly in dev and ceil to the next byte so the diagram still
          // renders something sensible.
          console.warn(
            `[applyTlvInstances] TLV variant kind=${inst.kind} has ${bits} bits (not byte-aligned). ` +
              `Rounding up for slot accounting; consider padding the catalog entry.`,
          );
        }
        instanceBytes += Math.ceil(bits / 8);
        const groupId = `${c.id}__inst_${i}`;
        const group: PsdlGroup = {
          kind: "group",
          id: groupId,
          name: entry.name,
          children: entry.fields.map<PsdlField>((f) => ({
            // Prefix the child id with the instance group's id so two
            // copies of the same variant (e.g. NOP × 8) produce
            // distinct NormalizedField ids. Without this, normalize
            // emits N fields with the same `id: "type"` and React keys
            // collide, plus `selectedFieldId.split(":")` lookups land
            // on the first match instead of the actually clicked one.
            id: `${groupId}__${f.id}`,
            name: f.name,
            type: { kind: "bits", n: f.bits },
            ...(f.description ? { doc: f.description } : {}),
            ...(c.category ? { category: c.category } : {}),
          })),
        };
        newBody.push(group);
      }

      // Stage 2b: trailing placeholder when the user-declared slot is
      // bigger than the records that have been added so far. Lets the
      // diagram visually close on the controller boundary instead of
      // leaving a phantom gap.
      if (slot > instanceBytes) {
        const remaining = slot - instanceBytes;
        newBody.push({
          id: `${c.id}__remaining`,
          name: `Options remaining (${remaining} B)`,
          type: { kind: "bytes", n: { kind: "lit", value: remaining } },
          ...(c.category ? { category: c.category } : {}),
        });
      }
      // Stage 2c (overshoot, `instanceBytes > slot`): the user added
      // more record bytes than the controller declares. Wire format is
      // malformed (IHL would need to grow). We currently let the
      // instance cells overflow past the controller boundary in the
      // diagram without a visible warning — a follow-up should surface
      // this as a banner above the diagram or auto-grow IHL to match.
      // See PR #115 sub-agent review for the rationale.
      return newBody;
    }
    return [c];
  };

  const newBody = psdl.body.flatMap(expand);
  return mutated ? { ...psdl, body: newBody } : psdl;
}
