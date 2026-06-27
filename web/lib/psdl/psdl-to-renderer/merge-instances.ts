// Merge the runtime renderer mirror's diagram-driven edits back onto a
// PSDL packet body without otherwise touching the body's shape.
//
// Background: in editMode the diagram is laid out from `studioState.packet`
// (the user's in-progress schema edit), but TLV / chain / byteOrder edits
// made via the diagram only land on the renderer mirror (via
// `handleTlvChange` / `handleChainChange` / `handleByteOrderChange` →
// `replaceActivePacket`). They never round-trip through the studio
// reducer. So `studioState.packet` keeps the original values while the
// diagram visibly carries the latest state.
//
// Every export path off the studio packet — JSON pane, share URL,
// "Save as preset" — therefore silently drops the user's diagram-driven
// edits. The PSDL extensions (`Repeat.instances` / `Repeat.chainInstances`
// in 750a76c) made the state representable in PSDL; this helper actually
// merges them on the way out so the export paths reflect what's on
// screen.
//
// Properties preserved:
//   * Empty mirror lists overwrite previously-populated PSDL lists —
//     deleting all TLV records via the diagram must clear the exported
//     `instances`, not leave the prior version (Codex P1 / P2).
//   * Chain `extras` are carried through (Codex P2). TLV `extras` already
//     are.
//   * `chainFinalProto` (sub-agent H1) is mirrored onto the chain Repeat
//     itself so the user's terminal-Next-Header pick survives Save-As /
//     share without reverting to the catalog default.
//   * `byteOrder` overrides applied via the diagram propagate onto the
//     matching PSDL Field, deep-walking through Group / Optional /
//     Switch / Encrypted / Repeat-element (sub-agent C1 / H2).

import { isField } from "../utils";
import type { Container, Packet as PsdlPacket, Repeat } from "../types";
import type { NamedStruct } from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";

/** Carries the renderer mirror plus a lazily-populated map of merged
 *  `defs` entries. RefContainers in the body / nested structs resolve a
 *  shared `NamedStruct` out of `packet.defs`; psdlToRenderer flattens that
 *  def inline and exposes a full override surface for its fields (TLV list
 *  editor, byteOrder flip, …), so the lift must descend into the def and
 *  write the merged fields back. Because a single def can be referenced
 *  from multiple `ref`s, we merge each def exactly once (keyed by ref name)
 *  and reuse the result — re-merging is idempotent (mirror→PSDL), but
 *  caching also avoids two refs racing to rebuild the same entry. */
type MergeCtx = {
  mirror: RendererPacket;
  /** Source defs from the packet being lifted (read-only). */
  srcDefs?: Record<string, NamedStruct>;
  /** Merged defs, populated on first visit of each `ref`. */
  outDefs: Record<string, NamedStruct>;
};

function findRendererField(
  mirror: RendererPacket,
  id: string,
): RendererField | undefined {
  return mirror.fields.find((f) => f.id === id);
}

/** Resolve a RefContainer's def, merge its fields against the mirror once
 *  (caching the result on `ctx.outDefs`), so the ref-resolved content's
 *  diagram edits (byteOrder flips + TLV / chain instances) survive the
 *  lift. No-op when the def is absent (dangling ref): the body's `ref`
 *  node passes through untouched and nothing is written to `outDefs`. */
function mergeRefDef(ref: string, ctx: MergeCtx): void {
  if (ref in ctx.outDefs) return; // already merged (or being merged)
  const def = ctx.srcDefs?.[ref];
  if (!def) return;
  // Seed the cache slot before recursing so a recursive / mutually
  // referential def cannot loop forever.
  ctx.outDefs[ref] = def;
  const mergedFields = def.fields.map((f) => {
    const overlaid = overlayFieldEdits(f, ctx);
    return mergeRepeats(overlaid, ctx);
  });
  ctx.outDefs[ref] = { ...def, fields: mergedFields };
}

