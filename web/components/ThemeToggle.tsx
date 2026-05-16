"use client";

import { useEffect, useState } from "react";

import { THEME_STORAGE_KEY } from "@/lib/constants";

type Theme = "light" | "dark";

export default function ThemeToggle() {
  // Initial state is "light" so server-rendered markup is deterministic; we
  // sync to the real value (set by the pre-paint script in layout.tsx) inside
  // useEffect.
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const current = document.documentElement.getAttribute(
      "data-theme",
    ) as Theme | null;
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable (private mode, etc.) — that's fine.
    }
    setTheme(next);
  };

  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={isDark}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className="flex-none w-11 h-11 inline-flex items-center justify-center rounded-full cursor-pointer transition-colors"
      style={{
        background: "rgba(255,255,255,0.08)",
        color: "var(--header-fg)",
        border: "1px solid rgba(255,255,255,0.12)",
      }}
    >
      <span aria-hidden="true">{isDark ? "☀" : "☾"}</span>
    </button>
  );
}
