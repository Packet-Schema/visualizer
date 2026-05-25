// IPv6 extension-header chain editor.
//
// Ported from `renderChainDetail` in app.js. Lists each chain block and
// offers a final-protocol selector (TCP=6, UDP=17, etc.) at the bottom.

import { useEffect, useId, useRef, useState } from "react";

import { useListItemKeys } from "@/lib/use-list-item-keys";
import type {
  ChainCatalogEntry,
  ChainInstance,
  Field,
} from "@/lib/psml/renderer";

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
  onChange: (next: { instances: ChainInstance[]; finalProto?: number }) => void;
};

export default function ChainEditor({ field, onChange }: Props) {
  const [addProto, setAddProto] = useState<string>("");
  const catalog = field.chainCatalog || [];
  const instances = field.chainInstances || [];
  const finalProto = field.chainFinalProto;
  const addSelectId = useId();

  const catalogByProto = new Map<number, ChainCatalogEntry>(
    catalog.map((c) => [c.proto, c]),
  );
  const itemKeys = useListItemKeys(instances);

  // SR live-region + focus restore after add/remove (sub-agent Round 7).
  const [liveMsg, setLiveMsg] = useState<string>("");
  const prevLengthRef = useRef(instances.length);
  const addSelectRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => {
    const prev = prevLengthRef.current;
    const next = instances.length;
    if (next > prev) {
      setLiveMsg(`Extension header ${next} added.`);
    } else if (next < prev) {
      setLiveMsg(`Extension header removed. ${next} attached.`);
      addSelectRef.current?.focus();
    }
    prevLengthRef.current = next;
  }, [instances.length]);

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
    // Empty string means the user picked "(none)" — clear the final
    // proto entirely instead of coercing it to 0. `Number("")` is 0 in
    // JS, so without this guard the select would silently bind 0 (a
    // valid IPv6 HBH next-header) to `chainFinalProto` and the chain
    // editor would render that proto's row as the terminal protocol.
    if (raw === "") {
      emit(instances, undefined);
      return;
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    emit(instances, v);
  };

  return (
    <div>
      <h3 className="m-0 mb-2 text-[15px] text-fg">{field.name} — chain</h3>
      <p className="text-xs m-0 mb-2 text-fg-muted">
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
          <p className="m-0 px-3 py-2 text-xs text-fg-faint">
            No extension headers attached.
          </p>
        ) : (
          instances.map((inst, i) => {
            const entry = catalogByProto.get(inst.proto);
            if (!entry) return null;
            const bits = entry.fields.reduce((a, f) => a + f.bits, 0);
            return (
              <div key={itemKeys[i]} className="px-3 py-2 border-border">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-2xs font-bold px-1.5 py-0.5 rounded font-mono bg-bg-elevated text-fg-muted border border-border">
                    proto {entry.proto}
                  </span>
                  <span className="text-sm-tight font-semibold text-fg">
                    {entry.name}
                  </span>
                  <span className="text-3xs font-mono tabular-nums text-fg-muted">
                    {bits} b / {bits / 8} B
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <IconBtn
                      label={`Move header ${i} up`}
                      disabled={i === 0}
                      onClick={() => handleMoveUp(i)}
                    >
                      ↑
                    </IconBtn>
                    <IconBtn
                      label={`Move header ${i} down`}
                      disabled={i === instances.length - 1}
                      onClick={() => handleMoveDown(i)}
                    >
                      ↓
                    </IconBtn>
                    <button
                      type="button"
                      onClick={() => handleRemove(i)}
                      className="text-3xs px-2 py-0.5 rounded border"
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
                  <p className="m-0 mt-1 text-3xs text-fg-faint">
                    {entry.description}
                  </p>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {liveMsg}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <label htmlFor={addSelectId} className="text-xs text-fg-muted">
          Add extension header:
        </label>
        <select
          id={addSelectId}
          ref={addSelectRef}
          value={addProto}
          onChange={(e) => setAddProto(e.target.value)}
          className="px-2 py-1 rounded border text-xs"
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
          className="text-xs px-2.5 py-1 rounded border"
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
        <label className="text-xs text-fg-muted">
          Final upper-layer protocol:
        </label>
        <select
          value={finalProto ?? ""}
          onChange={(e) => handleFinalChange(e.target.value)}
          className="px-2 py-1 rounded border text-xs"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--fg)",
          }}
        >
          {/* Empty-value option pairs with `value={finalProto ?? ""}` so
              the &lt;select&gt; stays controlled when no final proto is
              picked yet (avoids the "controlled value doesn't match any
              option" React warning). */}
          <option value="">(none)</option>
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
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="text-3xs w-6 h-6 rounded border font-mono"
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
