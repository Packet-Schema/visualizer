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
  NamedStruct,
  Packet as PsdlPacket,
} from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
  TlvCatalogField,
} from "../renderer";
import { resolveTlvFields } from "../renderer-helpers";

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
  defs?: Record<string, NamedStruct>,
): boolean {
  // Count cell-producing leaves: a TLV repeat counts as a TLV leaf, anything
  // else (plain field, switch, non-TLV repeat) counts as "other". Transparent
  // scopes (bounded / group / optional / encrypted plaintext / resolved ref)
  // are descended so the same sole-TLV-repeat body shape is recognised whether
  // the repeat sits inline or behind a `ref`-def / wrapper.
  let tlvLeaves = 0;
  let otherLeaves = 0;
  const walk = (containers: Container[], seen: Set<string>): void => {
    for (const c of containers) {
      switch (c.kind) {
        case "bounded":
          walk(c.fields, seen);
          break;
        case "group":
          walk(c.children, seen);
          break;
        case "optional":
          walk([c.container], seen);
          break;
        case "encrypted":
          walk(c.plaintext.fields, seen);
          break;
        case "ref": {
          if (seen.has(c.ref)) break;
          const def = defs?.[c.ref] as NamedStruct | undefined;
          if (!def) {
            otherLeaves++;
            break;
          }
          seen.add(c.ref);
          walk(def.fields, seen);
          seen.delete(c.ref);
          break;
        }
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
  walk(body, new Set());
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

  // PSDL 0.5 `defs` (NamedStructs referenced from the body via `{kind:"ref"}`)
  // are how user schemas factor out / recurse shared structure. The renderer
  // mirror (`flattenForMirror`) resolves a body-level `ref` so a TLV repeat
  // living inside a def gets a full catalog — but the render-path rewriter
  // below must descend the ref too, or the TLV editor is inert (records merge
  // into the def yet the diagram never reflects them). `defs` are shared by id,
  // so we expand a resolved struct INLINE at each ref site rather than mutating
  // the shared def. A path-scoped seen-set guards against self/mutually
  // recursive defs (mirrors flattenForMirrorGuarded in index.ts).
  const defs = psdl.defs;
  const resolveRef = (ref: string): NamedStruct | undefined =>
    defs?.[ref] as NamedStruct | undefined;

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
  if (bodyIsSoleTlvRepeat(psdl.body, tlvByRepeatId, defs)) {
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
  //
  // `prefix` qualifies a TLV repeat's id with its enclosing `ref`'s id
  // (`<refId>.`), matching the renderer mirror's `flattenForMirrorQualified`
  // ids. Two sibling refs to one def therefore probe distinct TLV instance
  // lists (`src.opts` vs `dst.opts`); without it both refs would resolve onto
  // the first ref's instances and export identically.
  const containsExpandedTlv = (
    containers: Container[],
    prefix: string,
    seen: Set<string> = new Set(),
  ): boolean =>
    containers.some((c) => {
      if (c.kind === "repeat") return tlvExpands(`${prefix}${c.id}`);
      if (c.kind === "bounded")
        return containsExpandedTlv(c.fields, prefix, seen);
      if (c.kind === "group")
        return containsExpandedTlv(c.children, prefix, seen);
      if (c.kind === "optional")
        return containsExpandedTlv([c.container], prefix, seen);
      if (c.kind === "encrypted")
        return containsExpandedTlv(c.plaintext.fields, prefix, seen);
      if (c.kind === "ref") {
        if (seen.has(c.ref)) return false;
        const def = resolveRef(c.ref);
        if (!def) return false;
        seen.add(c.ref);
        const found = containsExpandedTlv(
          def.fields,
          `${prefix}${c.id}.`,
          seen,
        );
        seen.delete(c.ref);
        return found;
      }
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
  //
  // `prefix` carries the enclosing `ref`-id qualifier (`<refId>.`) so a TLV
  // repeat inside a def is matched against the QUALIFIED renderer-mirror id
  // (`src.opts`, not `opts`) and mints qualified synthetic ids
  // (`src.opts__inst_0`) that the diagram-click router (`parseTlvCellId`) and
  // the merge path resolve back to the correct ref instance. Two sibling refs
  // to one def thus expand independently.
  const expand = (
    c: Container,
    prefix: string,
    seen: Set<string> = new Set(),
  ): Container[] => {
    if (c.kind === "bounded") {
      // Detect whether this scope holds a TLV Repeat we will expand, so the
      // splice-vs-wrap decision keys off *this* bounded rather than the
      // shared `mutated` flag (which a prior sibling may already have set).
      const expandsHere = containsExpandedTlv(c.fields, prefix, new Set(seen));
      const inner = c.fields.flatMap((x) => expand(x, prefix, seen));
      return expandsHere ? inner : [{ ...c, fields: inner }];
    }
    if (c.kind === "group") {
      return [
        { ...c, children: c.children.flatMap((x) => expand(x, prefix, seen)) },
      ];
    }
    // A body-level `ref` to a PSDL `def`: resolve the NamedStruct and splice
    // its expanded fields inline at the ref site (mirroring flattenForMirror).
    // We expand a COPY of the def's fields and never mutate the shared def, so
    // a def referenced from multiple sites stays intact. The seen-set guards
    // against self/mutually recursive defs (`optional{ref self}` idioms). The
    // ref's id extends `prefix` so the inlined TLV ids stay distinct per ref.
    if (c.kind === "ref") {
      if (seen.has(c.ref)) return [c];
      const def = resolveRef(c.ref);
      if (!def) return [c];
      const nextSeen = new Set(seen);
      nextSeen.add(c.ref);
      return def.fields.flatMap((x) =>
        expand(x, `${prefix}${c.id}.`, nextSeen),
      );
    }
    // `encrypted` (PSDL 0.5 §5.4) keeps its wrapper (it carries the
    // wireBits / headerProtected semantics) but its `plaintext` struct may
    // hold a TLV Repeat. Descend into the plaintext so the TLV is expanded in
    // place; otherwise the diagram shows the raw Repeat inside the cleartext.
    if (c.kind === "encrypted") {
      return [
        {
          ...c,
          plaintext: {
            ...c.plaintext,
            fields: c.plaintext.fields.flatMap((x) => expand(x, prefix, seen)),
          },
        },
      ];
    }
    // `optional` (PSDL 0.5 §10.8) wraps exactly one container, which may be a
    // TLV Repeat (or a group/bounded that holds one). Descend into the wrapped
    // container so the TLV is expanded in place; otherwise the diagram would
    // show the raw Repeat. Expanding may yield multiple containers (the TLV's
    // per-instance Groups, or a spliced bounded) — since an Optional wraps a
    // single container, collapse a multi-result into a Group so the Optional
    // keeps wrapping exactly one container.
    if (c.kind === "optional") {
      const inner = expand(c.container, prefix, seen);
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
    // Qualify the repeat id with the enclosing ref prefix so it matches the
    // (now-qualified) renderer-mirror TLV field id.
    const qid = `${prefix}${c.id}`;
    if (c.kind === "repeat" && tlvByRepeatId.has(qid)) {
      const tlv = tlvByRepeatId.get(qid)!;
      const slot = Math.max(0, Math.floor(slotBytes[qid] ?? 0));
      const newBody: Container[] = [];

      // Stage 3: neither instances nor a slot → leave the Repeat alone.
      if (tlv.instances.length === 0 && slot === 0) {
        return [c];
      }

      mutated = true;

      // Stage 1: slot only → one empty placeholder Field of bytes(slot).
      if (tlv.instances.length === 0) {
        newBody.push({
          id: qid,
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
        if (!entry) continue;
        // Resolve the effective field list — for an entry with a variable
        // value member (`fieldsFor`/`variableBytes`), this sizes the
        // `bytes(ref L)` / delimited / varint value from the instance's
        // `extras` (seeded via `defaultExtras`) so it materialises as a
        // VISIBLE, non-zero-width cell instead of a `{kind:'bits', n:0}`
        // ghost. Fixed-shape entries fall through to `entry.fields`.
        const fields: TlvCatalogField[] = resolveTlvFields(entry, inst);
        if (fields.length === 0) continue;
        const bits = fields.reduce((a, f) => a + f.bits, 0);
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
        const groupId = `${qid}__inst_${i}`;
        const group: PsdlGroup = {
          kind: "group",
          id: groupId,
          name: entry.name,
          children: fields.map<PsdlField>((f) => ({
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
          id: `${qid}__remaining`,
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

  const newBody = psdl.body.flatMap((c) => expand(c, ""));
  return mutated ? { ...psdl, body: newBody } : psdl;
}