function mergeRepeat(c: Repeat, ctx: MergeCtx): Repeat {
  const { mirror } = ctx;
  // TLV Repeats keep their id 1:1 with the renderer field. Chain
  // Repeats (`*_chain`) usually merge onto a sibling base Field at
  // import time (psdlToRenderer collapses them), so prefer the stripped
  // id; fall through to the same id if no base field exists (the
  // standalone chain catalog case explicitly carried by chain.ts).
  const sameIdMirror = findRendererField(mirror, c.id);
  const chainBaseId = c.id.replace(/_chain$/, "");
  const chainBaseMirror =
    chainBaseId !== c.id ? findRendererField(mirror, chainBaseId) : undefined;

  let next: Repeat = c;

  // TLV path — write whenever the mirror has a TLV field at this id,
  // even if the runtime list is empty (so a "delete every record" gesture
  // clears stale `instances` from the studio packet on export).
  if (sameIdMirror?.tlv) {
    const instances = (sameIdMirror.tlv.instances ?? []).map((inst) => ({
      kind: inst.kind,
      ...(inst.extras ? { extras: { ...inst.extras } } : {}),
    }));
    next =
      instances.length > 0
        ? { ...next, instances }
        : omitKey(next, "instances");
  }

  // Chain path — prefer the chain-merged base field, fall back to same
  // id mirror when no base existed (`chainBaseMirror` undefined but the
  // standalone chain catalog is on `sameIdMirror`).
  const chainMirror = chainBaseMirror?.chainCatalog
    ? chainBaseMirror
    : sameIdMirror?.chainCatalog
      ? sameIdMirror
      : undefined;
  if (chainMirror) {
    const chainInstances = (chainMirror.chainInstances ?? []).map((inst) => ({
      proto: inst.proto,
      ...(inst.extras ? { extras: { ...inst.extras } } : {}),
    }));
    next =
      chainInstances.length > 0
        ? { ...next, chainInstances }
        : omitKey(next, "chainInstances");
    // Persist the terminal Next-Header pick on the Repeat itself so a
    // Save-As / share-URL round-trip restores the user's choice rather
    // than reverting to the catalog default (sub-agent H1).
    if (typeof chainMirror.chainFinalProto === "number") {
      next = { ...next, chainFinalProto: chainMirror.chainFinalProto };
    } else if (next.chainFinalProto !== undefined) {
      next = omitKey(next, "chainFinalProto");
    }
  }

  return next;
}

/** Apply field-level overlays (currently just `byteOrder`) onto a
 *  Container subtree. Walks Group, Optional, Switch, Encrypted, and
 *  Repeat-element fields so a `byteOrder` flip on a leaf nested under
 *  any composition primitive still rides the merge. */
function overlayFieldEdits(c: Container, ctx: MergeCtx): Container {
  const { mirror } = ctx;
  if (isField(c)) {
    const mirrorField = findRendererField(mirror, c.id);
    if (mirrorField?.byteOrder && mirrorField.byteOrder !== c.byteOrder) {
      return { ...c, byteOrder: mirrorField.byteOrder };
    }
    if (
      // mirror explicitly cleared a previous override
      mirrorField &&
      mirrorField.byteOrder === undefined &&
      c.byteOrder !== undefined
    ) {
      return omitKey(c, "byteOrder");
    }
    return c;
  }
  if (c.kind === "group") {
    return {
      ...c,
      children: c.children.map((ch) => overlayFieldEdits(ch, ctx)),
    };
  }
  if (c.kind === "repeat") {
    return {
      ...c,
      element: {
        ...c.element,
        fields: c.element.fields.map((f) => overlayFieldEdits(f, ctx)),
      },
    };
  }
  if (c.kind === "switch") {
    const nextCases: Record<string, (typeof c.cases)[string]> = {};
    for (const [k, v] of Object.entries(c.cases)) {
      nextCases[k] = {
        ...v,
        fields: v.fields.map((f) => overlayFieldEdits(f, ctx)),
      };
    }
    // The 0.5 default arm is the "_" case, already handled by the loop above.
    return { ...c, cases: nextCases };
  }
  if (c.kind === "encrypted") {
    return {
      ...c,
      plaintext: {
        ...c.plaintext,
        fields: c.plaintext.fields.map((f) => overlayFieldEdits(f, ctx)),
      },
    };
  }
  if (c.kind === "optional") {
    return {
      ...c,
      container: overlayFieldEdits(c.container, ctx) as typeof c.container,
    };
  }
  if (c.kind === "bounded") {
    return {
      ...c,
      fields: c.fields.map((f) => overlayFieldEdits(f, ctx)),
    };
  }
  if (c.kind === "ref") {
    // A `ref` is expanded inline by psdlToRenderer (flattenForMirror), so
    // its def fields carry mirror edits that must ride the lift. Merge the
    // referenced def's fields (once) into `ctx.outDefs`; the `ref` node
    // itself is structural and passes through unchanged.
    mergeRefDef(c.ref, ctx);
    return c;
  }
  return c;
}

