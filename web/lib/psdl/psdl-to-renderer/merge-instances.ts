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

/** Carries the renderer mirror plus lazily-populated maps of merged `defs`.
 *  RefContainers in the body / nested structs resolve a shared `NamedStruct`
 *  out of `packet.defs`; psdlToRenderer flattens that def inline (qualifying
 *  each ref instance's field ids by the ref id) and exposes a full override
 *  surface for its fields (TLV list editor, byteOrder flip, …), so the lift
 *  must descend into the def and write the merged fields back. A def
 *  referenced from a SINGLE site merges once into `outDefs` under its original
 *  name (idempotent, no churn); a def referenced from MULTIPLE sites forks a
 *  per-ref clone into `cloneDefs` so each instance's qualified edits land on
 *  its OWN copy instead of colliding on a shared one. */
type MergeCtx = {
  mirror: RendererPacket;
  /** Source defs from the packet being lifted (read-only). */
  srcDefs?: Record<string, NamedStruct>;
  /** Merged defs, populated on first visit of each `ref`. */
  outDefs: Record<string, NamedStruct>;
  /** Number of body sites referencing each def name. A def referenced from
   *  more than one `ref` must NOT share a single merged copy: the renderer
   *  mirror qualifies each ref instance's fields by the ref id
   *  (`<refId>.<fieldId>`), so per-instance TLV / byteOrder edits live under
   *  distinct mirror ids and must lift onto distinct def copies — otherwise
   *  the second ref instance's edits collide onto the first. Built once up
   *  front; a def used exactly once keeps the shared name (no churn). */
  refUseCount: Map<string, number>;
  /** Def names that participate in a reference cycle (self- or mutually
   *  recursive — the `optional{ref self}` idiom for DNS/ASN.1/LISP). Such a
   *  def's repeated `ref`s ARE the recursion, not independent siblings, so it
   *  must keep a single shared name (forking would diverge each recursion
   *  level into a fresh clone and never terminate). */
  recursiveDefs: Set<string>;
  /** Per-ref clone defs forked for multiply-referenced defs, keyed by the
   *  clone's (unique) name. Folded into the output `defs`. */
  cloneDefs: Record<string, NamedStruct>;
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
 *  node passes through untouched and nothing is written to `outDefs`.
 *
 *  `prefix` is the `<refId>.` qualifier the renderer mirror used for this
 *  ref instance's fields. When a def is referenced from a SINGLE body site we
 *  merge into the shared `outDefs[ref]` slot under the original name (no
 *  churn for the common case). When it is referenced from MULTIPLE sites,
 *  each instance forks a uniquely-named clone (`<ref>__<refId>`) so its
 *  per-instance edits don't collide; the body `ref` node is rewritten to
 *  point at the clone by {@link mergeRefContainer}. Returns the def name the
 *  body `ref` node should reference. */
function mergeRefDef(
  ref: string,
  prefix: string,
  refId: string,
  ctx: MergeCtx,
): string {
  const def = ctx.srcDefs?.[ref];
  if (!def) return ref; // dangling ref — pass through untouched
  // A recursive / cyclic def keeps a single shared name (see `recursiveDefs`).
  // Multiply-referenced NON-recursive defs fork a per-ref clone so independent
  // sibling instances edit independently.
  const fork =
    (ctx.refUseCount.get(ref) ?? 0) > 1 && !ctx.recursiveDefs.has(ref);
  if (!fork) {
    // Single-name path (single-ref, OR a recursive def whose self-refs all
    // resolve to this same shared name). Merge once; a back-edge during the
    // recursion finds `ref in outDefs` and returns without re-merging.
    if (ref in ctx.outDefs) return ref;
    ctx.outDefs[ref] = def; // seed before recursing (cycle guard)
    ctx.outDefs[ref] = {
      ...def,
      fields: def.fields.map((f) => mergeDefField(f, prefix, ctx)),
    };
    return ref;
  }
  // Multiply-referenced (non-recursive): fork a clone keyed by the ref site's
  // qualifier so each instance's qualified edits land independently. Sanitise
  // the qualifier (trailing dots / nested-ref dots) into a defs-name-safe
  // suffix; fall back to the bare refId when the sanitised form is empty.
  const suffix = (prefix.replace(/\.$/, "").replace(/\./g, "__") || refId)
    // defs names are identifiers; keep it conservative.
    .replace(/[^A-Za-z0-9_]/g, "_");
  const cloneName = `${ref}__${suffix}`;
  if (cloneName in ctx.cloneDefs) return cloneName;
  ctx.cloneDefs[cloneName] = def; // seed before recursing (cycle guard)
  ctx.cloneDefs[cloneName] = {
    ...def,
    id: cloneName,
    fields: def.fields.map((f) => mergeDefField(f, prefix, ctx)),
  };
  return cloneName;
}

/** Merge one field of a ref-resolved def: apply byteOrder overlays then Repeat
 *  (TLV / chain) merges under the given qualifier. A NESTED `ref` is handled
 *  once by `mergeRefContainer` (via the overlay pass) — re-running the Repeat
 *  pass on it is harmless (the rewritten name resolves to no source def), but
 *  short-circuiting keeps the intent clear. */
function mergeDefField(c: Container, prefix: string, ctx: MergeCtx): Container {
  if (!isField(c) && c.kind === "ref") {
    return mergeRefContainer(c, prefix, ctx);
  }
  return mergeRepeats(overlayFieldEdits(c, prefix, ctx), prefix, ctx);
}

/** Merge a body-level (or nested) `ref` container: rewrite its `ref` target
 *  to the (possibly forked) merged def name. The ref node's own `id` extends
 *  the qualifier for the def's fields, mirroring `flattenForMirrorQualified`. */
function mergeRefContainer(
  c: Extract<Container, { kind: "ref" }>,
  prefix: string,
  ctx: MergeCtx,
): Container {
  const childPrefix = `${prefix}${c.id}.`;
  const mergedName = mergeRefDef(c.ref, childPrefix, c.id, ctx);
  return mergedName === c.ref ? c : { ...c, ref: mergedName };
}

function mergeRepeat(c: Repeat, prefix: string, ctx: MergeCtx): Repeat {
  const { mirror } = ctx;
  // TLV Repeats keep their id 1:1 with the renderer field — qualified by the
  // enclosing `ref` prefix when reached through a def, so two sibling refs to
  // one def resolve onto their OWN mirror TLV field (`src.opts` vs `dst.opts`)
  // instead of both onto the first. Chain Repeats (`*_chain`) usually merge
  // onto a sibling base Field at import time (psdlToRenderer collapses them),
  // so prefer the stripped id; fall through to the same id if no base field
  // exists (the standalone chain catalog case explicitly carried by chain.ts).
  const qid = `${prefix}${c.id}`;
  const sameIdMirror = findRendererField(mirror, qid);
  const chainBaseId = qid.replace(/_chain$/, "");
  const chainBaseMirror =
    chainBaseId !== qid ? findRendererField(mirror, chainBaseId) : undefined;

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
function overlayFieldEdits(
  c: Container,
  prefix: string,
  ctx: MergeCtx,
): Container {
  const { mirror } = ctx;
  if (isField(c)) {
    // A field nested in a Switch case / Repeat element / Group never reaches
    // `mirror.fields`, so its diagram-driven byteOrder flip is recorded on
    // `mirror.byteOrderOverrides` (keyed by id) instead. Prefer that map; fall
    // back to the top-level `mirror.fields[c.id].byteOrder` for fields that DO
    // round-trip through the mirror (the override map also carries those, so
    // the map alone would suffice — the fields path is kept for mirrors built
    // without going through `handleByteOrderChange`).
    //
    // The lookup id is qualified by the enclosing `ref` prefix so two sibling
    // refs to one def get INDEPENDENT byteOrder lifts (`src.a1` vs `dst.a1`)
    // instead of both reading the first ref's flip off a bare `a1`.
    const qid = `${prefix}${c.id}`;
    const overridden = mirror.byteOrderOverrides?.[qid];
    const mirrorField = findRendererField(mirror, qid);
    const effective = overridden ?? mirrorField?.byteOrder;
    if (effective && effective !== c.byteOrder) {
      return { ...c, byteOrder: effective };
    }
    if (
      // mirror explicitly cleared a previous override
      effective === undefined &&
      (overridden !== undefined || mirrorField !== undefined) &&
      c.byteOrder !== undefined
    ) {
      return omitKey(c, "byteOrder");
    }
    return c;
  }
  if (c.kind === "group") {
    return {
      ...c,
      children: c.children.map((ch) => overlayFieldEdits(ch, prefix, ctx)),
    };
  }
  if (c.kind === "repeat") {
    return {
      ...c,
      element: {
        ...c.element,
        fields: c.element.fields.map((f) => overlayFieldEdits(f, prefix, ctx)),
      },
    };
  }
  if (c.kind === "switch") {
    const nextCases: Record<string, (typeof c.cases)[string]> = {};
    for (const [k, v] of Object.entries(c.cases)) {
      nextCases[k] = {
        ...v,
        fields: v.fields.map((f) => overlayFieldEdits(f, prefix, ctx)),
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
        fields: c.plaintext.fields.map((f) =>
          overlayFieldEdits(f, prefix, ctx),
        ),
      },
    };
  }
  if (c.kind === "optional") {
    return {
      ...c,
      container: overlayFieldEdits(
        c.container,
        prefix,
        ctx,
      ) as typeof c.container,
    };
  }
  if (c.kind === "bounded") {
    return {
      ...c,
      fields: c.fields.map((f) => overlayFieldEdits(f, prefix, ctx)),
    };
  }
  if (c.kind === "ref") {
    // A `ref` is expanded inline by psdlToRenderer (flattenForMirrorQualified),
    // so its def fields carry mirror edits that must ride the lift. Merge the
    // referenced def (per-ref-forked when the def is multiply referenced) and
    // rewrite the ref node to point at the merged def name.
    return mergeRefContainer(c, prefix, ctx);
  }
  return c;
}

function mergeContainer(c: Container, ctx: MergeCtx): Container[] {
  // A body-level `ref` is fully handled by `mergeRefContainer` (which recurses
  // both overlays and Repeat merges into the def). Routing it through
  // `overlayFieldEdits` AND `mergeRepeats` would double-process it (the second
  // pass would see the rewritten name as a dangling ref), so short-circuit.
  if (!isField(c) && c.kind === "ref") {
    return [mergeRefContainer(c, "", ctx)];
  }
  const overlaid = overlayFieldEdits(c, "", ctx);
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
  return [mergeRepeats(overlaid, "", ctx)];
}

function mergeRepeats(c: Container, prefix: string, ctx: MergeCtx): Container {
  if (c.kind === "repeat") return mergeRepeat(c, prefix, ctx);
  if (c.kind === "group") {
    return {
      ...c,
      children: c.children.map((ch) => mergeRepeats(ch, prefix, ctx)),
    };
  }
  if (c.kind === "switch") {
    const nextCases: Record<string, (typeof c.cases)[string]> = {};
    for (const [k, v] of Object.entries(c.cases)) {
      nextCases[k] = {
        ...v,
        fields: v.fields.map((f) => mergeRepeats(f, prefix, ctx)),
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
        fields: c.plaintext.fields.map((f) => mergeRepeats(f, prefix, ctx)),
      },
    };
  }
  if (c.kind === "bounded") {
    return {
      ...c,
      fields: c.fields.map((f) => mergeRepeats(f, prefix, ctx)),
    };
  }
  if (c.kind === "optional") {
    // A TLV/chain Repeat can sit inside an Optional container; recurse so its
    // instances ride the lift/share merge (mirrors `overlayFieldEdits`).
    return {
      ...c,
      container: mergeRepeats(c.container, prefix, ctx) as typeof c.container,
    };
  }
  if (c.kind === "ref") {
    // Merge the referenced def's TLV / chain Repeats (per-ref-forked when
    // multiply referenced) and rewrite the ref node to the merged def name.
    // `overlayFieldEdits` already triggered the merge on the same `ref` via
    // the shared cache, but a `mergeRepeats`-only entry point (def fields
    // recursed from `mergeRefDef`) still needs the branch.
    return mergeRefContainer(c, prefix, ctx);
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

/** Count how many `ref` sites target each def name across the body AND every
 *  def's fields (a def can be referenced from another def). A def referenced
 *  more than once must fork per-ref clones on lift so per-instance edits stay
 *  independent (see `mergeRefDef`). A self-recursive def counts its own inner
 *  self-ref; that only matters for the >1 test, and a self-recursive def is
 *  always reached through exactly one body chain, so cloning it per-occurrence
 *  is not needed — but counting it as multiply-referenced is harmless because
 *  the clone is cached by name and the cycle guard seeds it before recursing. */
function countRefUses(
  defs: Record<string, NamedStruct> | undefined,
  body: Container[],
): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) continue;
      switch (c.kind) {
        case "ref":
          counts.set(c.ref, (counts.get(c.ref) ?? 0) + 1);
          break;
        case "group":
          walk(c.children);
          break;
        case "bounded":
          walk(c.fields);
          break;
        case "repeat":
          walk(c.element.fields);
          break;
        case "optional":
          walk([c.container]);
          break;
        case "encrypted":
          walk(c.plaintext.fields);
          break;
        case "switch":
          for (const v of Object.values(c.cases)) walk(v.fields);
          break;
        default:
          break;
      }
    }
  };
  walk(body);
  for (const def of Object.values(defs ?? {})) walk(def.fields);
  return counts;
}

