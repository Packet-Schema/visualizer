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
import ChainEditor from "./ChainEditor";
import TlvEditor, { SlotOvershootWarning } from "./TlvEditor";
import { tlvTotalBits } from "@/lib/psdl/renderer-helpers";
import { resolveSelection } from "./selection-resolver";
import { parseTlvCellId } from "./tlv-cell-id";

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
};

function EmptyState({
  message,
  packet,
  controllers,
  onControllerChange,
  onTlvChange,
  tlvSlotBytes,
}: {
  message: string;
  packet: Packet;
  controllers: ControllerState;
  onControllerChange?: (key: string, value: number) => void;
  onTlvChange?: (field: Field, next: TlvInstance[]) => void;
  tlvSlotBytes?: Record<string, number>;
}) {
  // Packet-level extras (free Repeats, peek Switches) surface here so the
  // panel never reads as truly empty when the packet has stoppable knobs
  // that aren't anchored to a single cell.
  const free = packet.freeRepeats ?? [];
  const peeks = packet.peekSwitches ?? [];
  const refs = packet.refSwitches ?? [];
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
                controllers={controllers}
                onChange={onControllerChange}
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
              />
            ))}
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

  const r = resolveSelection(packet, selectedFieldId, cells);

  const emptyProps = {
    packet,
    controllers,
    onControllerChange,
    onTlvChange,
    tlvSlotBytes,
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

  if ((field.varintEncoding || field.isBerLength) && onControllerChange) {
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
    widgets.push(
      <OverrideSlider
        key="slider"
        field={field}
        controllers={controllers}
        drivenByTlv={drivenByTlv}
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
): React.ReactNode[] {
  if (!onControllerChange) return [];
  const target: WidgetTarget = {
    id: sub.id,
    name: `${sub.name} (in ${parent.name})`,
    defaultValue: sub.defaultValue,
    switchCases: sub.switchCases,
    varintEncoding: sub.varintEncoding,
    isBerLength: sub.isBerLength,
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
  if (sub.varintEncoding || sub.isBerLength) {
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
  optionalGateFor?: Field["optionalGateFor"];
  enumVariants?: Field["enumVariants"];
};

function fieldAsTarget(f: Field): WidgetTarget {
  return {
    id: f.id,
    name: f.name,
    defaultValue: f.defaultValue,
    switchCases: f.switchCases,
    varintEncoding: f.varintEncoding,
    isBerLength: f.isBerLength,
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

type SliderProps = {
  field: Field;
  controllers: ControllerState;
  drivenByTlv: boolean;
  onChange: (key: string, value: number) => void;
};

function OverrideSlider({
  field,
  controllers,
  drivenByTlv,
  onChange,
}: SliderProps) {
  const key = field.controlsLength!;
  const value = controllers[key] ?? field.defaultValue ?? 0;
  const min = field.min ?? 0;
  const max =
    field.max ?? (typeof field.bits === "number" ? 2 ** field.bits - 1 : 255);
  const sliderId = `detail-ctrl-${field.id}-slider`;
  const numberId = `detail-ctrl-${field.id}-number`;
  const labelId = `detail-ctrl-${field.id}-label`;
  const apply = (raw: string) => {
    const n = Math.max(min, Math.min(max, Number(raw)));
    if (Number.isFinite(n)) onChange(key, n);
  };

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);

  return (
    <div>
      <label
        htmlFor={sliderId}
        id={labelId}
        className="block mb-1 text-3xs uppercase tracking-wider font-bold text-fg-muted"
      >
        Length · drives <code className="font-mono normal-case">{key}</code>
      </label>
      <div className="flex items-center gap-2.5">
        <span className="pv-slider-wrap flex-1">
          <input
            suppressHydrationWarning
            ref={inputRef}
            id={sliderId}
            type="range"
            min={min}
            max={max}
            value={value}
            onChange={(e) => apply(e.target.value)}
            onPointerDown={() => setTooltipVisible(true)}
            onPointerUp={() => setTooltipVisible(false)}
            onPointerCancel={() => setTooltipVisible(false)}
            onFocus={() => setTooltipVisible(true)}
            onBlur={() => setTooltipVisible(false)}
            className="pv-slider"
            aria-labelledby={labelId}
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
          onChange={(e) => apply(e.target.value)}
          aria-labelledby={labelId}
          className="w-16 px-2 py-1 rounded-md border font-mono tabular-nums text-sm-tight"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--fg)",
          }}
        />
      </div>
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
  // Valid widths in bits per encoding. The env override key is the field id
  // (PSDL convention — see normalize.ts).
  const widths = pickerWidths(target);
  const current = controllers[target.id] ?? widths[0];
  return (
    <div>
      <WidgetLabel>
        {target.varintEncoding
          ? `Varint width (${target.varintEncoding})`
          : "BER length width"}{" "}
        · sets <code className="font-mono normal-case">{target.id}</code>
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
              onClick={() => onChange(target.id, w)}
              className="px-2.5 py-1 rounded-md border font-mono tabular-nums text-sm-tight cursor-pointer"
              style={{
                borderColor: active ? "var(--accent)" : "var(--border-strong)",
                background: active ? "var(--accent)" : "var(--bg-elevated)",
                color: active ? "var(--accent-fg)" : "var(--fg)",
              }}
            >
              {w / 8}B
            </button>
          );
        })}
      </div>
    </div>
  );
}

function pickerWidths(target: WidgetTarget): number[] {
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

type RepeatCountStepperProps = {
  name: string;
  countKey: string;
  controllers: ControllerState;
  onChange: (key: string, value: number) => void;
};

function RepeatCountStepper({
  name,
  countKey,
  controllers,
  onChange,
}: RepeatCountStepperProps) {
  const value = controllers[countKey] ?? 0;
  const min = 0;
  // The earlier `max = 64` was an arbitrary cap that contradicted PSDL's
  // env-driven Repeat semantics (any count is legal). We use a soft ceiling
  // on the number input's spinner just to keep the buttons sane; the +/−
  // buttons themselves don't clamp upwards. Codex P2.
  const SOFT_MAX = 4096;
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
    <div className="flex items-center gap-2">
      <span className="flex-1 text-sm-tight text-fg truncate" title={name}>
        {name}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`Decrement ${name}`}
          onClick={() => onChange(countKey, safe(value - 1))}
          className="w-7 h-7 rounded-md border font-mono text-sm-tight cursor-pointer"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--fg)",
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
          onChange={(e) => {
            const n = Number(e.target.value);
            const next = safe(n);
            if (next !== value) onChange(countKey, next);
          }}
          className="w-14 px-2 py-1 rounded-md border font-mono tabular-nums text-sm-tight text-center"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--fg)",
          }}
        />
        <button
          type="button"
          aria-label={`Increment ${name}`}
          onClick={() => onChange(countKey, safe(value + 1))}
          className="w-7 h-7 rounded-md border font-mono text-sm-tight cursor-pointer"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--fg)",
          }}
        >
          +
        </button>
      </div>
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
};

function PeekSwitchPicker({
  switchName,
  peekKey,
  cases,
  controllers,
  onChange,
}: PeekSwitchPickerProps) {
  const current = controllers[peekKey] ?? cases[0]?.value ?? 0;
  const selectId = `detail-peek-${peekKey}`;
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
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(peekKey, v);
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
