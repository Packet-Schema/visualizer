import { useRef, useState } from "react";

import type { ControllerState, Packet } from "@/lib/psml/renderer";
import SliderTooltip from "./SliderTooltip";

type Props = {
  packet: Packet;
  controllers: ControllerState;
  onChange: (controllerKey: string, value: number) => void;
};

export default function ControlsPanel({
  packet,
  controllers,
  onChange,
}: Props) {
  const controllerFields = packet.fields.filter((f) => f.controlsLength);

  if (controllerFields.length === 0) {
    return (
      <p className="text-[13px] m-0 text-fg-faint">
        This packet has no variable-length controllers.
      </p>
    );
  }

  return (
    <div className="space-y-3.5">
      {controllerFields.map((field) => (
        <ControlRow
          key={field.id}
          field={field}
          controllers={controllers}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

type RowProps = {
  field: Packet["fields"][number];
  controllers: ControllerState;
  onChange: (controllerKey: string, value: number) => void;
};

function ControlRow({ field, controllers, onChange }: RowProps) {
  const key = field.controlsLength!;
  const value = controllers[key] ?? field.defaultValue ?? 0;
  const min = field.min ?? 0;
  const max =
    field.max ?? (typeof field.bits === "number" ? 2 ** field.bits - 1 : 255);
  const sliderId = `ctrl-${field.id}-slider`;
  const numberId = `ctrl-${field.id}-number`;
  const labelId = `ctrl-${field.id}-label`;
  const hintId = `ctrl-${field.id}-hint`;
  const apply = (raw: string) => {
    const n = Math.max(min, Math.min(max, Number(raw)));
    if (Number.isFinite(n)) onChange(key, n);
  };

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);

  return (
    <div className="control">
      <label
        htmlFor={sliderId}
        id={labelId}
        className="block mb-1 control-label"
      >
        <span className="font-semibold text-[13px] text-fg">{field.name}</span>
      </label>
      {field.description ? (
        <span id={hintId} className="block text-[11px] mb-1.5 text-fg-faint">
          {field.description}
        </span>
      ) : null}
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
            aria-describedby={field.description ? hintId : undefined}
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
          aria-describedby={field.description ? hintId : undefined}
          className="w-16 px-2 py-1 rounded-md border font-mono tabular-nums text-[13px]"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--fg)",
          }}
        />
      </div>
    </div>
  );
}
