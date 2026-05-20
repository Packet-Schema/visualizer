import { useRef, useState } from "react";

import type {
  ChainInstance,
  ControllerState,
  Field,
  Packet,
  SubField,
  TlvInstance,
} from "@/lib/psml/renderer";

import SliderTooltip from "../controls/SliderTooltip";
import ChainEditor from "./ChainEditor";
import TlvEditor from "./TlvEditor";
import { resolveSelection } from "./selection-resolver";

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
};

function EmptyState({ message }: { message: string }) {
  return <p className="m-0 text-sm-tight text-fg-faint">{message}</p>;
}

export default function OverridePanel({
  packet,
  selectedFieldId,
  controllers,
  onTlvChange,
  onChainChange,
  onControllerChange,
}: Props) {
  const r = resolveSelection(packet, selectedFieldId);

  if (r.kind === "empty") {
    return <EmptyState message="Select a cell to edit its override." />;
  }
  if (r.kind === "subfield-not-found") {
    return <EmptyState message="Subfield not found." />;
  }
  if (r.kind === "field-not-found") {
    return <EmptyState message="Field not found." />;
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
        <EmptyState message="Subfields share their parent's override. Select the parent cell." />
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
      <EmptyState message="This field has no runtime override. Read-only display." />
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
  const current =
    controllers[target.id] ?? target.defaultValue ?? cases[0]?.value;
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
  // (PSML convention — see normalize.ts).
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
