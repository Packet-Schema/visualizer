"use client";

import { useEffect, useState } from "react";

import { THEME_STORAGE_KEY } from "@/lib/constants";

type Theme = "light" | "dark";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  // Toggling this attribute (instead of imperatively running an animation)
  // hands the bounce to CSS keyframes. Removing it on `animationend` lets
  // the same click animate again. `prefers-reduced-motion` is honoured by
  // the global override in globals.css so we don't need to gate here.
  const [bouncing, setBouncing] = useState(false);

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
    setBouncing(true);
  };

  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      onAnimationEnd={() => setBouncing(false)}
      data-bounce={bouncing ? "true" : undefined}
      aria-pressed={isDark}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className="theme-toggle-btn flex-none w-11 h-11 inline-flex items-center justify-center rounded-full cursor-pointer"
    >
      <span aria-hidden="true">{isDark ? "☀" : "☾"}</span>
    </button>
  );
}
