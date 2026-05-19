import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = {
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  ariaLabel?: string;
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick" | "children" | "aria-label"
>;

export default function ToolbarButton({
  onClick,
  children,
  pressed,
  ariaLabel,
  ...rest
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
      style={{
        background: pressed ? "var(--accent)" : "var(--bg-elevated)",
        color: pressed ? "var(--accent-fg)" : "var(--fg)",
        borderColor: pressed ? "var(--accent)" : "var(--border-strong)",
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
