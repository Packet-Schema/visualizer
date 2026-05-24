// Recursive TLV record editor.
//
// Ported from the legacy `renderTlvDetail` in app.js. Renders the current
// instances as a list of rows (kind badge + name + bits + per-record slot
// count + reorder/remove buttons) plus an "Add option" selector below.
// The parent owns the field; we call `onChange(newInstances)` for every
// mutation and let it re-sync controllers.

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { tlvRecordBits, tlvTotalBits } from "@/lib/psml/renderer-helpers";
import { useListItemKeys } from "@/lib/use-list-item-keys";
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
  /** Controller-derived slot the user has reserved for this TLV (bytes).
   *  When the sum of `tlv.instances` exceeds it, the editor shows a
   *  warning banner — the wire format would be malformed because the
   *  upstream length controller (IHL / Data Offset) wouldn't cover the
   *  expanded payload. */
  slotBytes?: number;
};

export default function TlvEditor({
  field,
  controllers,
  onChange,
  slotBytes,
}: Props) {
  const tlv = field.tlv;

  const summary = useMemo(() => tlvTotalBits(field), [field]);

  const instances = tlv?.instances || [];
  const itemKeys = useListItemKeys(instances);

  // Staged-add: a separate Add button (mirrors ChainEditor) so keyboard-
  // only users scrolling through `<select>` options don't append a new
  // record per arrow press (sub-agent Round 7 HIGH).
  const [stagedKind, setStagedKind] = useState<string>("");
  const addSelectId = useId();

  // Announce list mutations to screen readers and restore focus context
  // after add / remove so SR users aren't dropped on an empty body
  // when the row their focus lived on is gone (sub-agent Round 7 HIGH).
  const [liveMsg, setLiveMsg] = useState<string>("");
  const prevLengthRef = useRef(instances.length);
  const addSelectRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => {
    const prev = prevLengthRef.current;
    const next = instances.length;
    if (next > prev) {
      setLiveMsg(`Record ${next} added.`);
    } else if (next < prev) {
      setLiveMsg(
        `Record removed. ${next} record${next === 1 ? "" : "s"} attached.`,
      );
      // The deleted row's Remove button no longer exists; refocus the
      // add picker so keyboard users keep a reachable target.
      addSelectRef.current?.focus();
    }
    prevLengthRef.current = next;
  }, [instances.length]);

  if (!tlv) return null;

  const catalogByKind = new Map<number, TlvCatalogEntry>(
    tlv.catalog.map((c) => [c.kind, c]),
  );

  // Shallow-copy the array so React sees a new reference, but keep each
  // instance object's identity stable across mutations that don't touch its
  // fields. That lets `useListItemKeys` track rows through reorder/remove
  // without remounting them.
  const update = (mutator: (list: TlvInstance[]) => TlvInstance[]) => {
    onChange(mutator(instances.slice()));
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

  const handleKindChange = (idx: number, raw: string) => {
    const newKind = Number(raw);
    if (!Number.isFinite(newKind)) return;
    const entry = catalogByKind.get(newKind);
    if (!entry) return;
    update((list) => {
      // Preserve user-edited extras across a variant switch: layer the new
      // variant's `defaultExtras` underneath the previous instance's
      // `extras` so any shared keys (typical: a per-record count like
      // Timestamp's address slot count) keep the user's value rather than
      // silently snapping back to the default. The runtime ignores keys
      // the new variant doesn't use, so there's no risk of stale state
      // leaking into a different shape.
      const prevExtras = list[idx]?.extras;
      const mergedExtras = {
        ...(entry.defaultExtras ?? {}),
        ...(prevExtras ?? {}),
      };
      const inst: TlvInstance = { kind: newKind };
      if (Object.keys(mergedExtras).length > 0) inst.extras = mergedExtras;
      list[idx] = inst;
      return list;
    });
  };

  const totalBytesUsed = Math.ceil(summary.totalBits / 8);
  const overshootBy =
    slotBytes !== undefined && totalBytesUsed > slotBytes
      ? totalBytesUsed - slotBytes
      : 0;

  return (
    <div>
      <h3 className="m-0 mb-2 text-[15px] text-fg">{field.name}</h3>
      <p className="text-xs m-0 mb-2 text-fg-muted">
        Recursive TLV container. Add typed records below; the total length
        drives <code className="font-mono">{tlv.drivesController || ""}</code>.
      </p>
      {overshootBy > 0 ? (
        <p
          role="alert"
          className="text-xs m-0 mb-2 px-2 py-1.5 rounded border"
          style={{
            borderColor: "var(--field-rose)",
            background:
              "color-mix(in oklch, var(--field-rose) 12%, transparent)",
            color: "var(--fg)",
          }}
        >
          ⚠ Records total {totalBytesUsed} B but the slot is only {slotBytes} B
          ({overshootBy} B over). Grow the upstream length controller or remove
          records to keep the wire format valid.
        </p>
      ) : null}

      <div
        className="rounded-md border divide-y"
        style={{
          borderColor: "var(--border)",
          background: "var(--bg-base)",
        }}
        role="list"
      >
        {instances.length === 0 ? (
          <p className="m-0 px-3 py-2 text-xs text-fg-faint">
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
                key={itemKeys[i]}
                role="listitem"
                className="px-3 py-2 border-border"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="text-3xs font-mono tabular-nums text-fg-muted shrink-0"
                    aria-hidden
                  >
                    #{i}
                  </span>
                  <select
                    aria-label={`Record ${i} variant`}
                    value={inst.kind}
                    onChange={(e) => handleKindChange(i, e.target.value)}
                    className="flex-1 min-w-0 px-2 py-1 rounded border font-mono text-sm-tight"
                    style={{
                      borderColor: "var(--border-strong)",
                      background: "var(--bg-elevated)",
                      color: "var(--fg)",
                    }}
                  >
                    {tlv.catalog.map((c) => (
                      <option key={c.kind} value={c.kind}>
                        kind {c.kind} — {c.name}
                      </option>
                    ))}
                  </select>
                  <span className="text-3xs font-mono tabular-nums text-fg-muted shrink-0">
                    {bits} b / {bits / 8} B
                  </span>
                  <div className="ml-auto flex items-center gap-1 shrink-0">
                    <IconBtn
                      label={`Move record ${i} up`}
                      disabled={i === 0}
                      onClick={() => handleMoveUp(i)}
                    >
                      ↑
                    </IconBtn>
                    <IconBtn
                      label={`Move record ${i} down`}
                      disabled={i === instances.length - 1}
                      onClick={() => handleMoveDown(i)}
                    >
                      ↓
                    </IconBtn>
                    <button
                      type="button"
                      aria-label={`Remove record ${i}`}
                      className="text-3xs w-6 h-6 rounded border font-mono"
                      onClick={() => handleRemove(i)}
                      style={{
                        borderColor: "var(--border-strong)",
                        color: "var(--fg)",
                        background: "var(--bg-elevated)",
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>
                {vc ? (
                  <div className="mt-1.5 text-xs flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-fg-muted">
                      {vc.label || vc.key}:
                      <input
                        type="number"
                        min={vc.min ?? 1}
                        max={vc.max ?? 16}
                        value={Number(extras[vc.key] ?? vc.min ?? 1)}
                        onChange={(e) =>
                          handleExtraChange(i, vc.key, e.target.value)
                        }
                        className="w-14 px-1.5 py-0.5 rounded border font-mono tabular-nums text-xs"
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
                  <p className="m-0 mt-1 text-3xs text-fg-faint">
                    {entry.description}
                  </p>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <label htmlFor={addSelectId} className="text-xs text-fg-muted">
          + Add record:
        </label>
        <select
          id={addSelectId}
          ref={addSelectRef}
          value={stagedKind}
          onChange={(e) => setStagedKind(e.target.value)}
          className="px-2 py-1 rounded border text-xs"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--fg)",
          }}
        >
          <option value="">-- pick a record type to append --</option>
          {tlv.catalog.map((c) => (
            <option key={c.kind} value={c.kind}>
              kind {c.kind} — {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            if (!stagedKind) return;
            const kind = Number(stagedKind);
            const entry = catalogByKind.get(kind);
            if (!entry) return;
            const inst: TlvInstance = { kind };
            if (entry.defaultExtras) inst.extras = { ...entry.defaultExtras };
            update((list) => {
              list.push(inst);
              return list;
            });
            setStagedKind("");
          }}
          disabled={!stagedKind}
          className="text-xs px-2.5 py-1 rounded border"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--accent)",
            color: "var(--accent-fg, #fff)",
            opacity: stagedKind ? 1 : 0.5,
          }}
        >
          Add
        </button>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {liveMsg}
      </div>

      <p className="text-xs mt-2.5 mb-0 text-fg-muted">
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
