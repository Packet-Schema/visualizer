import { useState } from "react";

import type { Expr, Switch } from "@/lib/psml/types";

import ExprBuilder from "../ExprBuilder";

import { Frame, inputStyle, type Patch } from "./shared";

export function SwitchEditor({
  container,
  patch,
  siblingFieldIds,
}: {
  container: Switch;
  patch: Patch;
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
      <label className="text-xs text-fg-muted">on</label>
      <ExprBuilder
        value={container.on}
        fieldIds={siblingFieldIds}
        onChange={setOn}
      />
      <div className="flex flex-col gap-1">
        <div className="text-xs text-fg-muted">cases</div>
        {Object.entries(container.cases).map(([k, v]) => (
          <div key={k} className="flex items-center gap-2">
            <span
              className="text-sm font-mono px-2 py-1 rounded border"
              style={inputStyle()}
            >
              {k}
            </span>
            <span className="text-fg-muted">→</span>
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
