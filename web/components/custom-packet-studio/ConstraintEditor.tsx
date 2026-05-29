import { useMemo, useState } from "react";

import { validate } from "@/lib/psdl/constraint";
import type { EditAction } from "@/lib/psdl/edit-reducer";
import type { Constraint, Expr, PacketEnv } from "@/lib/psdl/types";

/**
 * Mint a unique key for a new Constraint row. We can't use
 * `useListItemKeys` here because the studio reducer deep-clones the
 * packet on every action (so object identity is destroyed each
 * dispatch); attaching a stable `_uid` directly to the Constraint and
 * letting it survive the clone is what keeps React focus/state pinned
 * to the right row through reorder / insert / delete (Copilot review).
 *
 * `crypto.randomUUID()` (with a Math.random fallback for non-secure
 * jsdom / older webview contexts that don't expose it) makes the value
 * effectively collision-free even after a page reload — an earlier
 * module-level counter form `c1`, `c2`, ... would have collided on
 * reload because `_uid` is persisted when the packet is saved /
 * exported via `JSON.stringify`.
 */
function mintConstraintUid(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `c-${crypto.randomUUID()}`;
  }
  return `c-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

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
      <span className="text-xs px-2 py-0.5 rounded border bg-bg-subtle text-fg-muted border-border">
        cannot verify
      </span>
    );
  }
  if (result.state === "ok") {
    return (
      <span className="text-xs px-2 py-0.5 rounded border bg-field-green text-accent-fg border-border-strong">
        ok
      </span>
    );
  }
  return (
    <span
      title={result.message}
      className="text-xs px-2 py-0.5 rounded border bg-field-rose text-accent-fg border-border-strong"
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
      constraint: { lhs: draftLhs, rhs: draftRhs, _uid: mintConstraintUid() },
    });
    setDraftLhs({ kind: "lit", value: 0 });
    setDraftRhs({ kind: "lit", value: 0 });
  };

  return (
    <section
      aria-label="Constraints"
      className="flex flex-col gap-3 p-3 border-t bg-bg-elevated border-border-strong"
    >
      <header className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-fg">Constraints</h3>
        <StatusBadge constraints={constraints} env={env} />
      </header>
      <ul className="flex flex-col gap-2">
        {constraints.map((c, i) => (
          <li
            key={c._uid ?? `c-${i}`}
            className="flex items-start gap-2 p-2 rounded border bg-bg-subtle border-border"
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
            <span className="self-center px-1 font-mono text-fg-muted">==</span>
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
      <div className="flex items-start gap-2 p-2 rounded border bg-bg-subtle border-border">
        <ExprBuilder
          value={draftLhs}
          fieldIds={fieldIds}
          onChange={setDraftLhs}
        />
        <span className="self-center px-1 font-mono text-fg-muted">==</span>
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
