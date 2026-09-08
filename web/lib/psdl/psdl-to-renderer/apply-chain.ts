// IPv6 extension-header chain expansion (override-audit B1/B2/B3).
//
// PSDL models the chain as `Repeat<Switch on ref(nextHeader)>` with
// `count: "eos"`. That shape is unrenderable by the live diagram:
//   * core's normalize resolves an eos count from `env[repeat.id]`, which the
//     visualizer never sets — so the chain rendered ZERO cells (B1), and
//   * a single bare-ref discriminator cannot vary per iteration, so a
//     heterogeneous chain (Hop-by-Hop → Routing → Fragment) was structurally
//     impossible (B2).
//
// Instead of leaning on the eos repeat, we MATERIALISE the user's
// `chainInstances` (held on the renderer mirror) into explicit PSDL: one Group
// per instance carrying that proto's Switch-case fields, ids prefixed per
// instance so they don't collide. normalize then lays the real chain out
// directly, each instance keeping its own variant. When there are no instances
// we leave the repeat untouched (it renders 0 — the correct default for a
// packet with no extension headers).

import type {
  Container,
  Field as PsdlField,
  Group as PsdlGroup,
  NamedStruct,
  Packet as PsdlPacket,
  Repeat as PsdlRepeat,
} from "../types";
import type { ChainInstance, Packet as RendererPacket } from "../renderer";
import { isField } from "../utils";

import { chainCaseLabel, isLikelyChainRepeat } from "./chain";
import { getSwitchFromRepeat } from "./shared";

/** Expand a chain Repeat into one Group per instance. Child ids are prefixed
 *  with the per-instance group id so repeated variants don't collide (mirrors
 *  `applyTlvInstances`). Note: internal sibling refs inside a case are NOT
 *  remapped — the only chain preset (ipv6) uses flat fixed-width fields with no
 *  internal refs, so this is collision-free today. */
function expandChainRepeat(
  repeat: PsdlRepeat,
  instances: ChainInstance[],
  qid: string,
): Container[] {
  const sw = getSwitchFromRepeat(repeat);
  if (!sw) return [repeat];
  const out: Container[] = [];
  instances.forEach((inst, i) => {
    const caseStruct = sw.cases[String(inst.proto)];
    if (!caseStruct) return;
    const groupId = `${qid}__chain_${i}`;
    const group: PsdlGroup = {
      kind: "group",
      id: groupId,
      name: chainCaseLabel(caseStruct, inst.proto),
      children: caseStruct.fields.map((f) =>
        isField(f) ? ({ ...f, id: `${groupId}__${f.id}` } as PsdlField) : f,
      ),
    };
    out.push(group);
  });
  return out;
}

function expandContainer(
  c: Container,
  mirror: RendererPacket,
  defs: Record<string, NamedStruct>,
  seenRefs: Set<string>,
  prefix: string,
): Container[] {
  if (isField(c)) return [c];
  if (c.kind === "repeat" && isLikelyChainRepeat(c)) {
    // The chain catalog merges onto the base field at import (id without the
    // `_chain` suffix), with a standalone-field fallback. Both the lookup id
    // and the minted group ids are QUALIFIED by the enclosing `ref` prefix
    // (`<refId>.`) so they match the renderer mirror's qualified chain field
    // and the diagram-click router resolves back to the right ref instance.
    const qid = `${prefix}${c.id}`;
    const baseId = qid.replace(/_chain$/, "");
    const field =
      mirror.fields.find((f) => f.id === baseId && f.chainCatalog) ??
      mirror.fields.find((f) => f.id === qid && f.chainCatalog);
    const instances = field?.chainInstances ?? [];
    if (instances.length === 0) return [c];
    return expandChainRepeat(c, instances, qid);
  }
  // Recurse through transparent containers so a chain nested in a bounded
  // scope is still found (defensive; ipv6's chain is top-level).
  if (c.kind === "bounded") {
    return [
      {
        ...c,
        fields: c.fields.flatMap((f) =>
          expandContainer(f, mirror, defs, seenRefs, prefix),
        ),
      },
    ];
  }
  if (c.kind === "group") {
    return [
      {
        ...c,
        children: c.children.flatMap((f) =>
          expandContainer(f, mirror, defs, seenRefs, prefix),
        ),
      },
    ];
  }
  // A body-level `ref` def can reach a chain Repeat (collectFreeRepeats
  // descends `ref`, so the chain catalog surfaces for this placement). Resolve
  // the def and expand its fields inline — with a cycle guard, since defs may
  // be recursive (§6). Expanding inline (rather than rewriting the def) keeps
  // the per-instance Groups addressable by the same flat ids the diagram uses;
  // the ref's id extends the prefix so the chain id matches the mirror.
  if (c.kind === "ref") {
    const def = defs[c.ref];
    if (!def || seenRefs.has(c.ref)) return [c];
    seenRefs.add(c.ref);
    const inner = def.fields.flatMap((f) =>
      expandContainer(f, mirror, defs, seenRefs, `${prefix}${c.id}.`),
    );
    seenRefs.delete(c.ref);
    return inner;
  }
  // `optional` (PSDL 0.5 §10.8) wraps exactly one container, which may be (or
  // hold) a chain Repeat. Descend so the chain is expanded in place; otherwise
  // the diagram shows the raw eos Repeat (inert). Expanding may yield multiple
  // containers (the per-instance Groups) — collapse a multi-result into a
  // Group so the Optional keeps wrapping exactly one container (mirrors
  // applyTlvInstances).
  if (c.kind === "optional") {
    const inner = expandContainer(c.container, mirror, defs, seenRefs, prefix);
    if (inner.length === 1 && inner[0] === c.container) return [c];
    const wrapped: Container =
      inner.length === 1
        ? inner[0]
        : {
            kind: "group",
            id: `${c.id ?? "optional"}__opt`,
            name:
              "name" in c.container
                ? (c.container.name ?? "Extension Headers")
                : "Extension Headers",
            children: inner,
          };
    return [{ ...c, container: wrapped }];
  }
  return [c];
}

/** Parse a diagram cell id minted by `expandChainRepeat` back to its chain
 *  repeat id + instance index, so a click on a rendered extension-header cell
 *  can be routed to a per-instance editor. Matches the group cell
 *  (`<repeatId>__chain_<i>`), its child fields (`…__chain_<i>__<field>`) and
 *  subcells (`…__chain_<i>:…`). Returns null for any other id. */
export function parseChainCellId(
  id: string,
): { chainRepeatId: string; instanceIndex: number } | null {
  const m = id.match(/^(.+?)__chain_(\d+)(?:__|:|$)/);
  if (!m) return null;
  return { chainRepeatId: m[1], instanceIndex: Number(m[2]) };
}

/** Materialise the renderer mirror's chain edits into the PSDL body for layout.
 *  Shape-preserving when there are no chain edits (returns the input). */
export function applyChainInstances(
  psdl: PsdlPacket,
  mirror: RendererPacket,
): PsdlPacket {
  const hasChainEdit = mirror.fields.some(
    (f) => f.chainCatalog && (f.chainInstances?.length ?? 0) > 0,
  );
  if (!hasChainEdit) return psdl;
  const defs = psdl.defs ?? {};
  return {
    ...psdl,
    body: psdl.body.flatMap((c) =>
      expandContainer(c, mirror, defs, new Set(), ""),
    ),
  };
}
