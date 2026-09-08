import type {
  ControllerState,
  Packet as RendererPacket,
  ResolvedLayout,
} from "@/lib/psdl/renderer";
import { fieldRendered } from "@/components/field-details/OverridePanel";

/**
 * Which length controllers are INERT: drawn and nominally consuming, but moving
 * them cannot change the diagram, so the panel disables them with a hint rather
 * than offering a live-looking control that does nothing.
 *
 * Extracted from PacketViewer so the probe is directly testable. It was a
 * closure inside a `useMemo`, which meant the only way to exercise it was to
 * mount the whole viewer — and so the upward-only sampling below went unnoticed.
 */
export function collectInertLengthControllers({
  lengthControllers,
  fields,
  base,
  controllers,
  buildEnv,
  resolve,
}: {
  lengthControllers: NonNullable<RendererPacket["lengthControllers"]>;
  fields: RendererPacket["fields"];
  /** The CURRENT resolved layout — the probe compares against its totalBits. */
  base: ResolvedLayout;
  controllers: ControllerState;
  buildEnv: (values: ControllerState) => Map<string, number>;
  resolve: (env: Map<string, number>) => ResolvedLayout;
}): Set<string> {
  const inert = new Set<string>();
  // The largest value each controller can take (mirrors the OverrideSlider
  // clamp: 2**bits-1, falling back to a generous default) so the probe never
  // samples beyond what the user could actually pick.
  const keyMax = new Map<string, number>();
  const note = (key: string | undefined, bits: number | undefined) => {
    if (!key) return;
    const cap = typeof bits === "number" && bits > 0 ? 2 ** bits - 1 : 65535;
    keyMax.set(key, Math.max(keyMax.get(key) ?? 0, cap));
  };
  for (const lc of lengthControllers) {
    note(lc.controlsLength, lc.bits);
  }
  for (const f of fields) {
    note(f.controlsLength, f.bits);
  }
  if (keyMax.size === 0) return inert;
  const baseBits = base.totalBits;
  for (const [key, cap] of keyMax) {
    // Only meaningful when the controlled field is actually in the diagram —
    // an absent field is gated by the separate `fieldRendered` check, and a
    // bumped value there can legitimately materialise a cell (NOT inert).
    if (!fieldRendered(base.cells, key)) continue;
    const current = Number(controllers[key] ?? 0);
    // AFFINE-OFFSET FIX: a length field that sizes a payload through `value - K`
    // (sctp data_userData = bytes(chunkLength - 16), pcep bytes(len - 4), …)
    // stays width-0 until the slider clears K, so a SINGLE small probe below K
    // looks inert even though larger values clearly grow the diagram. Sweep a
    // handful of UPWARD samples and call the controller inert only when NONE of
    // them change the layout — this keeps genuinely fixed-width arms (diameter
    // avpLength, lwm2mRegister tlvLength16/24, ipinip innerIhl) disabled while
    // re-enabling the affine-offset sliders.
    //
    // DOWNWARD samples matter too, and for a different reason: a controller
    // can sit ABOVE what the layout will honour (the product budget divides a
    // single cell allowance across every repeat, so `radius` at
    // attributes=32 stops honouring attrLength past 32). Raising it then
    // changes nothing, so an upward-only probe called it inert and disabled
    // BOTH inputs — leaving no way to bring the value back down. Sampling
    // downward proves the control still does something and keeps it live.
    const probeValues = [
      ...[current + 1, current + 8, current + 32, current + 64, current + 128]
        .map((v) => Math.min(v, cap))
        .filter((v) => v > current),
      ...[current - 1, current - 8, current - 32, current - 64, current - 128]
        .map((v) => Math.max(v, 0))
        .filter((v) => v < current),
    ];
    if (probeValues.length === 0) continue;
    let changed = false;
    for (const probeValue of probeValues) {
      try {
        const probed = resolve(buildEnv({ ...controllers, [key]: probeValue }));
        if (probed.totalBits !== baseBits) {
          changed = true;
          break;
        }
      } catch {
        // A throw means the perturbation DID change the structure (e.g. an
        // over-consumed bounded scope) — treat as live, not inert.
        changed = true;
        break;
      }
    }
    if (!changed) inert.add(key);
  }
  return inert;
}
