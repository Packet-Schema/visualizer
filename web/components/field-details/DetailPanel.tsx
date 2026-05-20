import { useRef, useState } from "react";

import { CATEGORY_LABELS } from "@/lib/constants";
import { enrichDescriptionHtml } from "@/lib/enrich";
import type {
  CategoryToken,
  ChainInstance,
  ControllerState,
  Field,
  Packet,
  TlvInstance,
} from "@/lib/psml/renderer";

import SliderTooltip from "../controls/SliderTooltip";
import ChainEditor from "./ChainEditor";
import TlvEditor from "./TlvEditor";

function EnrichedText({ text }: { text: string }) {
  return (
    <span
      className="enriched-text"
      dangerouslySetInnerHTML={{ __html: enrichDescriptionHtml(text) }}
    />
  );
}

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

export default function DetailPanel({
  packet,
  selectedFieldId,
  controllers,
  onTlvChange,
  onChainChange,
  onControllerChange,
}: Props) {
  if (!selectedFieldId) {
    return (
      <p className="m-0 text-sm-tight text-fg-faint">
        Click a field in the diagram to see its details.
      </p>
    );
  }

  // Virtual cells emitted by `normalize.ts` carry a `#<repeatIndex>` suffix
  // (e.g. `type#0` for the first IPv4 Option's Type cell). Strip it so the
  // selection resolves back to the parent TLV / chain field; the editor
  // (TlvEditor / ChainEditor) handles per-instance focus internally.
  const baseId = selectedFieldId.includes("#")
    ? selectedFieldId.split("#")[0]
    : selectedFieldId;

  // Subfield resolution. Two shapes feed in here:
  //   * `parentId:subfieldId` — emitted by `HybridDiagram.onSubfieldClick`.
  //   * bare `subfieldId` — emitted by `onFieldClick` when a group's child is
  //     rendered as its own top-level cell (the layout adapter flattens
  //     groups, but `psmlToRenderer` collapses the group into a parent field
  //     with `subfields[]`). In that case we look the id up across every
  //     parent's subfields and present the same "subfield of …" UI.
  const subPair = (() => {
    if (baseId.includes(":")) {
      const [parentId, subId] = baseId.split(":");
      const parent = packet.fields.find((f) => f.id === parentId);
      const sub = parent?.subfields?.find((s) => s.id === subId);
      return parent && sub ? { parent, sub } : null;
    }
    for (const parent of packet.fields) {
      const sub = parent.subfields?.find((s) => s.id === baseId);
      if (sub) return { parent, sub };
    }
    return null;
  })();

  if (subPair) {
    const { parent, sub } = subPair;
    return (
      <div>
        <h3 className="m-0 mb-2.5 text-[15px] text-fg">
          {sub.name}{" "}
          <span className="text-3xs font-normal text-fg-muted">
            (subfield of {parent.name})
          </span>
        </h3>
        <DefList
          rows={[
            ["Size", `${sub.bits} bit${sub.bits === 1 ? "" : "s"}`],
            ["Parent", parent.name],
            sub.description
              ? [
                  "Description",
                  <EnrichedText key="desc" text={sub.description} />,
                ]
              : null,
          ]}
        />
      </div>
    );
  }

  if (baseId.includes(":")) {
    return (
      <p className="m-0 text-sm-tight text-fg-faint">Subfield not found.</p>
    );
  }

  const field = packet.fields.find((f) => f.id === baseId);
  if (!field) {
    return <p className="m-0 text-sm-tight text-fg-faint">Field not found.</p>;
  }

  // TLV editor.
  if (field.tlv && onTlvChange) {
    return (
      <TlvEditor
        field={field}
        controllers={controllers}
        onChange={(next) => onTlvChange(field, next)}
      />
    );
  }

  // IPv6 chain editor.
  if (field.chainCatalog && onChainChange) {
    return (
      <ChainEditor
        field={field}
        onChange={(next) => onChainChange(field, next)}
      />
    );
  }

  const bits =
    field.variable && field.toBits && field.lengthFrom
      ? field.toBits(controllers[field.lengthFrom] ?? 0)
      : (field.bits ?? 0);
  const sizeStr = `${bits} bits${Number.isInteger(bits / 8) ? ` (${bits / 8} bytes)` : ""}`;

  // Length controller note: when a TLV editor is driving this controller,
  // the override slider becomes effectively read-only (its value resets on
  // the next TLV edit). Surface that as a hint next to the slider.
  const drivenByTlv = field.controlsLength
    ? packet.fields.some(
        (f) => f.tlv && f.tlv.drivesController === field.controlsLength,
      )
    : false;

  const rows: Array<[string, React.ReactNode] | null> = [
    [
      "Size",
      <span key="size">
        <span className="font-mono tabular-nums">{sizeStr}</span>
        {field.variable ? (
          <em className="not-italic ml-1 text-fg-muted">(variable)</em>
        ) : null}
      </span>,
    ],
    field.category
      ? [
          "Category",
          CATEGORY_LABELS[field.category as CategoryToken] || field.category,
        ]
      : null,
    field.variable
      ? [
          "Driven by",
          <code key="driven" className="font-mono">
            {field.lengthFrom}
          </code>,
        ]
      : null,
    field.description
      ? ["Description", <EnrichedText key="desc" text={field.description} />]
      : null,
    field.subfields && field.subfields.length > 0
      ? [
          "Subfields",
          <span key="subfields">
            {field.subfields.map((s, i) => (
              <span key={s.id}>
                {i > 0 ? " " : ""}
                <code className="font-mono">{s.name}</code> ({s.bits}b)
              </span>
            ))}
          </span>,
        ]
      : null,
  ];

  return (
    <div>
      <h3 className="m-0 mb-2.5 text-[15px] text-fg">{field.name}</h3>
      <DefList rows={rows} />
      {field.controlsLength && onControllerChange ? (
        <OverrideSlider
          field={field}
          controllers={controllers}
          drivenByTlv={drivenByTlv}
          onChange={onControllerChange}
        />
      ) : null}
    </div>
  );
}

function DefList({ rows }: { rows: Array<[string, React.ReactNode] | null> }) {
  const filtered = rows.filter(
    (r): r is [string, React.ReactNode] => r !== null,
  );
  return (
    <dl
      className="m-0 grid gap-y-1.5 gap-x-3.5 text-sm-tight"
      style={{
        gridTemplateColumns: "max-content 1fr",
      }}
    >
      {filtered.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="font-semibold m-0 text-fg-muted">{term}</dt>
          <dd className="m-0 text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

type OverrideSliderProps = {
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
}: OverrideSliderProps) {
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
    <div
      className="mt-3.5 pt-3 border-t"
      style={{ borderColor: "var(--border)" }}
    >
      <label
        htmlFor={sliderId}
        id={labelId}
        className="block mb-1 text-3xs uppercase tracking-wider font-bold text-fg-muted"
      >
        Override · drives <code className="font-mono normal-case">{key}</code>
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
