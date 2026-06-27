// high (see-but-cannot-edit): oncRpc's `rpcBody` switch (on rpcMsgType, an
// editable top-level enum) has a Reply arm carrying a CHAIN of nested switches:
// `replyData` (on replyStat) → `acceptData` (on acceptStat) and `rejectData`
// (on rejectStat). When the user picks Reply, replyStat/acceptStat (and, via
// replyStat, rejectStat) become VISIBLE cells whose values drive the layout
// (acceptStat=2 → acceptMismatchLow/High; replyStat=1 → rejectStat →
// rejectMismatchLow/High). But all three discriminators are declared INSIDE
// switch cases, so they are not top-level renderer-mirror fields:
// attachOverrideMetadata.findTarget can't stamp switchCases on them, and
// collectRefSwitches' repeat path never reaches them (they're not inside a
// repeat). The user could SEE the cells and watch them change the packet but
// had NO control to edit them.
//
// collectRefSwitches now also surfaces a packet-level refSwitch picker for a
// ref-discriminated switch whose discriminator field is declared inside an
// outer switch case (and is NOT inside any repeat — a switch inside a chain/TLV
// repeat is already owned by the chain/TLV editor). oncRpc is the only built-in
// preset with this switch-in-switch-case pattern.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { isField } from "@/lib/psdl/utils";
import type { Container, Packet as PsdlPacket } from "@/lib/psdl/types";

function cellIds(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): string[] {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.map((c) => c.field.id);
}

/** Ids of every field declared (transitively) inside a switch case. */
function switchCaseFieldIds(
  containers: Container[],
  inside = false,
  acc = new Set<string>(),
): Set<string> {
  for (const c of containers) {
    if (isField(c)) {
      if (inside) acc.add(c.id);
      continue;
    }
    if (c.kind === "switch") {
      for (const s of Object.values(c.cases))
        switchCaseFieldIds(s.fields, true, acc);
    } else if (c.kind === "repeat") {
      switchCaseFieldIds(c.element.fields, inside, acc);
    } else if (c.kind === "group") {
      switchCaseFieldIds(c.children, inside, acc);
    } else if (c.kind === "bounded") {
      switchCaseFieldIds(c.fields, inside, acc);
    } else if (c.kind === "optional") {
      switchCaseFieldIds([c.container], inside, acc);
    } else if (c.kind === "encrypted") {
      switchCaseFieldIds(c.plaintext.fields, inside, acc);
    }
  }
  return acc;
}

describe("oncRpc nested switch discriminators", () => {
  it("surfaces refSwitch pickers for replyStat/acceptStat/rejectStat", () => {
    const mirror = psdlToRenderer(PRESETS.oncRpc!);

    const refKeys = (mirror.refSwitches ?? []).map((r) => r.refKey).sort();
    expect(refKeys).toEqual(["acceptStat", "rejectStat", "replyStat"]);

    // Each picker offers at least its two declared variants.
    for (const r of mirror.refSwitches ?? []) {
      expect(r.cases.length).toBeGreaterThanOrEqual(2);
    }

    // The OUTER discriminator (rpcMsgType) is a top-level field and keeps its
    // own switchCases widget — it must NOT be duplicated as a refSwitch.
    expect(refKeys).not.toContain("rpcMsgType");
    const rpcMsgType = mirror.fields.find((f) => f.id === "rpcMsgType");
    expect(rpcMsgType?.switchCases?.length).toBe(2);
  });

  it("the surfaced pickers actually change resolveLayout cells", () => {
    const src = PRESETS.oncRpc!;

    // Picking Reply (rpcMsgType=1) makes replyStat + acceptStat visible.
    const reply = cellIds(src, { rpcMsgType: 1 });
    expect(reply).toContain("replyStat");
    expect(reply).toContain("acceptStat");

    // Driving acceptStat → PROG_MISMATCH (2) reveals the version range — proof
    // the acceptStat picker key is the real one the layout reads.
    const mismatch = cellIds(src, {
      rpcMsgType: 1,
      replyStat: 0,
      acceptStat: 2,
    });
    expect(mismatch).toContain("acceptMismatchLow");
    expect(mismatch).toContain("acceptMismatchHigh");

    // Driving replyStat → MSG_DENIED (1) reveals rejectStat, and rejectStat →
    // RPC_MISMATCH (0) reveals its version range — both nested levels respond.
    const reject = cellIds(src, {
      rpcMsgType: 1,
      replyStat: 1,
      rejectStat: 0,
    });
    expect(reject).toContain("rejectStat");
    expect(reject).toContain("rejectMismatchLow");
    expect(reject).toContain("rejectMismatchHigh");
  });

  it("oncRpc is the only preset with switch-in-switch-case discriminators", () => {
    // Regression canary: a refSwitch whose discriminator is declared inside a
    // switch case (rather than inside a repeat) is the switch-in-switch-case
    // surface this fix adds. If another preset starts matching, re-audit the
    // relaxed guard (chain/TLV-repeat-nested switches must stay excluded).
    //
    // The lookup-discriminator AFI pickers (id `<field>_byAfi`, e.g. pgm's NLA
    // AFIs) are a SEPARATE surface — a `bytes(lookup(ref X, table))` width
    // selector, not a nested Switch — that also happens to live inside switch
    // cases. They are excluded here so this canary keeps guarding ONLY the
    // switch-in-switch-case path.
    const affected = Object.keys(PRESETS).filter((key) => {
      const psdl = PRESETS[key]!;
      const caseIds = switchCaseFieldIds(psdl.body);
      return (psdlToRenderer(psdl).refSwitches ?? []).some(
        (r) => !r.id.endsWith("_byAfi") && caseIds.has(r.refKey),
      );
    });
    expect(affected).toEqual(["oncRpc"]);
  });
});
