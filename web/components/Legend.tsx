"use client";

import { useCallback } from "react";

import {
  CATEGORY_LABELS,
  CATEGORY_TO_TOKEN,
  tokenToCssVar,
} from "@/lib/constants";
import type { CategoryToken } from "@/lib/psml/renderer";

type Props = {
  categories: string[];
};

/**
 * Set a CSS custom property on document.documentElement so the diagram can
 * dim non-matching cells via `[data-category!="..."]` selectors. We toggle a
 * `--legend-hover-category` variable + a `data-hovered-category` attribute on
 * the diagram root.
 *
 * We do this imperatively rather than via React state to avoid re-rendering
 * the whole diagram on every legend hover.
 */
function setHoveredCategory(cat: string | null) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (cat) {
    root.setAttribute("data-hovered-category", cat);
  } else {
    root.removeAttribute("data-hovered-category");
  }
}

export default function Legend({ categories }: Props) {
  const handleEnter = useCallback(
    (cat: string) => () => setHoveredCategory(cat),
    [],
  );
  const handleLeave = useCallback(() => setHoveredCategory(null), []);

  if (categories.length === 0) return null;
  return (
    <aside
      className="rounded-[10px] border px-3.5 py-2.5 min-w-[180px]"
      style={{
        background: "var(--bg-elevated)",
        borderColor: "var(--border)",
        boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
      }}
    >
      <h2
        className="text-[11px] m-0 mb-2 uppercase tracking-wider font-bold"
        style={{ color: "var(--fg-muted)" }}
      >
        Legend
      </h2>
      <ul className="list-none m-0 p-0 grid gap-1">
        {categories.map((cat) => {
          const token = CATEGORY_TO_TOKEN[cat as CategoryToken];
          const label = CATEGORY_LABELS[cat as CategoryToken] || cat;
          return (
            <li
              key={cat}
              className="legend-item flex items-center gap-2 text-xs"
              style={{ color: "var(--fg)" }}
              onMouseEnter={handleEnter(cat)}
              onMouseLeave={handleLeave}
              onFocus={handleEnter(cat)}
              onBlur={handleLeave}
              tabIndex={0}
            >
              <span
                className="legend-swatch flex-none"
                style={{
                  background: tokenToCssVar(token),
                }}
                aria-hidden="true"
              />
              <span className="leading-tight">{label}</span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
