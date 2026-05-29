import { useState } from "react";

import type { EditAction, Path } from "@/lib/psdl/edit-reducer";
import type { CategoryToken, Field, Type } from "@/lib/psdl/types";

type TypeKind = Type["kind"];

const CATEGORIES: CategoryToken[] = [
  "addressing",
  "identifier",
  "length",
  "type",
  "flags",
  "reserved",
  "checksum",
  "variable",
  "payload-marker",
];

type Props = {
  field: Field;
  path: Path;
  dispatch: (a: EditAction) => void;
  siblingFieldIds: string[];
  rfcUrl?: string;
};

function inputStyle(): React.CSSProperties {
  return {
    background: "var(--bg-elevated)",
    color: "var(--fg)",
    borderColor: "var(--border-strong)",
  };
}

function typeBits(t: Type): number {
  if (t.kind === "int") return t.bits;
  if (t.kind === "bits") return t.n;
  if (t.kind === "enum") return t.bits;
  return 0;
}

function setTypeKind(prev: Type, kind: TypeKind): Type {
  switch (kind) {
    case "int":
      return { kind: "int", bits: typeBits(prev) || 8 };
    case "bits":
      return { kind: "bits", n: typeBits(prev) || 1 };
    case "bytes":
      return { kind: "bytes", n: { kind: "lit", value: 0 } };
    case "varint":
      return { kind: "varint", encoding: "quic" };
    case "enum":
      return { kind: "enum", bits: typeBits(prev) || 8, variants: {} };
    case "berLength":
      return { kind: "berLength" };
    default:
      // Future Type variants land here until the editor learns them.
      return prev;
  }
}

function setTypeBits(prev: Type, bits: number): Type {
  if (prev.kind === "int") return { ...prev, bits };
  if (prev.kind === "bits") return { ...prev, n: bits };
  if (prev.kind === "enum") return { ...prev, bits };
  return prev;
}

export default function FieldRow({ field, path, dispatch, rfcUrl }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  const update = (patch: Partial<Field>) =>
    dispatch({ type: "update-field", at: path, patch });

  const showBitWidth =
    field.type.kind === "int" ||
    field.type.kind === "bits" ||
    field.type.kind === "enum";

  const onDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData("application/x-psdl-path", JSON.stringify(path));
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/x-psdl-path");
    if (!raw) return;
    try {
      const from = JSON.parse(raw) as Path;
      dispatch({ type: "move-field", from, to: path });
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      role="row"
      aria-label={`Field ${field.name}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className="flex flex-wrap items-start gap-2 p-2 border-b bg-bg-elevated border-border"
    >
      <span
        aria-hidden
        title="Drag to reorder"
        className="cursor-grab select-none px-1 self-center text-fg-faint"
      >
        ⋮⋮
      </span>

      <input
        type="text"
        value={field.name}
        aria-label="Field name"
        onChange={(e) => update({ name: e.target.value })}
        className="text-sm px-2 py-1 rounded border w-40"
        style={inputStyle()}
      />

      <select
        value={field.type.kind}
        aria-label="Field type"
        onChange={(e) =>
          update({ type: setTypeKind(field.type, e.target.value as TypeKind) })
        }
        className="text-sm px-2 py-1 rounded border"
        style={inputStyle()}
      >
        <option value="int">Int</option>
        <option value="bits">Bits</option>
        <option value="bytes">Bytes</option>
        <option value="varint">Varint</option>
        <option value="enum">Enum</option>
      </select>

      {showBitWidth && (
        <input
          type="number"
          value={typeBits(field.type)}
          min={1}
          aria-label="Bit width"
          onChange={(e) =>
            update({
              type: setTypeBits(field.type, Number(e.target.value) || 1),
            })
          }
          className="text-sm px-2 py-1 rounded border w-20"
          style={inputStyle()}
        />
      )}

      <select
        value={field.category ?? ""}
        aria-label="Field category"
        onChange={(e) =>
          update({
            category: (e.target.value || undefined) as
              | CategoryToken
              | undefined,
          })
        }
        className="text-sm px-2 py-1 rounded border"
        style={inputStyle()}
      >
        <option value="">— category —</option>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <textarea
        value={field.doc ?? ""}
        aria-label="Field description"
        rows={1}
        onChange={(e) => update({ doc: e.target.value })}
        className="text-sm px-2 py-1 rounded border flex-1 min-w-40"
        style={inputStyle()}
      />

      <input
        type="text"
        defaultValue={rfcUrl ?? ""}
        aria-label="RFC URL"
        placeholder="RFC URL"
        className="text-sm px-2 py-1 rounded border w-40"
        style={inputStyle()}
      />

      <div className="relative">
        <button
          type="button"
          aria-label="Field actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className="text-sm font-medium px-2 py-1 rounded border"
          style={inputStyle()}
        >
          ⋯
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 z-10 mt-1 min-w-44 rounded-md border shadow-lg bg-bg-elevated border-border-strong"
          >
            <MenuItem
              label="Duplicate"
              onClick={() => {
                setMenuOpen(false);
                dispatch({
                  type: "add-field",
                  at: path,
                  field: { ...field, id: `${field.id}_copy` },
                });
              }}
            />
            <MenuItem
              label="Delete"
              onClick={() => {
                setMenuOpen(false);
                dispatch({ type: "delete-field", at: path });
              }}
            />
            <MenuItem
              label="Move up"
              onClick={() => {
                setMenuOpen(false);
                const last = path[path.length - 1];
                if (typeof last === "number" && last > 0) {
                  const to = [...path.slice(0, -1), last - 1];
                  dispatch({ type: "move-field", from: path, to });
                }
              }}
            />
            <MenuItem
              label="Move down"
              onClick={() => {
                setMenuOpen(false);
                const last = path[path.length - 1];
                if (typeof last === "number") {
                  const to = [...path.slice(0, -1), last + 1];
                  dispatch({ type: "move-field", from: path, to });
                }
              }}
            />
            <div className="border-t my-1 border-border" />
            {(
              ["struct", "group", "repeat", "switch", "encrypted"] as const
            ).map((kind) => (
              <MenuItem
                key={kind}
                label={`Wrap in ${kind}`}
                onClick={() => {
                  setMenuOpen(false);
                  dispatch({ type: "wrap-in", at: path, kind });
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full text-left text-sm px-3 py-1.5 hover:opacity-80 text-fg"
    >
      {label}
    </button>
  );
}
