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
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";

function findRendererField(
  mirror: RendererPacket,
  id: string,
): RendererField | undefined {
  return mirror.fields.find((f) => f.id === id);
}

function mergeRepeat(c: Repeat, mirror: RendererPacket): Repeat {
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
function overlayFieldEdits(c: Container, mirror: RendererPacket): Container {
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
      children: c.children.map((ch) => overlayFieldEdits(ch, mirror)),
    };
  }
  if (c.kind === "repeat") {
    return {
      ...c,
      element: {
        ...c.element,
        fields: c.element.fields.map((f) => overlayFieldEdits(f, mirror)),
      },
    };
  }
  if (c.kind === "switch") {
    const nextCases: Record<string, (typeof c.cases)[string]> = {};
    for (const [k, v] of Object.entries(c.cases)) {
      nextCases[k] = {
        ...v,
        fields: v.fields.map((f) => overlayFieldEdits(f, mirror)),
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
        fields: c.plaintext.fields.map((f) => overlayFieldEdits(f, mirror)),
      },
    };
  }
  if (c.kind === "optional") {
    return {
      ...c,
      container: overlayFieldEdits(c.container, mirror) as typeof c.container,
    };
  }
  if (c.kind === "bounded") {
    return {
      ...c,
      fields: c.fields.map((f) => overlayFieldEdits(f, mirror)),
    };
  }
  return c;
}

function mergeContainer(c: Container, mirror: RendererPacket): Container[] {
  const overlaid = overlayFieldEdits(c, mirror);
  // After overlay we know the leaf-level merges are done; now handle
  // container-level Repeat merges (which need to descend through
  // Group / Switch / Encrypted / Optional too, sub-agent H2).
  const merged = mergeRepeats(overlaid, mirror);
  // PSDL 0.5 wraps the TLV / chain Repeat in a transparent `bounded`
  // wire-scope (e.g. IPv4's `optionsArea`). The renderer mirror flattens
  // that scope (`flattenForMirror`), so a diagram-driven TLV / chain id
  // (`options`) maps onto a field at the mirror's *top* level. To keep the
  // exported PSDL addressable by those same flat ids — and so downstream
  // body walks find the merged Repeat where the mirror put it — we splice a
  // `bounded` that holds a merge-target Repeat inline rather than re-wrapping
  // it. Scopes with no merge-target Repeat are kept intact so unrelated wire
  // scopes round-trip untouched.
  if (
    merged.kind === "bounded" &&
    containsMergeTargetRepeat(merged.fields, mirror)
  ) {
    return merged.fields;
  }
  return [merged];
}

/** True when `mergeRepeat` would actually act on this Repeat — i.e. the mirror
 *  carries a TLV or chain catalog keyed by its id (the same condition
 *  `mergeRepeat` uses). A Repeat with no such mirror entry is left untouched,
 *  so its enclosing `bounded` wire-scope must NOT be unwrapped. */
function isMergeTargetRepeat(c: Repeat, mirror: RendererPacket): boolean {
  const sameIdMirror = findRendererField(mirror, c.id);
  if (sameIdMirror?.tlv) return true;
  const chainBaseId = c.id.replace(/_chain$/, "");
  const chainBaseMirror =
    chainBaseId !== c.id ? findRendererField(mirror, chainBaseId) : undefined;
  return Boolean(chainBaseMirror?.chainCatalog || sameIdMirror?.chainCatalog);
}

/** Does this container list hold a Repeat that a merge would target
 *  (recursing through nested transparent scopes / groups)? Only a Repeat with
 *  a real TLV/chain mirror counts — a plain Repeat inside a `bounded` does not,
 *  so the scope's `bounded.bytes` budget survives the export round-trip. */
function containsMergeTargetRepeat(
  containers: Container[],
  mirror: RendererPacket,
): boolean {
  return containers.some((c) => {
    if (c.kind === "repeat") return isMergeTargetRepeat(c, mirror);
    if (c.kind === "bounded")
      return containsMergeTargetRepeat(c.fields, mirror);
    if (c.kind === "group")
      return containsMergeTargetRepeat(c.children, mirror);
    return false;
  });
}

function mergeRepeats(c: Container, mirror: RendererPacket): Container {
  if (c.kind === "repeat") return mergeRepeat(c, mirror);
  if (c.kind === "group") {
    return {
      ...c,
      children: c.children.map((ch) => mergeRepeats(ch, mirror)),
    };
  }
  if (c.kind === "switch") {
    const nextCases: Record<string, (typeof c.cases)[string]> = {};
    for (const [k, v] of Object.entries(c.cases)) {
      nextCases[k] = {
        ...v,
        fields: v.fields.map((f) => mergeRepeats(f, mirror)),
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
        fields: c.plaintext.fields.map((f) => mergeRepeats(f, mirror)),
      },
    };
  }
  if (c.kind === "bounded") {
    return {
      ...c,
      fields: c.fields.map((f) => mergeRepeats(f, mirror)),
    };
  }
  // Field / Optional carry no Repeat — already overlaid above, no-op here.
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
  return {
    ...psdl,
    body: psdl.body.flatMap((c) => mergeContainer(c, mirror)),
  };
}
