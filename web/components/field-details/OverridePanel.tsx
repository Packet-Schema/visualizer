import { useId, useRef, useState } from "react";

import type {
  Cell,
  ChainInstance,
  ControllerState,
  Field,
  Packet,
  SubField,
  TlvInstance,
} from "@/lib/psdl/renderer";

import SliderTooltip from "../controls/SliderTooltip";
import ChainEditor, { FINAL_PROTOS, NO_NEXT_HEADER_PROTO } from "./ChainEditor";
import TlvEditor, { SlotOvershootWarning } from "./TlvEditor";
import { tlvTotalBits } from "@/lib/psdl/renderer-helpers";
import { resolveSelection } from "./selection-resolver";
import { parseTlvCellId } from "./tlv-cell-id";
import { parseChainCellId } from "@/lib/psdl/psdl-to-renderer";
import {
  BER_LENGTH_DEFAULT_BITS,
  DELIMITED_DEFAULT_BYTES,
  VARINT_DEFAULT_BITS,
} from "@/lib/psdl/dynamic-width-defaults";
import { berLenEnvKey } from "@/lib/psdl/normalize";

// `OverridePanel` is the editing surface for a selected diagram cell. It
// dispatches one of six widgets based on what the cell's logical parent
// exposes (TLV / chain / switch / varint / berLength / optional / length
// controller). Falls back to an empty state when no override applies.
// The visual marker (accent underline on overridable cells in
// HybridDiagram) hints which cells reach a non-empty state.

type Props = {
  packet: Packet;
  selectedFieldId: string | null;
  controllers: ControllerState;
  onTlvChange?: (field: Field, next: TlvInstance[]) => void;
  onChainChange?: (
    field: Field,
    next: { instances: ChainInstance[]; finalProto?: number },
  ) => void;
  onControllerChange?: (key: string, value: number) => void;
  onByteOrderChange?: (fieldId: string, byteOrder: "BE" | "LE") => void;
  /** Controller-derived slot bytes per TLV field id (= `(IHL−5)*4` for
   *  IPv4 / TCP). Used to warn the user when records exceed the slot. */
  tlvSlotBytes?: Record<string, number>;
  /** Diagram cells, used to resolve clicks on cells that have no renderer
   *  mirror field (records inside a plain repeat). */
  cells?: readonly Cell[];
  /** `controlsLength` keys whose slider is INERT in the current diagram: the
   *  controlled field renders, but the ACTIVE switch/refSwitch arm sizes its
   *  value fixed, so perturbing the length changes zero cell widths
   *  (dnsResponse's dnsRdLength at the seeded A-record arm). PacketViewer probes
   *  this by re-resolving with the value bumped; OverridePanel gates such a
   *  slider with a hint pointing at the variant picker instead of a live-looking
   *  but inert control (same class as the absent-field `fieldRendered` gate). */
  inertLengthControllers?: ReadonlySet<string>;
};

/** True when a field id is materialised as a cell (or sub-cell) in the current
 *  diagram. Repeat-instanced cells carry a `#<rec>_<seg>` suffix, so we match on
 *  the id itself OR a `<id>#…` instance, using the `#` boundary to avoid a
 *  prefix collision (`pgmSpmNla` vs `pgmSpmNlaAfi`). Used to gate a refSwitch
 *  picker: its discriminator only renders once the ancestor switch arm is
 *  selected (oncRpc's rpcMsgType→replyStat→acceptStat chain) AND its enclosing
 *  repeat has a record (lispMapReply's per-record locator AFI), so a rendered
 *  discriminator cell is an exact, layout-faithful "this picker is live" signal. */