/** Direct `ref` targets reachable from a container list (no recursion into
 *  the referenced defs — just this struct's own immediate ref edges). */
function directRefs(containers: Container[]): Set<string> {
  const refs = new Set<string>();
  const walk = (cs: Container[]): void => {
    for (const c of cs) {
      if (isField(c)) continue;
      switch (c.kind) {
        case "ref":
          refs.add(c.ref);
          break;
        case "group":
          walk(c.children);
          break;
        case "bounded":
          walk(c.fields);
          break;
        case "repeat":
          walk(c.element.fields);
          break;
        case "optional":
          walk([c.container]);
          break;
        case "encrypted":
          walk(c.plaintext.fields);
          break;
        case "switch":
          for (const v of Object.values(c.cases)) walk(v.fields);
          break;
        default:
          break;
      }
    }
  };
  walk(containers);
  return refs;
}

/** Def names that participate in a reference cycle (a def reachable from
 *  itself through `ref` edges). Such defs must keep a single shared name on
 *  lift — their repeated references are recursion, not independent siblings.
 *  Computed as the def-dependency graph's nodes on any cycle (a node with a
 *  path back to itself). */
function findRecursiveDefs(
  defs: Record<string, NamedStruct> | undefined,
): Set<string> {
  const recursive = new Set<string>();
  if (!defs) return recursive;
  const edges = new Map<string, Set<string>>();
  for (const [name, def] of Object.entries(defs)) {
    edges.set(name, directRefs(def.fields));
  }
  const reachesSelf = (start: string): boolean => {
    const stack = [...(edges.get(start) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === start) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of edges.get(cur) ?? []) stack.push(next);
    }
    return false;
  };
  for (const name of edges.keys()) {
    if (reachesSelf(name)) recursive.add(name);
  }
  return recursive;
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
    refUseCount: countRefUses(psdl.defs, psdl.body),
    recursiveDefs: findRecursiveDefs(psdl.defs),
    cloneDefs: {},
  };
  const body = psdl.body.flatMap((c) => mergeContainer(c, ctx));
  // `ctx.outDefs` holds singly-referenced defs reached through a `ref` (merged
  // under their original name); `ctx.cloneDefs` holds the per-ref forks of
  // multiply-referenced defs (merged under a unique `<def>__<refId>` name).
  // Defs that are never referenced pass through verbatim via the `...psdl`
  // spread. Skip the `defs` rewrite entirely when nothing was merged so
  // packets without RefContainers keep an identical (===) `defs` reference and
  // the shape-preserving guarantee documented above holds.
  if (
    Object.keys(ctx.outDefs).length === 0 &&
    Object.keys(ctx.cloneDefs).length === 0
  ) {
    return { ...psdl, body };
  }
  return {
    ...psdl,
    body,
    defs: { ...psdl.defs, ...ctx.outDefs, ...ctx.cloneDefs },
  };
}
