"use client";

import {
  CATEGORY_LABELS,
  CATEGORY_TO_TOKEN,
  tokenToCssVar,
} from "@/lib/constants";
import type { CategoryToken } from "@/lib/types";

type Props = {
  categories: string[];
};

export default function Legend({ categories }: Props) {
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
              className="flex items-center gap-2 text-xs"
              style={{ color: "var(--fg)" }}
            >
              <span
                className="inline-block w-3.5 h-3.5 rounded-[4px] border flex-none"
                style={{
                  background: tokenToCssVar(token),
                  borderColor: "var(--field-stroke)",
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