function mergeContainer(c: Container, ctx: MergeCtx): Container[] {
  const overlaid = overlayFieldEdits(c, ctx);
  // After overlay we know the leaf-level merges are done; now handle
  // container-level Repeat merges (which need to descend through
  // Group / Switch / Encrypted / Optional too, sub-agent H2).
  // NOTE: do NOT unwrap a `bounded` here. PSDL 0.5 wraps the TLV / chain
  // Repeat in a transparent `bounded` wire-scope (e.g. IPv4's `optionsArea`);
  // `mergeRepeats` already recurses into `bounded.fields` and updates the
  // inner Repeat in place, so the wrapper — and its `bounded.bytes` budget —
  // must be preserved. Stripping it made the exported PSDL diverge from the
  // built-in preset (no instance change but a missing length scope), breaking
  // the `samePsdlPacket` check that share / "Save as preset" rely on. The
  // renderer mirror flattens the scope for *display* (`flattenForMirror`); the
  // exported PSDL stays canonical.
  return [mergeRepeats(overlaid, ctx)];
}

function mergeRepeats(c: Container, ctx: MergeCtx): Container {
  if (c.kind === "repeat") return mergeRepeat(c, ctx);
  if (c.kind === "group") {
    return {
      ...c,
      children: c.children.map((ch) => mergeRepeats(ch, ctx)),
    };
  }
  if (c.kind === "switch") {
    const nextCases: Record<string, (typeof c.cases)[string]> = {};
    for (const [k, v] of Object.entries(c.cases)) {
      nextCases[k] = {
        ...v,
        fields: v.fields.map((f) => mergeRepeats(f, ctx)),
      };
    }
    // The 0.5 default arm is the "_" case, already handled by the loop above.
    return { ...c, cases: nextCases };
  }
  if (c.kind === "encrypted") {
    return {
      ...c,
      plaintext: {
        ...c.plaintext,
        fields: c.plaintext.fields.map((f) => mergeRepeats(f, ctx)),
      },
    };
  }
  if (c.kind === "bounded") {
    return {
      ...c,
      fields: c.fields.map((f) => mergeRepeats(f, ctx)),
    };
  }
  if (c.kind === "optional") {
    // A TLV/chain Repeat can sit inside an Optional container; recurse so its
    // instances ride the lift/share merge (mirrors `overlayFieldEdits`).
    return {
      ...c,
      container: mergeRepeats(c.container, ctx) as typeof c.container,
    };
  }
  if (c.kind === "ref") {
    // Merge the referenced def's TLV / chain Repeats into `ctx.outDefs`
    // (once). `overlayFieldEdits` already triggered this on the same `ref`
    // via the shared cache, but a `mergeRepeats`-only entry point (def
    // fields recursed from `mergeRefDef`) still needs the branch. The `ref`
    // node itself stays structural.
    mergeRefDef(c.ref, ctx);
    return c;
  }
  // Field carries no Repeat — already overlaid above, no-op here.
  return c;
}

function omitKey<T extends object, K extends keyof T>(obj: T, key: K): T {
  if (!(key in obj)) return obj;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [key]: _omitted, ...rest } = obj;
  return rest as T;
}

/** Return a new PSDL packet whose Repeat containers carry the renderer
 *  mirror's current TLV / chain / byteOrder edits. Shape-preserving:
 *  Containers whose mirror state matches PSDL state pass through
 *  unchanged so the merge is O(body) for typical edits. */
export function mergeInstancesIntoPsdl(
  psdl: PsdlPacket,
  mirror: RendererPacket,
): PsdlPacket {
  const ctx: MergeCtx = {
    mirror,
    srcDefs: psdl.defs,
    outDefs: {},
  };
  const body = psdl.body.flatMap((c) => mergeContainer(c, ctx));
  // `ctx.outDefs` only holds defs reached through a `ref` in the body (or
  // transitively from a ref-resolved def). Defs that are never referenced
  // pass through verbatim via the `...psdl` spread; reachable ones are
  // overwritten with their merged version. Skip the `defs` rewrite entirely
  // when nothing was merged so packets without RefContainers keep an
  // identical (===) `defs` reference and the shape-preserving guarantee
  // documented above holds.
  if (Object.keys(ctx.outDefs).length === 0) {
    return { ...psdl, body };
  }
  return {
    ...psdl,
    body,
    defs: { ...psdl.defs, ...ctx.outDefs },
  };
}
