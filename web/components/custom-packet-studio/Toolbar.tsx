import type { EditAction } from "@/lib/psml/edit-reducer";
import type { Container, Field } from "@/lib/psml/types";

type Props = {
  dispatch: (a: EditAction) => void;
  /** Path at which new fields/containers are appended. */
  insertPath: (string | number)[];
  historyLength: number;
  futureLength: number;
  jsonOpen: boolean;
  onToggleJson: () => void;
  onSaveAs: () => void;
  onDiscard: () => void;
};

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

function makeField(): Field {
  return {
    id: nextId("f"),
    name: "new_field",
    type: { kind: "int", bits: 8 },
  };
}

function makeContainer(
  kind: "struct" | "group" | "repeat" | "switch" | "encrypted",
): Container {
  const id = nextId(kind);
  if (kind === "group") {
    return { kind: "group", id, name: "group", children: [] };
  }
  if (kind === "repeat") {
    return {
      kind: "repeat",
      id,
      name: "repeat",
      element: { id: nextId("s"), fields: [] },
      count: { kind: "lit", value: 1 },
    };
  }
  if (kind === "switch") {
    return {
      kind: "switch",
      id,
      name: "switch",
      on: { kind: "lit", value: 0 },
      cases: {},
    };
  }
  if (kind === "encrypted") {
    return {
      kind: "encrypted",
      id,
      name: "encrypted",
      plaintext: { id: nextId("s"), fields: [] },
      contextNote: "",
    };
  }
  // struct → represented as a Group of a single Struct's fields per Container union.
  // PSML uses Group for inline ordering; "+ Struct" wraps an existing list,
  // so for the top-level button we emit a Group as the closest analogue.
  return { kind: "group", id, name: "struct", children: [] };
}

function btnStyle(pressed?: boolean, disabled?: boolean): React.CSSProperties {
  return {
    background: pressed ? "var(--accent)" : "var(--bg-elevated)",
    color: pressed ? "var(--accent-fg)" : "var(--fg)",
    borderColor: pressed ? "var(--accent)" : "var(--border-strong)",
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

export default function Toolbar({
  dispatch,
  insertPath,
  historyLength,
  futureLength,
  jsonOpen,
  onToggleJson,
  onSaveAs,
  onDiscard,
}: Props) {
  const addField = () =>
    dispatch({ type: "add-field", at: insertPath, field: makeField() });
  const addContainer = (
    kind: "struct" | "group" | "repeat" | "switch" | "encrypted",
  ) =>
    dispatch({
      type: "add-container",
      at: insertPath,
      container: makeContainer(kind),
    });

  const undoDisabled = historyLength === 0;
  const redoDisabled = futureLength === 0;

  return (
    <div
      role="toolbar"
      aria-label="Custom Packet Studio toolbar"
      className="flex flex-wrap items-center gap-1.5 p-2 border-b bg-bg-subtle border-border-strong"
    >
      <button
        type="button"
        onClick={addField}
        aria-label="Add field"
        className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
        style={btnStyle()}
      >
        + Field
      </button>
      <button
        type="button"
        onClick={() => addContainer("struct")}
        aria-label="Add struct"
        className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
        style={btnStyle()}
      >
        + Struct
      </button>
      <button
        type="button"
        onClick={() => addContainer("group")}
        aria-label="Add group"
        className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
        style={btnStyle()}
      >
        + Group
      </button>
      <button
        type="button"
        onClick={() => addContainer("repeat")}
        aria-label="Add repeat"
        className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
        style={btnStyle()}
      >
        + Repeat
      </button>
      <button
        type="button"
        onClick={() => addContainer("switch")}
        aria-label="Add switch"
        className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
        style={btnStyle()}
      >
        + Switch
      </button>
      <button
        type="button"
        onClick={() => addContainer("encrypted")}
        aria-label="Add encrypted"
        className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
        style={btnStyle()}
      >
        + Encrypted
      </button>

      <span
        aria-hidden
        className="mx-1 h-5 w-px"
        style={{ background: "var(--border-strong)" }}
      />

      <button
        type="button"
        onClick={() => dispatch({ type: "undo" })}
        aria-label="Undo"
        disabled={undoDisabled}
        className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
        style={btnStyle(false, undoDisabled)}
      >
        Undo
      </button>
      <button
        type="button"
        onClick={() => dispatch({ type: "redo" })}
        aria-label="Redo"
        disabled={redoDisabled}
        className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
        style={btnStyle(false, redoDisabled)}
      >
        Redo
      </button>

      <span
        aria-hidden
        className="mx-1 h-5 w-px"
        style={{ background: "var(--border-strong)" }}
      />

      <button
        type="button"
        onClick={onSaveAs}
        aria-label="Save as my preset"
        className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
        style={btnStyle()}
      >
        Save as my preset
      </button>
      <button
        type="button"
        onClick={onDiscard}
        aria-label="Discard changes"
        className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
        style={btnStyle()}
      >
        Discard
      </button>

      <span
        aria-hidden
        className="mx-1 h-5 w-px"
        style={{ background: "var(--border-strong)" }}
      />

      <button
        type="button"
        onClick={onToggleJson}
        aria-label="Edit JSON"
        aria-pressed={jsonOpen}
        className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
        style={btnStyle(jsonOpen)}
      >
        Edit JSON
      </button>
    </div>
  );
}
