"use client";

// IPv6 extension-header chain editor.
//
// Ported from `renderChainDetail` in app.js. Lists each chain block and
// offers a final-protocol selector (TCP=6, UDP=17, etc.) at the bottom.

import { useState } from "react";

import type {
  ChainCatalogEntry,
  ChainInstance,
  Field,
} from "@/lib/types";

const FINAL_PROTOS: Array<{ v: number; name: string }> = [
  { v: 6, name: "TCP" },
  { v: 17, name: "UDP" },
  { v: 58, name: "ICMPv6" },
  { v: 50, name: "ESP" },
  { v: 132, name: "SCTP" },
  { v: 59, name: "No Next Header" },
];

type Props = {
  field: Field;
  onChange: (next: {
    instances: ChainInstance[];
    finalProto?: number;
  }) => void;
};

export default function ChainEditor({ field, onChange }: Props) {
  const [addProto, setAddProto] = useState<string>("");
  const catalog = field.chainCatalog || [];
  const instances = field.chainInstances || [];
  const finalProto = field.chainFinalProto;

  const catalogByProto = new Map<number, ChainCatalogEntry>(
    catalog.map((c) => [c.proto, c]),
  );

  const emit = (
    nextList: ChainInstance[],
    nextFinal: number | undefined = finalProto,
  ) => {
    onChange({ instances: nextList, finalProto: nextFinal });
  };

  const handleRemove = (idx: number) => {
    const list = instances.slice();
    list.splice(idx, 1);
    emit(list);
  };

  const handleMoveUp = (idx: number) => {
    if (idx <= 0) return;
    const list = instances.slice();
    [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
    emit(list);
  };

  const handleMoveDown = (idx: number) => {
    if (idx >= instances.length - 1) return;
    const list = instances.slice();
    [list[idx], list[idx + 1]] = [list[idx + 1], list[idx]];
    emit(list);
  };

  const handleAdd = () => {
    const proto = Number(addProto);
    if (!Number.isFinite(proto)) return;
    if (!catalogByProto.has(proto)) return;
    emit([...instances, { proto }]);
    setAddProto("");
  };

  const handleFinalChange = (raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    emit(instances, v);
  };

  return (
    <div>
      <h3
        className="m-0 mb-2 text-[15px]"
        style={{ color: "var(--fg)" }}
      >
        {field.name} — chain
      </h3>
      <p
        className="text-[12px] m-0 mb-2"
        style={{ color: "var(--fg-muted)" }}
      >
        Attach IPv6 extension headers in order. The final Next Header is the
        upper-layer protocol.
      </p>

      <div
        className="rounded-md border divide-y"
        style={{
          borderColor: "var(--border)",
          background: "var(--bg-base)",
        }}
      >
        {instances.length === 0 ? (
          <p
            className="m-0 px-3 py-2 text-[12px]"
            style={{ color: "var(--fg-faint)" }}
          >
            No extension headers attached.
          </p>
        ) : (
          instances.map((inst, i) => {
            const entry = catalogByProto.get(inst.proto);
            if (!entry) return null;
            const bits = entry.fields.reduce((a, f) => a + f.bits, 0);
            return (
              <div
                key={i}
                className="px-3 py-2"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded font-mono"
                    style={{
                      background: "var(--bg-elevated)",
                      color: "var(--fg-muted)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    proto {entry.proto}
                  </span>
                  <span
                    className="text-[13px] font-semibold"
                    style={{ color: "var(--fg)" }}
                  >
                    {entry.name}
                  </span>
                  <span
                    className="text-[11px] font-mono tabular-nums"
                    style={{ color: "var(--fg-muted)" }}
                  >
                    {bits} b / {bits / 8} B
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <IconBtn
                      label="Move up"
                      disabled={i === 0}
                      onClick={() => handleMoveUp(i)}
                    >
                      ↑
                    </IconBtn>
                    <IconBtn
                      label="Move down"
                      disabled={i === instances.length - 1}
                      onClick={() => handleMoveDown(i)}
                    >
                      ↓
                    </IconBtn>
                    <button
                      type="button"
                      onClick={() => handleRemove(i)}
                      className="text-[11px] px-2 py-0.5 rounded border"
                      style={{
                        borderColor: "var(--border-strong)",
                        color: "var(--fg)",
                        background: "var(--bg-elevated)",
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                {entry.description ? (
                  <p
                    className="m-0 mt-1 text-[11px]"
                    style={{ color: "var(--fg-faint)" }}
                  >
                    {entry.description}
                  </p>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <label className="text-[12px]" style={{ color: "var(--fg-muted)" }}>
          Add extension header:
        </label>
        <select
          value={addProto}
          onChange={(e) => setAddProto(e.target.value)}
          className="px-2 py-1 rounded border text-[12px]"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--fg)",
          }}
        >
          <option value="">-- choose an extension header --</option>
          {catalog.map((c) => (
            <option key={c.proto} value={c.proto}>
              {c.name} (proto {c.proto})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!addProto}
          className="text-[12px] px-2.5 py-1 rounded border"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--accent)",
            color: "var(--accent-fg, #fff)",
            opacity: addProto ? 1 : 0.5,
          }}
        >
          Add
        </button>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <label className="text-[12px]" style={{ color: "var(--fg-muted)" }}>
          Final upper-layer protocol:
        </label>
        <select
          value={finalProto ?? ""}
          onChange={(e) => handleFinalChange(e.target.value)}
          className="px-2 py-1 rounded border text-[12px]"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--fg)",
          }}
        >
          {FINAL_PROTOS.map((f) => (
            <option key={f.v} value={f.v}>
              {f.name} ({f.v})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="text-[11px] w-6 h-6 rounded border font-mono"
      style={{
        borderColor: "var(--border-strong)",
        background: "var(--bg-elevated)",
        color: "var(--fg)",
        opacity: disabled ? 0.35 : 1,
      }}
    >
      {children}
    </button>
  );
}
