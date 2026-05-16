"use client";

import { useEffect, useRef, useState } from "react";

import { THEME_STORAGE_KEY } from "@/lib/constants";

type Theme = "light" | "dark";

/** Check if the user has asked the OS to reduce motion. Used to skip
 *  the bounce animation when appropriate. */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const current = document.documentElement.getAttribute(
      "data-theme",
    ) as Theme | null;
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  const toggle = async () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable (private mode, etc.) — that's fine.
    }
    setTheme(next);

    // Micro-bounce via Motion One. Lazy-import so the bundle stays lean and
    // SSR remains happy. Skip when reduced-motion is on.
    if (btnRef.current && !prefersReducedMotion()) {
      try {
        const { animate } = await import("motion");
        animate(
          btnRef.current,
          { scale: [1, 0.88, 1.05, 1] },
          { duration: 0.42, ease: [0.32, 0.72, 0, 1] },
        );
      } catch {
        // Animation is decorative; never break the toggle.
      }
    }
  };

  const isDark = theme === "dark";
  return (
    <button
      ref={btnRef}
      type="button"
      onClick={toggle}
      aria-pressed={isDark}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className="flex-none w-11 h-11 inline-flex items-center justify-center rounded-full cursor-pointer"
      style={{
        background: "oklch(99% 0 0 / 0.08)",
        color: "var(--header-fg)",
        border: "1px solid oklch(99% 0 0 / 0.14)",
        transition: "background 180ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
    >
      <span aria-hidden="true">{isDark ? "☀" : "☾"}</span>
    </button>
  );
}
