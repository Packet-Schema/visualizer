import { useState } from "react";

import type { EditAction, Path } from "@/lib/psml/edit-reducer";
import type {
  Container,
  Encrypted,
  Expr,
  Group,
  Repeat,
  Switch,
} from "@/lib/psml/types";

import ExprBuilder from "./ExprBuilder";

type Props = {
  container: Container;
  path: Path;
  dispatch: (a: EditAction) => void;
  siblingFieldIds: string[];
};

function inputStyle(): React.CSSProperties {
  return {
    background: "var(--bg-elevated)",
    color: "var(--fg)",
    borderColor: "var(--border-strong)",
  };
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? "var(--accent)" : "var(--bg-elevated)",
    color: active ? "var(--accent-fg)" : "var(--fg)",
    borderColor: active ? "var(--accent)" : "var(--border-strong)",
  };
}

type RepeatCountTab = "literal" | "ref" | "eos" | "until";

function repeatCountTab(c: Repeat["count"]): RepeatCountTab {
  if (c === "eos") return "eos";
  if (typeof c === "object" && "until" in c) return "until";
  if ("kind" in c && c.kind === "ref") return "ref";
  return "literal";
}

export default function ContainerRow({
  container,
  path,
  dispatch,
  siblingFieldIds,
}: Props) {
  const patch = (p: Record<string, unknown>) =>
    dispatch({ type: "update-container", at: path, patch: p });

  // Group has no kind discriminator beyond `kind: 'group'`; treat fields-of
  // Struct similarly when wrapped in Group containers.
  if (!("kind" in container)) {
    // It is a Field — ContainerRow is not meant to render Fields directly.
    return null;
  }

  if (container.kind === "group") {
    return <GroupEditor container={container} patch={patch} />;
  }
  if (container.kind === "repeat") {
    return (
      <RepeatEditor
        container={container}
        patch={patch}
        siblingFieldIds={siblingFieldIds}
      />
    );
  }
  if (container.kind === "switch") {
    return (
      <SwitchEditor
        container={container}
        patch={patch}
        siblingFieldIds={siblingFieldIds}
      />
    );
  }
  if (container.kind === "encrypted") {
    return (
      <EncryptedEditor
        container={container}
        patch={patch}
        siblingFieldIds={siblingFieldIds}
      />
    );
  }
  return null;
}

function Frame({
  kind,
  children,
}: {
  kind: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={`${kind} container`}
      className="flex flex-col gap-2 p-2 border-b"
      style={{
        background: "var(--bg-subtle)",
        borderColor: "var(--border)",
      }}
    >
      <div
        className="text-xs uppercase tracking-wide"
        style={{ color: "var(--fg-muted)" }}
      >
        {kind}
      </div>
      {children}
    </div>
  );
}

function GroupEditor({
  container,
  patch,
}: {
  container: Group;
  patch: (p: Record<string, unknown>) => void;
}) {
  return (
    <Frame kind="group">
      <input
        type="text"
        value={container.name ?? ""}
        aria-label="Group name"
        placeholder="name"
        onChange={(e) => patch({ name: e.target.value })}
        className="text-sm px-2 py-1 rounded border w-60"
        style={inputStyle()}
      />
    </Frame>
  );
}

