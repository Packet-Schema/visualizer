// Pieces shared by the four ContainerRow editors. Kept tiny so each editor
// can stay focused on the container variant it owns.

import type { ContainerPatch } from "@/lib/psml/edit-reducer";
import type { Repeat } from "@/lib/psml/types";

export type Patch = (p: ContainerPatch) => void;

export function inputStyle(): React.CSSProperties {
  return {
    background: "var(--bg-elevated)",
    color: "var(--fg)",
    borderColor: "var(--border-strong)",
  };
}

export function tabStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? "var(--accent)" : "var(--bg-elevated)",
    color: active ? "var(--accent-fg)" : "var(--fg)",
    borderColor: active ? "var(--accent)" : "var(--border-strong)",
  };
}

export type RepeatCountTab = "literal" | "ref" | "eos" | "until";

export function repeatCountTab(c: Repeat["count"]): RepeatCountTab {
  if (c === "eos") return "eos";
  if (typeof c === "object" && "until" in c) return "until";
  if ("kind" in c && c.kind === "ref") return "ref";
  return "literal";
}

/**
 * Shared frame around every container editor: kind label + bordered card.
 * Children render under the label.
 */
export function Frame({
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
      className="flex flex-col gap-2 p-2 border-b bg-bg-subtle border-border"
    >
      <div className="text-xs uppercase tracking-wide text-fg-muted">
        {kind}
      </div>
      {children}
    </div>
  );
}
