import type { Dispatch } from "react";

import {
  ConstraintEditor,
  ContainerRow,
  FieldRow,
  SourcePane,
  Toolbar,
} from "@/components/custom-packet-studio";
import type { EditAction, EditState } from "@/lib/psml/edit-reducer";
import type {
  Container as PsmlContainer,
  Field as PsmlField,
} from "@/lib/psml/types";
import type { StudioView } from "./ui-state-reducer";

type Props = {
  state: EditState;
  dispatch: Dispatch<EditAction>;
  view: StudioView;
  onViewChange: (next: StudioView) => void;
  onSaveAs: () => void;
  onDiscard: () => void;
  /** source ビューの未反映編集 (debounce 前 / parse エラー) を親へ伝える。 */
  onSourceDirtyChange?: (dirty: boolean) => void;
};

export default function StudioPanel({
  state,
  dispatch,
  view,
  onViewChange,
  onSaveAs,
  onDiscard,
  onSourceDirtyChange,
}: Props) {
  return (
    <section
      aria-label="Custom Packet Studio"
      className="rounded-[10px] border px-4 py-3.5 mt-4"
      style={{
        background: "var(--bg-elevated)",
        borderColor: "var(--border)",
        boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
      }}
    >
      <h2 className="text-xs m-0 mb-3 uppercase tracking-wider font-bold text-fg-muted">
        Custom Packet Studio
      </h2>
      <Toolbar
        dispatch={dispatch}
        insertPath={[state.packet.body.length]}
        historyLength={state.history.length}
        futureLength={state.future.length}
        view={view}
        onViewChange={onViewChange}
        onSaveAs={onSaveAs}
        onDiscard={onDiscard}
      />
      {view === "form" ? (
        <>
          <ol className="mt-3 flex flex-col gap-2 list-none p-0">
            {state.packet.body.map((node: PsmlContainer, i: number) => (
              <li key={containerId(node, i)}>
                {isLeafField(node) ? (
                  <FieldRow
                    field={node as PsmlField}
                    path={[i]}
                    dispatch={dispatch}
                    siblingFieldIds={state.packet.body
                      .filter(isLeafField)
                      .map((n) => (n as PsmlField).id)}
                  />
                ) : (
                  <ContainerRow
                    container={node as PsmlContainer}
                    path={[i]}
                    dispatch={dispatch}
                    siblingFieldIds={state.packet.body
                      .filter(isLeafField)
                      .map((n) => (n as PsmlField).id)}
                  />
                )}
              </li>
            ))}
          </ol>
          <div className="mt-4">
            <ConstraintEditor
              constraints={state.packet.constraints ?? []}
              fieldIds={state.packet.body
                .filter(isLeafField)
                .map((n) => (n as PsmlField).id)}
              dispatch={dispatch}
            />
          </div>
        </>
      ) : (
        <div className="mt-3">
          <SourcePane
            packet={state.packet}
            dispatch={dispatch}
            onDirtyChange={onSourceDirtyChange}
          />
        </div>
      )}
    </section>
  );
}

function isLeafField(node: PsmlContainer): boolean {
  const k = (node as { kind?: string }).kind;
  return !k || k === "field";
}

function containerId(node: PsmlContainer, fallback: number): string {
  const id = (node as { id?: string }).id;
  return id ?? `node-${fallback}`;
}