function RepeatEditor({
  container,
  patch,
  siblingFieldIds,
}: {
  container: Repeat;
  patch: (p: Record<string, unknown>) => void;
  siblingFieldIds: string[];
}) {
  const tab = repeatCountTab(container.count);

  const setTab = (t: RepeatCountTab) => {
    let next: Repeat["count"];
    if (t === "eos") next = "eos";
    else if (t === "until") next = { until: { kind: "lit", value: 0 } };
    else if (t === "ref")
      next = { kind: "ref", field: siblingFieldIds[0] ?? "" };
    else next = { kind: "lit", value: 1 };
    patch({ count: next });
  };

  return (
    <Frame kind="repeat">
      <input
        type="text"
        value={container.name ?? ""}
        aria-label="Repeat name"
        placeholder="name"
        onChange={(e) => patch({ name: e.target.value })}
        className="text-sm px-2 py-1 rounded border w-60"
        style={inputStyle()}
      />
      <div
        role="tablist"
        aria-label="Repeat count source"
        className="flex gap-1"
      >
        {(["literal", "ref", "eos", "until"] as RepeatCountTab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className="text-xs px-2 py-1 rounded border"
            style={tabStyle(tab === t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "literal" &&
        container.count !== "eos" &&
        "kind" in container.count &&
        container.count.kind === "lit" && (
          <input
            type="number"
            value={container.count.value}
            aria-label="Repeat literal count"
            onChange={(e) =>
              patch({
                count: { kind: "lit", value: Number(e.target.value) || 0 },
              })
            }
            className="text-sm px-2 py-1 rounded border w-24"
            style={inputStyle()}
          />
        )}
      {tab === "ref" &&
        container.count !== "eos" &&
        "kind" in container.count &&
        container.count.kind === "ref" && (
          <ExprBuilder
            value={container.count}
            fieldIds={siblingFieldIds}
            onChange={(e) => patch({ count: e })}
          />
        )}
      {tab === "until" &&
        typeof container.count === "object" &&
        "until" in container.count && (
          <ExprBuilder
            value={container.count.until}
            fieldIds={siblingFieldIds}
            onChange={(e) => patch({ count: { until: e } })}
          />
        )}
    </Frame>
  );
}

function SwitchEditor({
  container,
  patch,
  siblingFieldIds,
}: {
  container: Switch;
  patch: (p: Record<string, unknown>) => void;
  siblingFieldIds: string[];
}) {
  const [newCaseKey, setNewCaseKey] = useState("");
  const setOn = (on: Expr) => patch({ on });
  const updateCases = (cases: Switch["cases"]) => patch({ cases });

  return (
    <Frame kind="switch">
      <input
        type="text"
        value={container.name ?? ""}
        aria-label="Switch name"
        placeholder="name"
        onChange={(e) => patch({ name: e.target.value })}
        className="text-sm px-2 py-1 rounded border w-60"
        style={inputStyle()}
      />
      <label className="text-xs" style={{ color: "var(--fg-muted)" }}>
        on
      </label>
      <ExprBuilder
        value={container.on}
        fieldIds={siblingFieldIds}
        onChange={setOn}
      />
      <div className="flex flex-col gap-1">
        <div className="text-xs" style={{ color: "var(--fg-muted)" }}>
          cases
        </div>
        {Object.entries(container.cases).map(([k, v]) => (
          <div key={k} className="flex items-center gap-2">
            <span
              className="text-sm font-mono px-2 py-1 rounded border"
              style={inputStyle()}
            >
              {k}
            </span>
            <span style={{ color: "var(--fg-muted)" }}>→</span>
            <input
              type="text"
              value={v.name ?? v.id}
              aria-label={`Case ${k} struct name`}
              onChange={(e) => {
                const next = {
                  ...container.cases,
                  [k]: { ...v, name: e.target.value },
                };
                updateCases(next);
              }}
              className="text-sm px-2 py-1 rounded border flex-1"
              style={inputStyle()}
            />
            <button
              type="button"
              aria-label={`Delete case ${k}`}
              onClick={() => {
                const next = { ...container.cases };
                delete next[k];
                updateCases(next);
              }}
              className="text-sm px-2 py-1 rounded border"
              style={inputStyle()}
            >
              ×
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newCaseKey}
            aria-label="New case key"
            placeholder="case key"
            onChange={(e) => setNewCaseKey(e.target.value)}
            className="text-sm px-2 py-1 rounded border w-32"
            style={inputStyle()}
          />
          <button
            type="button"
            aria-label="Add case"
            onClick={() => {
              if (!newCaseKey.trim()) return;
              const next = {
                ...container.cases,
                [newCaseKey.trim()]: {
                  id: `${container.id}_${newCaseKey.trim()}`,
                  fields: [],
                },
              };
              updateCases(next);
              setNewCaseKey("");
            }}
            className="text-sm px-2 py-1 rounded border"
            style={inputStyle()}
          >
            + Case
          </button>
        </div>
      </div>
    </Frame>
  );
}

function EncryptedEditor({
  container,
  patch,
  siblingFieldIds,
}: {
  container: Encrypted;
  patch: (p: Record<string, unknown>) => void;
  siblingFieldIds: string[];
}) {
  const plaintextIds = container.plaintext.fields
    .filter((f): f is Container & { id: string } => "id" in f)
    .map((f) => f.id);
  const protectedSet = new Set(container.headerProtected ?? []);

  const toggleProtected = (id: string) => {
    const next = new Set(protectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    patch({ headerProtected: Array.from(next) });
  };

  return (
    <Frame kind="encrypted">
      <input
        type="text"
        value={container.name ?? ""}
        aria-label="Encrypted name"
        placeholder="name"
        onChange={(e) => patch({ name: e.target.value })}
        className="text-sm px-2 py-1 rounded border w-60"
        style={inputStyle()}
      />
      <label className="text-xs" style={{ color: "var(--fg-muted)" }}>
        wireBits
      </label>
      <ExprBuilder
        value={container.wireBits ?? { kind: "lit", value: 0 }}
        fieldIds={siblingFieldIds}
        onChange={(e) => patch({ wireBits: e })}
      />
      <label className="text-xs" style={{ color: "var(--fg-muted)" }}>
        contextNote
      </label>
      <textarea
        value={container.contextNote}
        aria-label="Context note"
        rows={2}
        onChange={(e) => patch({ contextNote: e.target.value })}
        className="text-sm px-2 py-1 rounded border"
        style={inputStyle()}
      />
      <label className="text-xs" style={{ color: "var(--fg-muted)" }}>
        headerProtected
      </label>
      <div className="flex flex-wrap gap-2">
        {plaintextIds.length === 0 && (
          <span className="text-xs" style={{ color: "var(--fg-faint)" }}>
            (no plaintext fields)
          </span>
        )}
        {plaintextIds.map((id) => (
          <label
            key={id}
            className="text-sm flex items-center gap-1 px-2 py-1 rounded border"
            style={inputStyle()}
          >
            <input
              type="checkbox"
              checked={protectedSet.has(id)}
              onChange={() => toggleProtected(id)}
              aria-label={`Header-protect ${id}`}
            />
            {id}
          </label>
        ))}
      </div>
    </Frame>
  );
}
