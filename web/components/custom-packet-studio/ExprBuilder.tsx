import { useCallback } from "react";

import type { BinOp, Expr } from "@/lib/psdl/types";

type Props = {
  value: Expr;
  onChange: (e: Expr) => void;
  /** Field ids available for ref drop-down in this scope. */
  fieldIds: string[];
  /** Visual nesting depth (used to dial down padding for deeply-nested expressions). */
  depth?: number;
};

type ExprKind = "lit" | "ref" | "op" | "cond" | "peek";

const OPS: BinOp[] = ["+", "-", "*", "/", "%", "<<", ">>"];

function defaultExpr(kind: ExprKind): Expr {
  switch (kind) {
    case "lit":
      return { kind: "lit", value: 0 };
    case "ref":
      return { kind: "ref", field: "" };
    case "op":
      return {
        kind: "op",
        op: "+",
        a: { kind: "lit", value: 0 },
        b: { kind: "lit", value: 0 },
      };
    case "cond":
      return {
        kind: "cond",
        test: { kind: "lit", value: 0 },
        t: { kind: "lit", value: 0 },
        f: { kind: "lit", value: 0 },
      };
    case "peek":
      // PSDL 0.2 has no "peek" Expr variant in types.ts. We model it visually
      // but emit a lit placeholder; consumers that need peek will extend the
      // schema (out of scope for 7B). For now, return a labelled lit so the
      // user can still see a tab without producing invalid Expr.
      return { kind: "lit", value: 0 };
  }
}

function inputStyle(): React.CSSProperties {
  return {
    background: "var(--bg-elevated)",
    color: "var(--fg)",
    borderColor: "var(--border-strong)",
  };
}

function tabBtnStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? "var(--accent)" : "var(--bg-elevated)",
    color: active ? "var(--accent-fg)" : "var(--fg)",
    borderColor: active ? "var(--accent)" : "var(--border-strong)",
  };
}

export default function ExprBuilder({
  value,
  onChange,
  fieldIds,
  depth = 0,
}: Props) {
  const currentKind: ExprKind =
    value.kind === "lit"
      ? "lit"
      : value.kind === "ref"
        ? "ref"
        : value.kind === "op"
          ? "op"
          : "cond";

  const switchKind = useCallback(
    (k: ExprKind) => {
      onChange(defaultExpr(k));
    },
    [onChange],
  );

  return (
    <div
      className="flex flex-col gap-1 rounded-md border p-1.5"
      style={{
        background: "var(--bg-subtle)",
        borderColor: "var(--border)",
        marginLeft: depth > 0 ? 4 : 0,
      }}
    >
      <div
        role="tablist"
        aria-label="Expression kind"
        className="flex gap-1 flex-wrap"
      >
        {(["lit", "ref", "op", "cond", "peek"] as ExprKind[]).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={currentKind === k}
            onClick={() => switchKind(k)}
            className="text-xs px-2 py-0.5 rounded border"
            style={tabBtnStyle(currentKind === k)}
          >
            {k}
          </button>
        ))}
      </div>

      {value.kind === "lit" && (
        <input
          type="number"
          value={value.value}
          aria-label="Literal value"
          onChange={(e) =>
            onChange({ kind: "lit", value: Number(e.target.value) || 0 })
          }
          className="text-sm px-2 py-1 rounded border w-24"
          style={inputStyle()}
        />
      )}

      {value.kind === "ref" && (
        <select
          value={value.field}
          aria-label="Field reference"
          onChange={(e) => onChange({ kind: "ref", field: e.target.value })}
          className="text-sm px-2 py-1 rounded border"
          style={inputStyle()}
        >
          <option value="">— select field —</option>
          {fieldIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      )}

      {value.kind === "op" && (
        <div className="flex items-start gap-1">
          <ExprBuilder
            value={value.a}
            fieldIds={fieldIds}
            depth={depth + 1}
            onChange={(a) => onChange({ ...value, a })}
          />
          <select
            value={value.op}
            aria-label="Operator"
            onChange={(e) =>
              onChange({ ...value, op: e.target.value as BinOp })
            }
            className="text-sm px-2 py-1 rounded border"
            style={inputStyle()}
          >
            {OPS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          <ExprBuilder
            value={value.b}
            fieldIds={fieldIds}
            depth={depth + 1}
            onChange={(b) => onChange({ ...value, b })}
          />
        </div>
      )}

      {value.kind === "cond" && (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-fg-muted">test</label>
          <ExprBuilder
            value={value.test}
            fieldIds={fieldIds}
            depth={depth + 1}
            onChange={(test) => onChange({ ...value, test })}
          />
          <label className="text-xs text-fg-muted">then</label>
          <ExprBuilder
            value={value.t}
            fieldIds={fieldIds}
            depth={depth + 1}
            onChange={(t) => onChange({ ...value, t })}
          />
          <label className="text-xs text-fg-muted">else</label>
          <ExprBuilder
            value={value.f}
            fieldIds={fieldIds}
            depth={depth + 1}
            onChange={(f) => onChange({ ...value, f })}
          />
        </div>
      )}
    </div>
  );
}
