"use client";

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
};

export default function DetailPanel({
  packet,
  selectedFieldId,
  controllers,
  onTlvChange,
  onChainChange,
}: Props) {
  if (!selectedFieldId) {
    return (
      <p className="m-0 text-[13px]" style={{ color: "var(--fg-faint)" }}>
        Click a field in the diagram to see its details.
      </p>
    );
  }

  // Subfield selection: `parentId:subfieldId`.
  if (selectedFieldId.includes(":")) {
    const [parentId, subId] = selectedFieldId.split(":");
    const parent = packet.fields.find((f) => f.id === parentId);
    const sub = parent?.subfields?.find((s) => s.id === subId);
    if (!parent || !sub) {
      return (
        <p className="m-0 text-[13px]" style={{ color: "var(--fg-faint)" }}>
          Subfield not found.
        </p>
      );
    }
    return (
      <div>
        <h3
          className="m-0 mb-2.5 text-[15px]"
          style={{ color: "var(--fg)" }}
        >
          {sub.name}{" "}
          <span
            className="text-[11px] font-normal"
            style={{ color: "var(--fg-muted)" }}
          >
            (subfield of {parent.name})
          </span>
        </h3>
        <DefList
          rows={[
            ["Size", `${sub.bits} bit${sub.bits === 1 ? "" : "s"}`],
            ["Parent", parent.name],
            sub.description
              ? ["Description", <EnrichedText key="desc" text={sub.description} />]
              : null,
          ]}
        />
      </div>
    );
  }

  const field = packet.fields.find((f) => f.id === selectedFieldId);
  if (!field) {
    return (
      <p className="m-0 text-[13px]" style={{ color: "var(--fg-faint)" }}>
        Field not found.
      </p>
    );
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
  // the slider in ControlsPanel is read-only-ish (still editable, but the
  // synced value will reset on next TLV edit). We surface that here.
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
          <em
            className="not-italic ml-1"
            style={{ color: "var(--fg-muted)" }}
          >
            (variable)
          </em>
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
    field.controlsLength
      ? [
          "Controls",
          <span key="controls">
            <code className="font-mono">{field.controlsLength}</code>
            {" (current: "}
            <span className="font-mono tabular-nums">
              {controllers[field.controlsLength]}
            </span>
            )
            {drivenByTlv ? (
              <em
                className="not-italic ml-2 text-[11px]"
                style={{ color: "var(--fg-muted)" }}
              >
                — synced from TLV editor
              </em>
            ) : null}
          </span>,
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
      <h3
        className="m-0 mb-2.5 text-[15px]"
        style={{ color: "var(--fg)" }}
      >
        {field.name}
      </h3>
      <DefList rows={rows} />
    </div>
  );
}

function DefList({
  rows,
}: {
  rows: Array<[string, React.ReactNode] | null>;
}) {
  const filtered = rows.filter(
    (r): r is [string, React.ReactNode] => r !== null,
  );
  return (
    <dl
      className="m-0 grid gap-y-1.5 gap-x-3.5 text-[13px]"
      style={{
        gridTemplateColumns: "max-content 1fr",
      }}
    >
      {filtered.map(([term, value]) => (
        <div key={term} className="contents">
          <dt
            className="font-semibold m-0"
            style={{ color: "var(--fg-muted)" }}
          >
            {term}
          </dt>
          <dd className="m-0" style={{ color: "var(--fg)" }}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
