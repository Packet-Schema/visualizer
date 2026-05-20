import { CATEGORY_LABELS } from "@/lib/constants";
import { enrichDescriptionHtml } from "@/lib/enrich";
import type {
  CategoryToken,
  ControllerState,
  Packet,
} from "@/lib/psml/renderer";

import { resolveSelection } from "./selection-resolver";

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
};

export default function DetailPanel({
  packet,
  selectedFieldId,
  controllers,
}: Props) {
  const r = resolveSelection(packet, selectedFieldId);

  if (r.kind === "empty") {
    return (
      <p className="m-0 text-sm-tight text-fg-faint">
        Click a field in the diagram to see its details.
      </p>
    );
  }

  if (r.kind === "subfield-not-found") {
    return (
      <p className="m-0 text-sm-tight text-fg-faint">Subfield not found.</p>
    );
  }

  if (r.kind === "field-not-found") {
    return <p className="m-0 text-sm-tight text-fg-faint">Field not found.</p>;
  }

  if (r.kind === "subfield") {
    const { parent, sub } = r;
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

  const field = r.field;
  const bits =
    field.variable && field.toBits && field.lengthFrom
      ? field.toBits(controllers[field.lengthFrom] ?? 0)
      : (field.bits ?? 0);
  const sizeStr = `${bits} bits${Number.isInteger(bits / 8) ? ` (${bits / 8} bytes)` : ""}`;

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