export function fieldRendered(
  cells: readonly Cell[] | undefined,
  id: string,
): boolean {
  if (!cells) return false;
  const prefix = `${id}#`;
  for (const c of cells) {
    if (c.field.id === id || c.field.id.startsWith(prefix)) return true;
    for (const s of c.subCells ?? []) {
      if (s.subfield.id === id || s.subfield.id.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** Whether a length-controller slider's FIELD is present-and-consuming in the
 *  current diagram (stage 1 of the live gate; stage 2 — inert-but-rendered — is
 *  the PacketViewer `inertLengthControllers` probe).
 *
 *  The naive signal (is the Length octet rendered?) is WRONG when the octet
 *  renders in arms that don't consume it: pimHelloOptLen's Length cell is in
 *  every PIM Hello option arm, but only arms 24 (Address List) / `_` (unknown)
 *  size a value (`bytes(ref pimHelloOptLen)`) with it; the seeded Holdtime arm's
 *  value is a fixed 16-bit int, so dragging the slider is inert. When the
 *  controller carries `lengthSizesFieldIds` (the value fields it actually sizes),
 *  gate on whether ANY of those is a rendered cell. Otherwise fall back to the
 *  Length cell's own render state (length controllers whose sized value isn't
 *  tracked — e.g. bounded-budget lengths — keep their prior behaviour). */
function lengthControllerLive(
  lc: Field,
  cells: readonly Cell[] | undefined,
): boolean {
  const sized = lc.lengthSizesFieldIds;
  if (sized && sized.length > 0) {
    return sized.some((id) => fieldRendered(cells, id));
  }
  return lc.controlsLength ? fieldRendered(cells, lc.controlsLength) : true;
}

function EmptyState({
  message,
  packet,
  controllers,
  onControllerChange,
  onTlvChange,
  tlvSlotBytes,
  cells,
  inertLengthControllers,
}: {
  message: string;
  packet: Packet;
  controllers: ControllerState;
  onControllerChange?: (key: string, value: number) => void;
  onTlvChange?: (field: Field, next: TlvInstance[]) => void;
  tlvSlotBytes?: Record<string, number>;
  cells?: readonly Cell[];
  inertLengthControllers?: ReadonlySet<string>;
}) {
  // Packet-level extras (free Repeats, peek Switches) surface here so the
  // panel never reads as truly empty when the packet has stoppable knobs
  // that aren't anchored to a single cell.
  // A switch-case-nested repeat (icmpv6Ndp's rsOptions/raOptions/…) carries a
  // discriminator `gate`: it can only instantiate records when the diagram is
  // rendering its owning message-type arm. Surface its stepper ONLY when the
  // discriminator currently selects that arm — otherwise the panel would show a
  // live count over an arm the diagram isn't drawing (a panel-vs-diagram
  // contradiction; the other four NDP option steppers at any moment). Ungated
  // freeRepeats are always shown.
  const free = (packet.freeRepeats ?? []).filter(
    (r) => !r.gate || controllers[r.gate.key] === r.gate.value,
  );
  const peeks = packet.peekSwitches ?? [];
  const refs = packet.refSwitches ?? [];
  const lengthCtrls = packet.lengthControllers ?? [];
  const boundedLengthKeys = new Set(
    (packet.boundedRepeats ?? []).map((br) => br.lengthKey),
  );
  // TLVs without an explicit slot (= preset not in TLV_LENGTH_SYNC) won't
  // emit a placeholder cell in the diagram. Surface them here so TLS /
  // CoAP / etc. have a persistent first-edit entry point — and KEEP them
  // listed even after a record is added, because the only diagram click
  // targets at that point are instance/leaf cells which route to the
  // inline variant dropdown, not the full add/remove/reorder TlvEditor.
  // Without the persistent listing the user loses access to those bulk
  // operations once they pick the first record (Codex P1).
  const unanchoredTlvs = packet.fields.filter(
    (f) => f.tlv && (tlvSlotBytes?.[f.id] ?? 0) === 0,
  );
  return (
    <div className="space-y-3">
      <p className="m-0 text-sm-tight text-fg-faint">{message}</p>
      {unanchoredTlvs.length > 0 && onTlvChange ? (
        <div className="pt-2 border-t" style={{ borderColor: "var(--border)" }}>
          <WidgetLabel>TLV editors in this packet</WidgetLabel>
          <div className="space-y-2">
            {unanchoredTlvs.map((f) => (
              <UnanchoredTlvCard
                key={f.id}
                field={f}
                controllers={controllers}
                onChange={(next) => onTlvChange(f, next)}
              />
            ))}
          </div>
        </div>
      ) : null}
      {free.length > 0 && onControllerChange ? (
        <div className="pt-2 border-t" style={{ borderColor: "var(--border)" }}>
          <WidgetLabel>Repeats in this packet</WidgetLabel>
          <div className="space-y-2">
            {free.map((r) => (
              <RepeatCountStepper
                key={r.countKey}
                name={r.name}
                countKey={r.countKey}
                transform={r.transform}
                controllers={controllers}
                onChange={onControllerChange}
                // An OPTIONAL-wrapped repeat carries `gateFieldId` (a switch-case
                // gate uses `gate` and is dropped above instead). Its enclosing
                // `optional{when: ref(X)}` is absent at load, so the count stepper
                // would read live over a diagram drawing nothing from the section
                // — disable it with a hint until an inner field renders, the same
                // gate a refSwitch picker uses (#13, panel-vs-diagram contradiction
                // for arbitrary PSDL). `cells` IS the live diagram.
                disabledHint={
                  r.gateFieldId && !fieldRendered(cells, r.gateFieldId)
                    ? "Set the enclosing optional's condition (its field) to edit"
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      ) : null}
      {peeks.length > 0 && onControllerChange ? (
        <div className="pt-2 border-t" style={{ borderColor: "var(--border)" }}>
          <WidgetLabel>Peek-based switches</WidgetLabel>
          <div className="space-y-2">
            {peeks.map((p) => (
              <PeekSwitchPicker
                key={p.id}
                switchName={p.name}
                peekKey={p.peekKey}
                cases={p.cases}
                controllers={controllers}
                onChange={onControllerChange}
                // peekSwitches were never `fieldRendered`-gated, so a picker whose
                // arm isn't drawn (its enclosing repeat has no record, or it sits
                // in an absent `optional{when: ref(X)}` region) read live over a
                // diagram drawing nothing. `gateFieldId` anchors on the seeded
                // arm's inner field — present in every preset at load, so this is
                // non-regressing — and disables the picker with a hint otherwise,
                // the same gate the refSwitch picker uses. `cells` IS the live
                // diagram.
                disabledHint={
                  p.gateFieldId && !fieldRendered(cells, p.gateFieldId)
                    ? "Reveal this region (set its enclosing condition / add a record) to edit"
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      ) : null}
      {refs.length > 0 && onControllerChange ? (
        <div className="pt-2 border-t" style={{ borderColor: "var(--border)" }}>
          <WidgetLabel>Record variants</WidgetLabel>
          <div className="space-y-2">
            {refs.map((r) => (
              <PeekSwitchPicker
                key={r.id}
                switchName={r.name}
                peekKey={r.refKey}
                cases={r.cases}
                controllers={controllers}
                onChange={onControllerChange}
                // A refSwitch's discriminator field only renders once its ancestor
                // switch arm is selected (oncRpc rpcMsgType→replyStat→acceptStat)
                // and its enclosing repeat has a record (lispMapReply locator AFI).
                // Until then the picker can't change the diagram — it would
                // contradict an empty/wrong-arm packet — so disable it with a hint
                // pointing at the discriminator to set, instead of showing a live
                // control with no effect (#11/#12, same class as the seeded length
                // controllers). Layout-faithful: `cells` IS the live diagram.
                disabledHint={
                  fieldRendered(cells, r.refKey)
                    ? undefined
                    : `Set ${r.refKey} (select its parent variant / add a record) to edit`
                }
              />
            ))}
          </div>
        </div>
      ) : null}
      {lengthCtrls.length > 0 && onControllerChange ? (
        <div className="pt-2 border-t" style={{ borderColor: "var(--border)" }}>
          <WidgetLabel>Length controllers</WidgetLabel>
          <div className="space-y-2">
            {lengthCtrls.map((lc) => {
              // Two-stage live-gate. (1) ABSENT/NON-CONSUMING field: a length
              // controller can only move bits once its switch arm is selected /
              // its record is instantiated (socks5's socksDomainLen only sizes a
              // payload when socksAtyp=domain). `lengthControllerLive` keys on the
              // VALUE field it sizes when known (`lengthSizesFieldIds` —
              // pimHelloOptLen's Length octet renders in EVERY PIM Hello option
              // arm, but only arms 24/`_` consume it; the seeded Holdtime arm's
              // value is a fixed 16-bit int), else the Length octet's own render
              // state. (2) INERT field: the field IS drawn AND nominally
              // consuming, but the ACTIVE refSwitch arm sizes its value FIXED so
              // moving the slider changes zero cell widths (dnsResponse's
              // dnsRdLength at the seeded A-record arm). PacketViewer's re-resolve
              // probe (`inertLengthControllers`) catches (2). Either way disable
              // with a hint pointing at the variant to select first, instead of a
              // live-looking but inert control. `cells` IS the live diagram, so
              // this is layout-faithful.
              const fieldThere = lengthControllerLive(lc, cells);
              const inert =
                !!lc.controlsLength &&
                !!inertLengthControllers?.has(lc.controlsLength);
              const live = fieldThere && !inert;
              const disabledHint = fieldThere
                ? inert
                  ? `Raise ${lc.controlsLength} past its header, or select the variant it sizes, to grow its value`
                  : undefined
                : `Select its variant / add a record to edit ${lc.controlsLength}`;
              return (
                <OverrideSlider
                  key={lc.id}
                  field={lc}
                  controllers={controllers}
                  drivenByTlv={false}
                  maxBytes={
                    lc.controlsLength &&
                    !boundedLengthKeys.has(lc.controlsLength)
                      ? MAX_LENGTH_CONTROLLER_BYTES
                      : undefined
                  }
                  disabledHint={live ? undefined : disabledHint}
                  onChange={onControllerChange}
                />
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function UnanchoredTlvCard({
  field,
  controllers,
  onChange,
}: {
  field: Field;
  controllers: ControllerState;
  onChange: (next: TlvInstance[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full px-2 py-1.5 rounded border text-left text-sm-tight cursor-pointer"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--bg-elevated)",
          color: "var(--fg)",
        }}
      >
        {open ? "▾" : "▸"} {field.name}{" "}
        <span className="text-3xs text-fg-muted">
          ({field.tlv?.catalog.length ?? 0} variants)
        </span>
      </button>
      {open ? (
        <div id={panelId} className="mt-2">
          <TlvEditor
            field={field}
            controllers={controllers}
            onChange={onChange}
          />
        </div>
      ) : null}
    </div>
  );
}

export default function OverridePanel({
  packet,
  selectedFieldId,
  controllers,
  onTlvChange,
  onChainChange,
  onControllerChange,
  onByteOrderChange,
  tlvSlotBytes,
  cells,
  inertLengthControllers,
}: Props) {
  // TLV cells emitted by `applyTlvInstances` carry synthetic ids that
  // don't live in `packet.fields`. `parseTlvCellId` peels back the role
  // so we can route each click to the right editor:
  //   * instance / leaf  → inline variant dropdown for that one record
  //   * remaining        → full TlvEditor so the user can append more
  // Plain ids fall through to `resolveSelection` below.
  if (selectedFieldId) {
    const role = parseTlvCellId(selectedFieldId);
    if (role.kind === "instance" || role.kind === "leaf") {
      // Resolve the parent TLV first WITHOUT requiring the specific
      // instance to still exist. If the user removed the record between
      // the cell render and the click, falling back to the full
      // TlvEditor (instead of "Field not found") keeps the editing
      // surface reachable.
      const parent = packet.fields.find((f) => f.id === role.baseId && f.tlv);
      if (parent?.tlv && onTlvChange) {
        const instance = parent.tlv.instances[role.instanceIndex];
        if (instance) {
          return (
            <TlvInnerVariantDropdown
              tlvField={parent}
              instanceIndex={role.instanceIndex}
              onChange={(next) => onTlvChange(parent, next)}
              slotBytes={tlvSlotBytes?.[parent.id]}
            />
          );
        }
        // Instance vanished — fall back to the full editor.
        return (
          <TlvEditor
            field={parent}
            controllers={controllers}
            onChange={(next) => onTlvChange(parent, next)}
            slotBytes={tlvSlotBytes?.[parent.id]}
          />
        );
      }
    }
    if (role.kind === "remaining") {
      const parent = packet.fields.find((f) => f.id === role.baseId && f.tlv);
      if (parent?.tlv && onTlvChange) {
        return (
          <TlvEditor
            field={parent}
            controllers={controllers}
            onChange={(next) => onTlvChange(parent, next)}
            slotBytes={tlvSlotBytes?.[parent.id]}
          />
        );
      }
    }
  }

  // A click on a materialised IPv6 extension-header cell routes to a
  // per-instance editor (change this header's type / remove it) instead of
  // sending the user back to the whole-chain editor on the base Next Header.
  if (selectedFieldId && onChainChange) {
    const chainRole = parseChainCellId(selectedFieldId);
    if (chainRole) {
      const baseId = chainRole.chainRepeatId.replace(/_chain$/, "");
      const chainField = packet.fields.find(
        (f) =>
          (f.id === baseId || f.id === chainRole.chainRepeatId) &&
          f.chainCatalog,
      );
      if (chainField?.chainInstances?.[chainRole.instanceIndex]) {
        return (
          <ChainInnerVariantDropdown
            field={chainField}
            instanceIndex={chainRole.instanceIndex}
            onChange={(next) => onChainChange(chainField, next)}
          />
        );
      }
    }
  }

  const r = resolveSelection(packet, selectedFieldId, cells);

  const emptyProps = {
    packet,
    controllers,
    onControllerChange,
    onTlvChange,
    tlvSlotBytes,
    cells,
    inertLengthControllers,
  };

  if (r.kind === "empty") {
    return (
      <EmptyState
        message="Select a cell to edit its override."
        {...emptyProps}
      />
    );
  }
  if (r.kind === "subfield-not-found") {
    return <EmptyState message="Subfield not found." {...emptyProps} />;
  }
  if (r.kind === "field-not-found") {
    return <EmptyState message="Field not found." {...emptyProps} />;
  }

  // Subfields can carry the same override metadata as top-level fields
  // (e.g. the discriminator of a Switch may live inside a Group). Render
  // the matching widgets here; fall through to the parent's override
  // when the subfield itself has no metadata.
  if (r.kind === "subfield") {
    const widgets = subfieldWidgets(
      r.sub,
      r.parent,
      controllers,
      onControllerChange,
      onByteOrderChange,
    );
    if (widgets.length === 0) {
      return (
        <EmptyState
          message="Subfields share their parent's override. Select the parent cell."
          {...emptyProps}
        />
      );
    }
    return <div className="space-y-4">{widgets}</div>;
  }

  const field = r.field;
  const widgets: React.ReactNode[] = [];

  if (field.tlv && onTlvChange) {
    return (
      <TlvEditor
        field={field}
        controllers={controllers}
        onChange={(next) => onTlvChange(field, next)}
        slotBytes={tlvSlotBytes?.[field.id]}
      />
    );
  }

  if (field.chainCatalog && onChainChange) {
    return (
      <ChainEditor
        field={field}
        onChange={(next) => onChainChange(field, next)}
      />
    );
  }

  const fieldTarget = fieldAsTarget(field);
  if (field.switchCases && onControllerChange) {
    widgets.push(
      <SwitchDropdown
        key="switch"
        target={fieldTarget}
        controllers={controllers}
        onChange={onControllerChange}
      />,
    );
  }

  if (field.enumVariants && onControllerChange) {
    widgets.push(
      <EnumDropdown
        key="enum"
        target={fieldTarget}
        controllers={controllers}
        onChange={onControllerChange}
      />,
    );
  }

  // Suppress the berLength width picker for a leaf nested in a tight
  // value-budgeted bounded scope: every non-default width overflows the fixed
  // budget and freezes the diagram, so the picker is inert / misleading. The
  // resolved field id may carry a per-instance repeat suffix (`requestSeqLength#0`),
  // so compare on the bare id. See `berLengthWidthLocked` on the renderer Packet.
  const berLengthWidthLocked = field.isBerLength
    ? (packet.berLengthWidthLocked ?? []).includes(stripRepeatTag(field.id))
    : false;
  if (
    (field.varintEncoding ||
      (field.isBerLength && !berLengthWidthLocked) ||
      field.isDelimited) &&
    onControllerChange
  ) {
    widgets.push(
      <WidthPicker
        key="width"
        target={fieldTarget}
        controllers={controllers}
        onChange={onControllerChange}
      />,
    );
  }

  if (field.optionalGateFor && onControllerChange) {
    widgets.push(
      <OptionalToggle
        key="optional"
        target={fieldTarget}
        controllers={controllers}
        onChange={onControllerChange}
      />,
    );
  }

  if (field.byteOrder && onByteOrderChange) {
    widgets.push(
      <ByteOrderToggle
        key="byteOrder"
        fieldId={field.id}
        current={field.byteOrder}
        onChange={onByteOrderChange}
      />,
    );
  }

  if (field.controlsLength && onControllerChange) {
    const drivenByTlv = packet.fields.some(
      (f) => f.tlv && f.tlv.drivesController === field.controlsLength,
    );
    // A direct `bytes(ref X)` length controller gets a renderable byte cap so
    // dragging the slider can't explode the un-virtualized diagram. A
    // boundedRepeat-driven length cell keeps the full int range (its derived
    // record count is capped in PacketViewer instead).
    const isBoundedLength = (packet.boundedRepeats ?? []).some(
      (br) => br.lengthKey === field.controlsLength,
    );
    widgets.push(
      <OverrideSlider
        key="slider"
        field={field}
        controllers={controllers}
        drivenByTlv={drivenByTlv}
        maxBytes={isBoundedLength ? undefined : MAX_LENGTH_CONTROLLER_BYTES}
        onChange={onControllerChange}
      />,
    );
  }

  if (widgets.length === 0) {
    return (
      <EmptyState
        message="This field has no runtime override. Read-only display."
        {...emptyProps}
      />
    );
  }

  return <div className="space-y-4">{widgets}</div>;
}

/** Build widgets for a subfield whose Group child carries override metadata
 *  (the discriminator / gate / data-dependent type lives inside a Group,
 *  not at the top level). The subfield's `id` is the env key, just like a
 *  top-level field. */
function subfieldWidgets(
  sub: SubField,
  parent: Field,
  controllers: ControllerState,
  onControllerChange: ((key: string, value: number) => void) | undefined,
  onByteOrderChange?: (fieldId: string, byteOrder: "BE" | "LE") => void,
): React.ReactNode[] {
  // A Group-nested multi-byte field with an explicit byteOrder carries no env
  // override but DOES need a BE/LE toggle (it renders a `[LE]`/`[BE]` marker on
  // the diagram). Surface it even when the subfield has no controller widgets,
  // so the toggle isn't gated behind `onControllerChange`.
  const byteOrderWidget =
    sub.byteOrder && onByteOrderChange ? (
      <ByteOrderToggle
        key="byteOrder"
        fieldId={sub.id}
        current={sub.byteOrder}
        onChange={onByteOrderChange}
      />
    ) : null;
  if (!onControllerChange) return byteOrderWidget ? [byteOrderWidget] : [];
  const target: WidgetTarget = {
    id: sub.id,
    name: `${sub.name} (in ${parent.name})`,
    defaultValue: sub.defaultValue,
    switchCases: sub.switchCases,
    varintEncoding: sub.varintEncoding,
    isBerLength: sub.isBerLength,
    isDelimited: sub.isDelimited,
    optionalGateFor: sub.optionalGateFor,
    enumVariants: sub.enumVariants,
  };
  const out: React.ReactNode[] = [];
  if (sub.switchCases) {
    out.push(
      <SwitchDropdown
        key="switch"
        target={target}
        controllers={controllers}
        onChange={onControllerChange}
      />,
    );
  }
  if (sub.varintEncoding || sub.isBerLength || sub.isDelimited) {
    out.push(
      <WidthPicker
        key="width"
        target={target}
        controllers={controllers}
        onChange={onControllerChange}
      />,
    );
  }
  if (sub.enumVariants) {
    out.push(
      <EnumDropdown
        key="enum"
        target={target}
        controllers={controllers}
        onChange={onControllerChange}
      />,
    );
  }
  if (sub.optionalGateFor) {
    out.push(
      <OptionalToggle
        key="optional"
        target={target}
        controllers={controllers}
        onChange={onControllerChange}
      />,
    );
  }
  if (byteOrderWidget) out.push(byteOrderWidget);
  return out;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/** Minimal interface the override widgets need. Both top-level Field and
 *  Group SubField implement this shape (the latter via `subfieldWidgets`). */
type WidgetTarget = {
  id: string;
  name: string;
  defaultValue?: number;
  switchCases?: Field["switchCases"];
  varintEncoding?: Field["varintEncoding"];
  isBerLength?: Field["isBerLength"];
  isDelimited?: Field["isDelimited"];
  optionalGateFor?: Field["optionalGateFor"];
  enumVariants?: Field["enumVariants"];
};

// A field authored INSIDE a plain repeat surfaces on the diagram as a cell whose
// id carries a per-instance repeat suffix (`#N` or `#i_j`). resolveLayout reads
// every per-record field from its BARE authored env key (layout.ts stripRepeatTag),
// so a widget must drive the bare key — writing env[id#0_0] is a no-op the layout
// never reads. Top-level and TLV-synthetic ids carry no such suffix, so this is a
// no-op there.
function stripRepeatTag(id: string): string {
  return id.replace(/#\d+(?:_\d+)*$/, "");
}

function fieldAsTarget(f: Field): WidgetTarget {
  return {
    id: stripRepeatTag(f.id),
    name: f.name,
    defaultValue: f.defaultValue,
    switchCases: f.switchCases,
    varintEncoding: f.varintEncoding,
    isBerLength: f.isBerLength,
    isDelimited: f.isDelimited,
    optionalGateFor: f.optionalGateFor,
    enumVariants: f.enumVariants,
  };
}

function WidgetLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 mb-1 text-3xs uppercase tracking-wider font-bold text-fg-muted">
      {children}
    </p>
  );
}

// Cap (in bytes) for a DIRECT length-controller slider — a `controlsLength` cell
// that sizes a `bytes(ref X)` payload. resolveLayout emits ~1 diagram cell per
// payload byte, so without this the slider's max (the length field's full int
// range, up to 2**32-1) lets a drag generate millions-to-billions of cells in the
// un-virtualized SVG diagram → freeze / OOM. PacketViewer applies the matching
// layout-only clamp (MAX_LENGTH_CONTROLLER_BYTES = MAX_DERIVED_RECORDS); keep the
// two values in sync. boundedRepeat-driven length sliders are EXEMPT (their
// derived record count is capped separately), so they keep the full int range.
const MAX_LENGTH_CONTROLLER_BYTES = 1024;

// Ceiling on a freeRepeat's DISPLAYED record count (the value the stepper shows
// and writes through). resolveLayout emits ~6-20 diagram cells per record, so an
// uncapped count freezes the un-virtualized diagram. PacketViewer applies the
// matching layout-only clamp (MAX_DERIVED_RECORDS) to env[countKey] before
// resolveLayout — including the share-URL / JSON-import path that never touches
// this input — so keep the two values in sync.
const MAX_REPEAT_RECORDS = 1024;

type SliderProps = {
  field: Field;
  controllers: ControllerState;
  drivenByTlv: boolean;
  /** When set, the renderable byte ceiling for a direct length controller — the
   *  slider/number max is clamped here so the input can't request an explosive
   *  (freeze/OOM) payload. Omitted for boundedRepeat-driven length sliders. */
  maxBytes?: number;
  /** When set, the controlled field is NOT in the current diagram (its switch
   *  arm is unselected / its record isn't instantiated), so dragging the slider
   *  can't change anything. Render the inputs disabled with this hint telling
   *  the user what to set first, instead of a live-looking but inert control
   *  (same gate as the refSwitch picker). Absent = live. */
  disabledHint?: string;
  onChange: (key: string, value: number) => void;
};

function OverrideSlider({
  field,
  controllers,
  drivenByTlv,
  maxBytes,
  disabledHint,
  onChange,
}: SliderProps) {
  const key = field.controlsLength!;
  const value = controllers[key] ?? field.defaultValue ?? 0;
  const min = field.min ?? 0;
  const fullMax =
    field.max ?? (typeof field.bits === "number" ? 2 ** field.bits - 1 : 255);
  const max =
    typeof maxBytes === "number" ? Math.min(fullMax, maxBytes) : fullMax;
  const sliderId = `detail-ctrl-${field.id}-slider`;
  const numberId = `detail-ctrl-${field.id}-number`;
  const labelId = `detail-ctrl-${field.id}-label`;
  const apply = (raw: string) => {
    const n = Math.max(min, Math.min(max, Number(raw)));
    if (Number.isFinite(n)) onChange(key, n);
  };

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const disabled = disabledHint !== undefined;

  return (
    <div>
      <label
        htmlFor={sliderId}
        id={labelId}
        className="block mb-1 text-3xs uppercase tracking-wider font-bold text-fg-muted"
      >
        Length · drives <code className="font-mono normal-case">{key}</code>
      </label>
      <div
        className="flex items-center gap-2.5"
        style={{ opacity: disabled ? 0.55 : 1 }}
      >
        <span className="pv-slider-wrap flex-1">
          <input
            suppressHydrationWarning
            ref={inputRef}
            id={sliderId}
            type="range"
            min={min}
            max={max}
            value={value}
            disabled={disabled}
            onChange={(e) => apply(e.target.value)}
            onPointerDown={() => setTooltipVisible(true)}
            onPointerUp={() => setTooltipVisible(false)}
            onPointerCancel={() => setTooltipVisible(false)}
            onFocus={() => setTooltipVisible(true)}
            onBlur={() => setTooltipVisible(false)}
            className="pv-slider"
            aria-labelledby={labelId}
            style={{ cursor: disabled ? "not-allowed" : undefined }}
          />
          <SliderTooltip
            value={Number(value)}
            min={min}
            max={max}
            visible={tooltipVisible}
            inputRef={inputRef}
          />
        </span>
        <input
          suppressHydrationWarning
          id={numberId}
          type="number"
          min={min}
          max={max}
          value={value}
          disabled={disabled}
          onChange={(e) => apply(e.target.value)}
          aria-labelledby={labelId}
          className="w-16 px-2 py-1 rounded-md border font-mono tabular-nums text-sm-tight"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--fg)",
            cursor: disabled ? "not-allowed" : undefined,
          }}
        />
      </div>
      {disabledHint ? (
        <p className="mt-1.5 text-3xs text-fg-muted m-0">{disabledHint}</p>
      ) : null}
      {drivenByTlv ? (
        <p className="mt-1.5 text-3xs text-fg-muted m-0">
          Synced from TLV editor — direct edits reset on the next TLV change.
        </p>
      ) : null}
    </div>
  );
}

type WidgetProps = {
  target: WidgetTarget;
  controllers: ControllerState;
  onChange: (key: string, value: number) => void;
};

function SwitchDropdown({ target, controllers, onChange }: WidgetProps) {
  const cases = target.switchCases ?? [];
  const selectId = `detail-switch-${target.id}`;
  // Defensive: a degenerate preset with no Switch cases would otherwise
  // produce an empty `<select>` with `value={undefined}` — uncontrolled
  // input, no options to pick. Bail out with a clear empty state instead
  // (sub-agent Round 9 MEDIUM).
  if (cases.length === 0) {
    return (
      <div>
        <WidgetLabel>Switch case · sets {target.id}</WidgetLabel>
        <p className="text-xs text-fg-muted m-0">
          No cases declared for this switch.
        </p>
      </div>
    );
  }
  const current =
    controllers[target.id] ?? target.defaultValue ?? cases[0].value;
  return (
    <div>
      <label htmlFor={selectId}>
        <WidgetLabel>Switch case · sets {target.id}</WidgetLabel>
      </label>
      <select
        id={selectId}
        value={current}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(target.id, v);
        }}
        className="w-full px-2 py-1.5 rounded-md border font-mono text-sm-tight"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--bg-elevated)",
          color: "var(--fg)",
        }}
      >
        {cases.map((c) => (
          <option key={c.value} value={c.value}>
            {c.value} — {c.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function WidthPicker({ target, controllers, onChange }: WidgetProps) {
  // The env override key is the field id (PSDL convention — see normalize.ts).
  // For varint / berLength the stored value is the wire width in BITS (shown
  // as `{value/8}B`). For a delimiter-terminated `bytes` field the engine
  // reads a BYTE count instead (`__bytesDelimLen__`, normalize.ts), so its
  // options and stored value are in bytes and shown as `{value}B`.
  const widths = pickerWidths(target);
  const delimited = !!target.isDelimited;
  // Match the width the diagram layout seeds when the env key is unset
  // (`seedDynamicWidthDefaults`): a delimited `bytes` field renders at
  // DELIMITED_DEFAULT_BYTES and a varint at VARINT_DEFAULT_BITS, NOT at
  // `widths[0]` (1 byte for delimited). Falling back to `widths[0]` highlighted
  // the wrong option on load for any leaf `initialState` hadn't primed (e.g. a
  // switch-case-nested delimited leaf before its mirror seed) — a
  // panel-vs-diagram contradiction. berLength already defaults to 8 bits, which
  // equals `widths[0]`, so its fallback is unchanged.
  const seededDefault = delimited
    ? DELIMITED_DEFAULT_BYTES
    : target.varintEncoding
      ? VARINT_DEFAULT_BITS
      : target.isBerLength
        ? BER_LENGTH_DEFAULT_BITS
        : widths[0];
  // A berLength octet's wire width lives on the DEDICATED `__berLen__<id>` key,
  // NOT `env[id]`: the bare key can double as the length VALUE that sizes a
  // sibling `bytes(ref id)` (snmpV2c `versionValue = bytes(ref versionLength)`),
  // and PacketViewer 0-seeds it as a psdlRef. Driving the dedicated key keeps
  // this picker controlling the octet width without resizing the value (and the
  // seed on the same key makes the bridge leave the octet at its default rather
  // than collapsing it to 0 bits). varint/delimited keep using the bare id
  // (bridged in layout.ts). `seedDynamicWidthDefaults`/`initialState` seed the
  // matching key, so the active option agrees with the diagram on load.
  const widthEnvKey = target.isBerLength ? berLenEnvKey(target.id) : target.id;
  const current = controllers[widthEnvKey] ?? seededDefault;
  const label = delimited
    ? "Delimited length"
    : target.varintEncoding
      ? `Varint width (${target.varintEncoding})`
      : "BER length width";
  return (
    <div>
      <WidgetLabel>
        {label} · sets{" "}
        <code className="font-mono normal-case">{widthEnvKey}</code>
      </WidgetLabel>
      <div role="radiogroup" className="flex flex-wrap gap-1.5">
        {widths.map((w) => {
          const active = current === w;
          return (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(widthEnvKey, w)}
              className="px-2.5 py-1 rounded-md border font-mono tabular-nums text-sm-tight cursor-pointer"
              style={{
                borderColor: active ? "var(--accent)" : "var(--border-strong)",
                background: active ? "var(--accent)" : "var(--bg-elevated)",
                color: active ? "var(--accent-fg)" : "var(--fg)",
              }}
            >
              {delimited ? w : w / 8}B
            </button>
          );
        })}
      </div>
    </div>
  );
}

function pickerWidths(target: WidgetTarget): number[] {
  // Delimited bytes: the value is a byte count, not a bit width. Offer a
  // representative ladder around the seeded 4-byte default.
  if (target.isDelimited) return [1, 2, 4, 8, 16, 32];
  if (target.isBerLength) return [8, 16, 24, 40, 72]; // 1/2/3/5/9 bytes
  switch (target.varintEncoding) {
    case "quic":
      return [8, 16, 32, 64];
    case "protobuf":
      return [8, 16, 24, 32, 40, 48, 56, 64];
    case "cbor":
      return [8, 16, 24, 40, 72];
    default:
      return [8, 16, 32, 64];
  }
}

function EnumDropdown({ target, controllers, onChange }: WidgetProps) {
  const variants = target.enumVariants ?? {};
  const entries = Object.entries(variants)
    .map(([k, label]) => ({ value: Number(k), label }))
    .filter((e) => Number.isFinite(e.value))
    .sort((a, b) => a.value - b.value);
  const selectId = `detail-enum-${target.id}`;
  // Symmetric to SwitchDropdown's empty guard — a degenerate enum with
  // zero variants would otherwise render an unselectable `<select>`
  // (sub-agent Round 9 MEDIUM).
  if (entries.length === 0) {
    return (
      <div>
        <WidgetLabel>
          Enum value · sets{" "}
          <code className="font-mono normal-case">{target.id}</code>
        </WidgetLabel>
        <p className="text-xs text-fg-muted m-0">
          No variants declared for this enum.
        </p>
      </div>
    );
  }
  const current =
    controllers[target.id] ?? target.defaultValue ?? entries[0].value;
  return (
    <div>
      <label htmlFor={selectId}>
        <WidgetLabel>
          Enum value · sets{" "}
          <code className="font-mono normal-case">{target.id}</code>
        </WidgetLabel>
      </label>
      <select
        id={selectId}
        value={current}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(target.id, v);
        }}
        className="w-full px-2 py-1.5 rounded-md border font-mono text-sm-tight"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--bg-elevated)",
          color: "var(--fg)",
        }}
      >
        {entries.map((e) => (
          <option key={e.value} value={e.value}>
            {e.value} — {e.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function OptionalToggle({ target, controllers, onChange }: WidgetProps) {
  const checked = (controllers[target.id] ?? target.defaultValue ?? 0) !== 0;
  const checkboxId = `detail-optional-${target.id}`;
  const gated = target.optionalGateFor ?? [];
  return (
    <div>
      <WidgetLabel>Optional gate</WidgetLabel>
      <label
        htmlFor={checkboxId}
        className="flex items-start gap-2 cursor-pointer text-sm-tight text-fg"
      >
        <input
          id={checkboxId}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(target.id, e.target.checked ? 1 : 0)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">{checked ? "Present" : "Absent"}</span>
          {gated.length > 0 ? (
            <span className="ml-2 text-3xs text-fg-muted">
              gates {gated.map((g) => `"${g}"`).join(", ")}
            </span>
          ) : null}
        </span>
      </label>
    </div>
  );
}

type TlvInnerProps = {
  tlvField: Field;
  instanceIndex: number;
  onChange: (next: TlvInstance[]) => void;
  slotBytes?: number;
};

function TlvInnerVariantDropdown({
  tlvField,
  instanceIndex,
  onChange,
  slotBytes,
}: TlvInnerProps) {
  const tlv = tlvField.tlv!;
  const instance = tlv.instances[instanceIndex]!;
  const selectId = `detail-tlv-inner-${tlvField.id}-${instanceIndex}`;
  // A variant swap here can push the records past the upstream length slot just
  // like the full editor — surface the same warning (override-audit D2).
  const totalBytesUsed = Math.ceil(tlvTotalBits(tlvField).totalBits / 8);
  return (
    <div>
      <label htmlFor={selectId}>
        <WidgetLabel>
          TLV variant · {tlvField.name} #{instanceIndex}
        </WidgetLabel>
      </label>
      <SlotOvershootWarning
        totalBytesUsed={totalBytesUsed}
        slotBytes={slotBytes}
      />
      <select
        id={selectId}
        value={instance.kind}
        onChange={(e) => {
          const newKind = Number(e.target.value);
          if (!Number.isFinite(newKind)) return;
          const entry = tlv.catalog.find((c) => c.kind === newKind);
          // Preserve user-edited extras across the variant switch: defaults
          // for the new variant go in first, then the previous instance's
          // extras layer on top. Same policy as TlvEditor.handleKindChange.
          const next = tlv.instances.map((inst, i) => {
            if (i !== instanceIndex) return inst;
            const mergedExtras = {
              ...(entry?.defaultExtras ?? {}),
              ...(inst.extras ?? {}),
            };
            const updated: typeof inst = { kind: newKind };
            if (Object.keys(mergedExtras).length > 0) {
              updated.extras = mergedExtras;
            }
            return updated;
          });
          onChange(next);
        }}
        className="w-full px-2 py-1.5 rounded-md border font-mono text-sm-tight"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--bg-elevated)",
          color: "var(--fg)",
        }}
      >
        {tlv.catalog.map((c) => (
          <option key={c.kind} value={c.kind}>
            {c.kind} — {c.name}
          </option>
        ))}
      </select>
      <p className="mt-1.5 text-3xs text-fg-muted m-0">
        Changes the variant of this {tlvField.name} record. Full list edit (add
        / remove / reorder) lives in the TLV editor when you select the parent.
      </p>
    </div>
  );
}

type ChainInnerProps = {
  field: Field;
  instanceIndex: number;
  onChange: (next: { instances: ChainInstance[]; finalProto?: number }) => void;
};

/** Per-instance editor for a materialised IPv6 extension header. Edits this
 *  header's **Next Header** field, which — per the wire format — selects what
 *  FOLLOWS this header: another extension header (chain continues) or an
 *  upper-layer protocol (chain ends here). Changing it therefore changes the
 *  NEXT element, not this one (this header's own type is set by the PREVIOUS
 *  header's Next Header). Full add/reorder stays in the base chain editor. */
function ChainInnerVariantDropdown({
  field,
  instanceIndex,
  onChange,
}: ChainInnerProps) {
  const catalog = field.chainCatalog ?? [];
  const instances = field.chainInstances ?? [];
  const instance = instances[instanceIndex];
  const selectId = `detail-chain-inner-${field.id}-${instanceIndex}`;
  if (!instance) return null;
  const thisEntry = catalog.find((c) => c.proto === instance.proto);
  // What this header's Next Header currently points to: the following
  // extension header, or the terminal upper-layer protocol when it's last.
  const nextInstance = instances[instanceIndex + 1];
  const isExt = (proto: number) => catalog.some((c) => c.proto === proto);
  // Upper-layer enders: the terminal protocols that are NOT themselves
  // extension headers (so the catalog protos aren't duplicated).
  const enders = FINAL_PROTOS.filter((f) => !isExt(f.v));
  const currentNext =
    nextInstance?.proto ?? field.chainFinalProto ?? NO_NEXT_HEADER_PROTO;
  // If the chain currently terminates on a proto not in the curated label list
  // (any 8-bit value is valid), surface it as a bare "proto N" so the <select>
  // stays controlled and the hardcoded list never constrains what's editable.
  const currentIsKnown =
    isExt(currentNext) || enders.some((e) => e.v === currentNext);

  const setNext = (proto: number) => {
    if (isExt(proto)) {
      // Continue the chain: the immediately-following header becomes `proto`.
      const list = instances.slice();
      if (instanceIndex + 1 < list.length) {
        list[instanceIndex + 1] = { proto };
      } else {
        list.push({ proto });
      }
      onChange({ instances: list, finalProto: field.chainFinalProto });
    } else {
      // End the chain here: drop everything after this header, set the
      // terminal upper-layer protocol.
      onChange({
        instances: instances.slice(0, instanceIndex + 1),
        finalProto: proto,
      });
    }
  };

  return (
    <div>
      <label htmlFor={selectId}>
        <WidgetLabel>
          Next Header after {thisEntry?.name ?? `proto ${instance.proto}`} #
          {instanceIndex}
        </WidgetLabel>
      </label>
      <select
        id={selectId}
        value={currentNext}
        onChange={(e) => {
          const proto = Number(e.target.value);
          if (Number.isFinite(proto)) setNext(proto);
        }}
        className="w-full px-2 py-1.5 rounded-md border font-mono text-sm-tight"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--bg-elevated)",
          color: "var(--fg)",
        }}
      >
        <optgroup label="Extension header (chain continues)">
          {catalog.map((c) => (
            <option key={`ext-${c.proto}`} value={c.proto}>
              {c.name} (proto {c.proto})
            </option>
          ))}
        </optgroup>
        <optgroup label="Upper-layer protocol (chain ends)">
          {!currentIsKnown ? (
            <option value={currentNext}>proto {currentNext}</option>
          ) : null}
          {enders.map((f) => (
            <option key={`end-${f.v}`} value={f.v}>
              {f.name} ({f.v})
            </option>
          ))}
        </optgroup>
      </select>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() =>
            onChange({
              instances: instances.filter((_, i) => i !== instanceIndex),
              finalProto: field.chainFinalProto,
            })
          }
          className="text-3xs px-2 py-0.5 rounded border"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--fg)",
            background: "var(--bg-elevated)",
          }}
        >
          Remove this header
        </button>
        <p className="m-0 text-3xs text-fg-muted">
          Sets what follows this header. Add / reorder: select the base Next
          Header cell.
        </p>
      </div>
    </div>
  );
}

type RepeatCountStepperProps = {
  name: string;
  countKey: string;
  /** Affine map between the driving wire field (`countKey`) and the record
   *  count the user sees: `recordCount = env * mul + add`. When set, the
   *  stepper DISPLAYS the record count and WRITES the inverted env value so the
   *  diagram's count becomes the requested N (e.g. SRv6 `srhLastEntry + 1` →
   *  mul=1, add=1, so showing "3" writes srhLastEntry=2). Absent = identity
   *  (the env key IS the count). */
  transform?: { mul: number; add: number };
  controllers: ControllerState;
  onChange: (key: string, value: number) => void;
  /** When set, the stepper is inert (the repeat's section is not in the current
   *  diagram — an optional-wrapped repeat whose `when` is unset — so changing the
   *  count can't add a visible record): render it disabled with this hint telling
   *  the user what to set first. Absent = live. */
  disabledHint?: string;
};

function RepeatCountStepper({
  name,
  countKey,
  transform,
  controllers,
  onChange,
  disabledHint,
}: RepeatCountStepperProps) {
  const disabled = disabledHint !== undefined;
  const mul = transform?.mul ?? 1;
  const add = transform?.add ?? 0;
  // Displayed record count = env * mul + add. Writing inverts:
  // env = round((display - add) / mul). `mul` is always non-zero for a
  // surfaced transform (the adapter rejects `*0`), so the divide is safe. The
  // wire field is unsigned, so clamp the inverted value to >= 0 — this stops a
  // record-count below `add` (e.g. SRv6 count 0 would imply srhLastEntry = -1)
  // from writing a negative field value.
  const toEnv = (display: number) =>
    Math.max(0, Math.round((display - add) / mul));
  const raw = controllers[countKey] ?? 0;
  // The displayed value is the record count, not the raw field value.
  const value = raw * mul + add;
  const min = 0;
  // The earlier `max = 64` was an arbitrary cap that contradicted PSDL's
  // env-driven Repeat semantics (any count is legal). We use a soft ceiling
  // on the number input's spinner just to keep the buttons sane; the +/−
  // buttons themselves don't clamp upwards. Codex P2.
  // `SOFT_MAX` is the DISPLAYED record count ceiling, so it must equal
  // PacketViewer's MAX_DERIVED_RECORDS layout cap (1024): a single record
  // expands to ~6-20 diagram cells, so the previous 4096 let the stepper drive
  // tens of thousands of cells into the un-virtualized diagram and freeze it.
  // PacketViewer clamps the layout env to the same ceiling (covering the
  // share-URL / JSON-import path that bypasses this input), so the displayed
  // count and the diagram never diverge.
  const SOFT_MAX = MAX_REPEAT_RECORDS;
  const numId = `detail-repeat-${countKey}-number`;
  // NaN guard: the native number input briefly emits an empty string /
  // intermediate "-" for which `Number(...)` returns NaN. Without the
  // guard the NaN flows into `controllers`, contaminates `layout`'s env,
  // and the displayed value goes to `value={NaN}` (= empty input
  // controlled by an invalid value). Codex P2.
  // Cap upward growth at SOFT_MAX. Earlier the `+` button bypassed the
  // cap so a held key with autorepeat could push the value past the
  // input's `max` attribute and hang the diagram when a chained Repeat
  // drove layout (sub-agent Round 7 MEDIUM).
  const safe = (n: number) =>
    Number.isFinite(n)
      ? Math.max(min, Math.min(SOFT_MAX, Math.floor(n)))
      : value;
  return (
    <div>
      <div
        className="flex items-center gap-2"
        style={{ opacity: disabled ? 0.55 : 1 }}
      >
        <span className="flex-1 text-sm-tight text-fg truncate" title={name}>
          {name}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={`Decrement ${name}`}
            disabled={disabled}
            onClick={() => onChange(countKey, toEnv(safe(value - 1)))}
            className="w-7 h-7 rounded-md border font-mono text-sm-tight"
            style={{
              borderColor: "var(--border-strong)",
              background: "var(--bg-elevated)",
              color: "var(--fg)",
              cursor: disabled ? "not-allowed" : "pointer",
            }}
          >
            −
          </button>
          <input
            id={numId}
            type="number"
            min={min}
            max={SOFT_MAX}
            value={value}
            disabled={disabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              const nextDisplay = safe(n);
              const nextEnv = toEnv(nextDisplay);
              if (nextEnv !== raw) onChange(countKey, nextEnv);
            }}
            className="w-14 px-2 py-1 rounded-md border font-mono tabular-nums text-sm-tight text-center"
            style={{
              borderColor: "var(--border-strong)",
              background: "var(--bg-elevated)",
              color: "var(--fg)",
              cursor: disabled ? "not-allowed" : undefined,
            }}
          />
          <button
            type="button"
            aria-label={`Increment ${name}`}
            disabled={disabled}
            onClick={() => onChange(countKey, toEnv(safe(value + 1)))}
            className="w-7 h-7 rounded-md border font-mono text-sm-tight"
            style={{
              borderColor: "var(--border-strong)",
              background: "var(--bg-elevated)",
              color: "var(--fg)",
              cursor: disabled ? "not-allowed" : "pointer",
            }}
          >
            +
          </button>
        </div>
      </div>
      {disabledHint ? (
        <p className="mt-1 text-3xs text-fg-muted m-0">{disabledHint}</p>
      ) : null}
    </div>
  );
}

type ByteOrderToggleProps = {
  fieldId: string;
  current: "BE" | "LE";
  onChange: (fieldId: string, next: "BE" | "LE") => void;
};

function ByteOrderToggle({ fieldId, current, onChange }: ByteOrderToggleProps) {
  const options: Array<"BE" | "LE"> = ["BE", "LE"];
  return (
    <div>
      <WidgetLabel>
        Byte order · sets schema attribute on{" "}
        <code className="font-mono normal-case">{fieldId}</code>
      </WidgetLabel>
      <div role="radiogroup" className="flex gap-1.5">
        {options.map((o) => {
          const active = current === o;
          return (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(fieldId, o)}
              className="px-3 py-1 rounded-md border font-mono tabular-nums text-sm-tight cursor-pointer"
              style={{
                borderColor: active ? "var(--accent)" : "var(--border-strong)",
                background: active ? "var(--accent)" : "var(--bg-elevated)",
                color: active ? "var(--accent-fg)" : "var(--fg)",
              }}
            >
              {o}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-3xs text-fg-muted m-0">
        Edits the PSDL schema (per-field byteOrder, RFC 791 §3 / PSDL 0.4).
        Persisted via the studio reducer.
      </p>
    </div>
  );
}

type PeekSwitchPickerProps = {
  switchName: string;
  peekKey: string;
  cases: { value: number; label: string }[];
  controllers: ControllerState;
  onChange: (key: string, value: number) => void;
  /** When set, the picker is inert (its discriminator is not in the current
   *  diagram, so selecting a case can't change anything): render it disabled
   *  with this hint telling the user what to set first. Absent = live. */
  disabledHint?: string;
};

function PeekSwitchPicker({
  switchName,
  peekKey,
  cases,
  controllers,
  onChange,
  disabledHint,
}: PeekSwitchPickerProps) {
  const current = controllers[peekKey] ?? cases[0]?.value ?? 0;
  const selectId = `detail-peek-${peekKey}`;
  const disabled = disabledHint !== undefined;
  return (
    <div>
      <label htmlFor={selectId}>
        <p className="m-0 mb-0.5 text-3xs uppercase tracking-wider font-bold text-fg-muted">
          {switchName} · peek dispatch
        </p>
      </label>
      <select
        id={selectId}
        value={current}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(peekKey, v);
        }}
        className="w-full px-2 py-1.5 rounded-md border font-mono text-sm-tight"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--bg-elevated)",
          color: "var(--fg)",
          opacity: disabled ? 0.55 : 1,
          cursor: disabled ? "not-allowed" : undefined,
        }}
      >
        {cases.map((c) => (
          <option key={c.value} value={c.value}>
            {c.value} — {c.label}
          </option>
        ))}
      </select>
      {disabledHint ? (
        <p className="mt-1 text-3xs text-fg-muted m-0">{disabledHint}</p>
      ) : null}
    </div>
  );
}
