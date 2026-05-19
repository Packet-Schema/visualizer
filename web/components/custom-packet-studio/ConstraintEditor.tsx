import { useMemo, useState } from "react";

import { validate } from "@/lib/psml/constraint";
import type { EditAction } from "@/lib/psml/edit-reducer";
import type { Constraint, Expr, PacketEnv } from "@/lib/psml/types";

import ExprBuilder from "./ExprBuilder";

type Props = {
  constraints: Constraint[];
  fieldIds: string[];
  dispatch: (a: EditAction) => void;
  /** Optional env to evaluate live status. When omitted we render "cannot verify". */
  env?: PacketEnv;
};

function inputStyle(): React.CSSProperties {
  return {
    background: "var(--bg-elevated)",
    color: "var(--fg)",
    borderColor: "var(--border-strong)",
  };
}

function StatusBadge({
  constraints,
  env,
}: {
  constraints: Constraint[];
  env: PacketEnv | undefined;
}) {
  const result = useMemo(() => {
    if (!env) return { state: "unknown" as const };
    const v = validate(constraints, env);
    if ("ok" in v) return { state: "ok" as const };
    return { state: "conflict" as const, message: v.conflict };
  }, [constraints, env]);

  if (result.state === "unknown") {
    return (
      <span
        className="text-xs px-2 py-0.5 rounded border"
        style={{
          background: "var(--bg-subtle)",
          color: "var(--fg-muted)",
          borderColor: "var(--border)",
        }}
      >
        cannot verify
      </span>
    );
  }
  if (result.state === "ok") {
    return (
      <span
        className="text-xs px-2 py-0.5 rounded border"
        style={{
          background: "var(--field-green)",
          color: "var(--accent-fg)",
          borderColor: "var(--border-strong)",
        }}
      >
        ok
      </span>
    );
  }
  return (
    <span
      title={result.message}
      className="text-xs px-2 py-0.5 rounded border"
      style={{
        background: "var(--field-rose)",
        color: "var(--accent-fg)",
        borderColor: "var(--border-strong)",
      }}
    >
      conflict
    </span>
  );
}

export default function ConstraintEditor({
  constraints,
  fieldIds,
  dispatch,
  env,
}: Props) {
  const [draftLhs, setDraftLhs] = useState<Expr>({ kind: "lit", value: 0 });
  const [draftRhs, setDraftRhs] = useState<Expr>({ kind: "lit", value: 0 });

  const addDraft = () => {
    dispatch({
      type: "add-constraint",
      constraint: { lhs: draftLhs, rhs: draftRhs },
    });
    setDraftLhs({ kind: "lit", value: 0 });
    setDraftRhs({ kind: "lit", value: 0 });
  };

  return (
    <section
      aria-label="Constraints"
      className="flex flex-col gap-3 p-3 border-t"
      style={{
        background: "var(--bg-elevated)",
        borderColor: "var(--border-strong)",
      }}
    >
      <header className="flex items-center gap-2">
        <h3 className="text-sm font-semibold" style={{ color: "var(--fg)" }}>
          Constraints
        </h3>
        <StatusBadge constraints={constraints} env={env} />
      </header>
      <ul className="flex flex-col gap-2">
        {constraints.map((c, i) => (
          <li
            key={i}
            className="flex items-start gap-2 p-2 rounded border"
            style={{
              background: "var(--bg-subtle)",
              borderColor: "var(--border)",
            }}
          >
            <ExprBuilder
              value={c.lhs}
              fieldIds={fieldIds}
              onChange={(lhs) =>
                dispatch({
                  type: "update-constraint",
                  index: i,
                  patch: { lhs },
                })
              }
            />
            <span
              className="self-center px-1 font-mono"
              style={{ color: "var(--fg-muted)" }}
            >
              ==
            </span>
            <ExprBuilder
              value={c.rhs}
              fieldIds={fieldIds}
              onChange={(rhs) =>
                dispatch({
                  type: "update-constraint",
                  index: i,
                  patch: { rhs },
                })
              }
            />
            <button
              type="button"
              aria-label={`Delete constraint ${i + 1}`}
              onClick={() => dispatch({ type: "delete-constraint", index: i })}
              className="text-sm px-2 py-1 rounded border self-center"
              style={inputStyle()}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div
        className="flex items-start gap-2 p-2 rounded border"
        style={{
          background: "var(--bg-subtle)",
          borderColor: "var(--border)",
        }}
      >
        <ExprBuilder
          value={draftLhs}
          fieldIds={fieldIds}
          onChange={setDraftLhs}
        />
        <span
          className="self-center px-1 font-mono"
          style={{ color: "var(--fg-muted)" }}
        >
          ==
        </span>
        <ExprBuilder
          value={draftRhs}
          fieldIds={fieldIds}
          onChange={setDraftRhs}
        />
        <button
          type="button"
          aria-label="Add constraint"
          onClick={addDraft}
          className="text-sm font-medium px-2.5 py-1.5 rounded border self-center"
          style={inputStyle()}
        >
          + Add constraint
        </button>
      </div>
    </section>
  );
}
