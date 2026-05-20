"use client";

import { useEffect, useRef, useState } from "react";

import { THEME_STORAGE_KEY } from "@/lib/constants";

type Theme = "light" | "dark";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  // Toggling this attribute (instead of imperatively running an animation)
  // hands the bounce to CSS keyframes. Removing it on `animationend` lets
  // the same click animate again. We additionally gate the *entry* into
  // bouncing state on `prefers-reduced-motion` so users with that setting
  // see no movement at all (the global CSS override only shortens the
  // duration; this skips the bounce class entirely).
  const [bouncing, setBouncing] = useState(false);
  // Track the in-flight RAF so unmount (route change, conditional
  // render) can cancel it before `setBouncing(true)` fires against a
  // gone component. Copilot flagged this as an "update on unmounted
  // component" hazard on the bounce-retrigger path below.
  const bounceRafRef = useRef<number | null>(null);

  useEffect(() => {
    const current = document.documentElement.getAttribute(
      "data-theme",
    ) as Theme | null;
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  useEffect(() => {
    return () => {
      if (bounceRafRef.current !== null) {
        cancelAnimationFrame(bounceRafRef.current);
        bounceRafRef.current = null;
      }
    };
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
    // Respect the user's motion preference at the source: don't enter
    // the bouncing state at all if reduce-motion is on. globals.css does
    // shorten the animation duration globally, but skipping the state
    // machine entirely is a stronger guarantee for WCAG 2.3.3 and also
    // saves an `animationend` round-trip when no motion will play.
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;
    // Retrigger the bounce on rapid successive clicks: a plain
    // `setBouncing(true)` while already `true` keeps `data-bounce` at
    // "true" with no DOM change, so CSS doesn't restart the keyframe.
    // Flip to false first (which removes the attribute) and back to
    // true on the next paint so the animation always replays — without
    // this Copilot-flagged edge case, double-clicking the toggle
    // animates only the first click.
    setBouncing(false);
    // Cancel any pending RAF from a previous toggle so a rapid double
    // click doesn't queue two competing `setBouncing(true)` calls and
    // so unmount cleanup has a single id to cancel.
    if (bounceRafRef.current !== null) {
      cancelAnimationFrame(bounceRafRef.current);
    }
    bounceRafRef.current = requestAnimationFrame(() => {
      bounceRafRef.current = null;
      setBouncing(true);
    });
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
