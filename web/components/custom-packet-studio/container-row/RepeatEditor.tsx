import type { Repeat } from "@/lib/psml/types";

import ExprBuilder from "../ExprBuilder";

import {
  Frame,
  inputStyle,
  repeatCountTab,
  tabStyle,
  type Patch,
  type RepeatCountTab,
} from "./shared";

export function RepeatEditor({
  container,
  patch,
  siblingFieldIds,
}: {
  container: Repeat;
  patch: Patch;
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
