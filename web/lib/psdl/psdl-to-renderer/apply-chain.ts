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
): Container[] {
  const sw = getSwitchFromRepeat(repeat);
  if (!sw) return [repeat];
  const out: Container[] = [];
  instances.forEach((inst, i) => {
    const caseStruct = sw.cases[String(inst.proto)];
    if (!caseStruct) return;
    const groupId = `${repeat.id}__chain_${i}`;
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

function expandContainer(c: Container, mirror: RendererPacket): Container[] {
  if (isField(c)) return [c];
  if (c.kind === "repeat" && isLikelyChainRepeat(c)) {
    // The chain catalog merges onto the base field at import (id without the
    // `_chain` suffix), with a standalone-field fallback.
    const baseId = c.id.replace(/_chain$/, "");
    const field =
      mirror.fields.find((f) => f.id === baseId && f.chainCatalog) ??
      mirror.fields.find((f) => f.id === c.id && f.chainCatalog);
    const instances = field?.chainInstances ?? [];
    if (instances.length === 0) return [c];
    return expandChainRepeat(c, instances);
  }
  // Recurse through transparent containers so a chain nested in a bounded
  // scope is still found (defensive; ipv6's chain is top-level).
  if (c.kind === "bounded") {
    return [
      { ...c, fields: c.fields.flatMap((f) => expandContainer(f, mirror)) },
    ];
  }
  if (c.kind === "group") {
    return [
      { ...c, children: c.children.flatMap((f) => expandContainer(f, mirror)) },
    ];
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
  return {
    ...psdl,
    body: psdl.body.flatMap((c) => expandContainer(c, mirror)),
  };
}
