// Merge the runtime renderer mirror's TLV / chain instances back onto a
// PSML packet body without otherwise touching the body's shape.
//
// Background: in editMode the diagram is laid out from `studioState.packet`
// (the user's in-progress schema edit), but TLV / chain edits made via
// the diagram only land on the renderer mirror (via `handleTlvChange` /
// `handleChainChange` → `replaceActivePacket`). They never round-trip
// through the studio reducer. So `studioState.packet` keeps an empty
// Repeat while the diagram visibly carries N records.
//
// Every export path off the studio packet — JSON pane, share URL,
// "Save as preset" — therefore silently drops the user's records. The
// PSML extension landed in 750a76c made instances representable in
// PSML; this helper actually merges them on the way out so the export
// paths reflect what's on screen.

import type { Container, Packet as PsmlPacket } from "../types";
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

function mergeContainer(c: Container, mirror: RendererPacket): Container {
  if (c.kind === "repeat") {
    // TLV Repeats keep their id 1:1 with the renderer field. Chain
    // Repeats (`*_chain`) merge onto a sibling base Field at import
    // time (psmlToRenderer collapses them), so look up the chain
    // mirror field under the stripped id.
    const tlvMirror = findRendererField(mirror, c.id);
    if (tlvMirror?.tlv?.instances && tlvMirror.tlv.instances.length > 0) {
      return {
        ...c,
        instances: tlvMirror.tlv.instances.map((inst) => ({
          kind: inst.kind,
          ...(inst.extras ? { extras: { ...inst.extras } } : {}),
        })),
      };
    }
    const chainBaseId = c.id.replace(/_chain$/, "");
    const chainMirror =
      chainBaseId !== c.id ? findRendererField(mirror, chainBaseId) : tlvMirror;
    if (chainMirror?.chainInstances && chainMirror.chainInstances.length > 0) {
      return {
        ...c,
        chainInstances: chainMirror.chainInstances.map((inst) => ({
          proto: inst.proto,
        })),
      };
    }
    return c;
  }
  if (c.kind === "group") {
    return {
      ...c,
      children: c.children.map((ch) => mergeContainer(ch, mirror)),
    };
  }
  return c;
}

/** Return a new PSML packet whose Repeat containers carry the renderer
 *  mirror's current TLV / chain instances. Non-Repeat containers and any
 *  Repeat whose mirror field has no instances are returned unchanged so
 *  the merge is O(body) and shape-preserving. */
export function mergeInstancesIntoPsml(
  psml: PsmlPacket,
  mirror: RendererPacket,
): PsmlPacket {
  return {
    ...psml,
    body: psml.body.map((c) => mergeContainer(c, mirror)),
  };
}
