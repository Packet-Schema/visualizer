// Recursive TLV record editor.
//
// Ported from the legacy `renderTlvDetail` in app.js. Renders the current
// instances as a list of rows (kind badge + name + bits + per-record slot
// count + reorder/remove buttons) plus an "Add option" selector below.
// The parent owns the field; we call `onChange(newInstances)` for every
// mutation and let it re-sync controllers.

import { useMemo, useState } from "react";

import { tlvRecordBits, tlvTotalBits } from "@/lib/psml/renderer-helpers";
import type {
  ControllerState,
  Field,
  TlvCatalogEntry,
  TlvInstance,
} from "@/lib/psml/renderer";

type Props = {
  field: Field;
  controllers: ControllerState;
  onChange: (next: TlvInstance[]) => void;
};

export default function TlvEditor({ field, controllers, onChange }: Props) {
  const [addKind, setAddKind] = useState<string>("");
  const tlv = field.tlv;

  const summary = useMemo(() => tlvTotalBits(field), [field]);

  if (!tlv) return null;

  const instances = tlv.instances || [];
  const catalogByKind = new Map<number, TlvCatalogEntry>(
    tlv.catalog.map((c) => [c.kind, c]),
  );

  const update = (mutator: (list: TlvInstance[]) => TlvInstance[]) => {
    onChange(
      mutator(
        instances.map((i) => ({
          ...i,
          extras: i.extras ? { ...i.extras } : undefined,
        })),
      ),
    );
  };

  const handleRemove = (idx: number) =>
    update((list) => {
      list.splice(idx, 1);
      return list;
    });

  const handleMoveUp = (idx: number) =>
    update((list) => {
      if (idx <= 0) return list;
      [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
      return list;
    });

  const handleMoveDown = (idx: number) =>
    update((list) => {
      if (idx >= list.length - 1) return list;
      [list[idx], list[idx + 1]] = [list[idx + 1], list[idx]];
      return list;
    });

  const handleExtraChange = (idx: number, key: string, raw: string) => {
    const entry = catalogByKind.get(instances[idx]?.kind);
    if (!entry || !entry.variableCount) return;
    const min = entry.variableCount.min ?? 1;
    const max = entry.variableCount.max ?? 16;
    const v = Math.max(min, Math.min(max, Number(raw) || min));
    update((list) => {
      list[idx] = {
        ...list[idx],
        extras: { ...(list[idx].extras || {}), [key]: v },
      };
      return list;
    });
  };

  const handleAdd = () => {
    const kind = Number(addKind);
    if (!Number.isFinite(kind)) return;
    const entry = catalogByKind.get(kind);
    if (!entry) return;
    const inst: TlvInstance = { kind };
    if (entry.defaultExtras) inst.extras = { ...entry.defaultExtras };
    update((list) => {
      list.push(inst);
      return list;
    });
    setAddKind("");
  };

  return (
    <div>
      <h3 className="m-0 mb-2 text-[15px]" style={{ color: "var(--fg)" }}>
        {field.name}
      </h3>
      <p className="text-[12px] m-0 mb-2" style={{ color: "var(--fg-muted)" }}>
        Recursive TLV container. Add typed records below; the total length
        drives <code className="font-mono">{tlv.drivesController || ""}</code>.
      </p>

      <div
        className="rounded-md border divide-y"
        style={{
          borderColor: "var(--border)",
          background: "var(--bg-base)",
        }}
        role="list"
      >
        {instances.length === 0 ? (
          <p
            className="m-0 px-3 py-2 text-[12px]"
            style={{ color: "var(--fg-faint)" }}
          >
            No options attached yet.
          </p>
        ) : (
          instances.map((inst, i) => {
            const entry = catalogByKind.get(inst.kind);
            if (!entry) return null;
            const bits = tlvRecordBits(entry, inst);
            const vc = entry.variableCount;
            const extras = {
              ...(entry.defaultExtras || {}),
              ...(inst.extras || {}),
            };
            return (
              <div
                key={i}
                role="listitem"
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
                    kind {entry.kind}
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
                      className="text-[11px] px-2 py-0.5 rounded border"
                      onClick={() => handleRemove(i)}
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
                {vc ? (
                  <div className="mt-1.5 text-[12px] flex items-center gap-2">
                    <label
                      className="flex items-center gap-1.5"
                      style={{ color: "var(--fg-muted)" }}
                    >
                      {vc.label || vc.key}:
                      <input
                        type="number"
                        min={vc.min ?? 1}
                        max={vc.max ?? 16}
                        value={Number(extras[vc.key] ?? vc.min ?? 1)}
                        onChange={(e) =>
                          handleExtraChange(i, vc.key, e.target.value)
                        }
                        className="w-14 px-1.5 py-0.5 rounded border font-mono tabular-nums text-[12px]"
                        style={{
                          borderColor: "var(--border-strong)",
                          background: "var(--bg-elevated)",
                          color: "var(--fg)",
                        }}
                      />
                    </label>
                  </div>
                ) : null}
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
          Add option:
        </label>
        <select
          value={addKind}
          onChange={(e) => setAddKind(e.target.value)}
          className="px-2 py-1 rounded border text-[12px]"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--fg)",
          }}
        >
          <option value="">-- choose a record type --</option>
          {tlv.catalog.map((c) => (
            <option key={c.kind} value={c.kind}>
              {c.name} (kind {c.kind})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!addKind}
          className="text-[12px] px-2.5 py-1 rounded border"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--accent)",
            color: "var(--accent-fg, #fff)",
            opacity: addKind ? 1 : 0.5,
          }}
        >
          Add
        </button>
      </div>

      <p
        className="text-[12px] mt-2.5 mb-0"
        style={{ color: "var(--fg-muted)" }}
      >
        Total:{" "}
        <span className="font-mono tabular-nums">{summary.totalBits} b</span>;
        padded to{" "}
        <span className="font-mono tabular-nums">{summary.paddedBits} b</span>{" "}
        (= {summary.paddedBits / 8} B).
        {tlv.drivesController ? (
          <>
            {" "}
            Drives <code className="font-mono">
              {tlv.drivesController}
            </code> ={" "}
            <span className="font-mono tabular-nums">
              {controllers[tlv.drivesController]}
            </span>
            .
          </>
        ) : null}
      </p>
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
