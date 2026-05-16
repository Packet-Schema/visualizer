"use client";

// Lightweight onboarding tour ported from /tour.js.
//
// Render: a fixed overlay div with a "spotlight" cutout. The cutout is a
// positioned <div> whose `box-shadow` extends to the viewport edges to
// dim everything except the spotlight area. Tooltip floats next to the
// spotlight with Next / Skip buttons. Esc closes.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const SEEN_KEY = "packet-view-tour-seen";

export type TourStep = {
  title: string;
  body: string;
  target?: () => Element | null;
  placement?: "top" | "bottom";
};

type Rect = { left: number; top: number; width: number; height: number };

type Props = {
  steps: TourStep[];
  onClose: () => void;
};

export function hasSeenTour(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTourSeen(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

export default function OnboardingTour({ steps, onClose }: Props) {
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState({
    w: typeof window === "undefined" ? 1024 : window.innerWidth,
    h: typeof window === "undefined" ? 768 : window.innerHeight,
  });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const nextBtnRef = useRef<HTMLButtonElement>(null);

  const finish = useCallback(() => {
    markTourSeen();
    onClose();
  }, [onClose]);

  const advance = useCallback(() => {
    setIdx((i) => {
      if (i >= steps.length - 1) {
        finish();
        return i;
      }
      return i + 1;
    });
  }, [steps.length, finish]);

  const computeRect = useCallback(() => {
    const step = steps[idx];
    if (!step || typeof step.target !== "function") {
      setRect(null);
      return;
    }
    const el = step.target();
    if (!el || typeof el.getBoundingClientRect !== "function") {
      setRect(null);
      return;
    }
    try {
      el.scrollIntoView({ block: "center", behavior: "auto" });
    } catch {
      /* ignore */
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      setRect(null);
      return;
    }
    setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
  }, [idx, steps]);

  useLayoutEffect(() => {
    computeRect();
  }, [computeRect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      } else if (e.key === "Enter") {
        e.preventDefault();
        advance();
      }
    };
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      computeRect();
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", computeRect, true);
    // Move focus into the tour.
    setTimeout(() => {
      try {
        nextBtnRef.current?.focus();
      } catch {
        /* ignore */
      }
    }, 0);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", computeRect, true);
    };
  }, [advance, finish, computeRect]);

  const step = steps[idx];
  if (!step) return null;

  const pad = 8;
  const spotlightStyle: React.CSSProperties = rect
    ? {
        position: "fixed",
        left: Math.max(4, rect.left - pad),
        top: Math.max(4, rect.top - pad),
        width: Math.min(viewport.w - Math.max(4, rect.left - pad) - 4, rect.width + pad * 2),
        height: Math.min(viewport.h - Math.max(4, rect.top - pad) - 4, rect.height + pad * 2),
        borderRadius: 8,
        boxShadow: "0 0 0 9999px rgba(15, 22, 50, 0.55)",
        pointerEvents: "none",
        zIndex: 100,
      }
    : { display: "none" };

  const ttW = Math.min(360, viewport.w - 32);
  // Use a sensible default height before the tooltip mounts.
  const ttH = tooltipRef.current?.offsetHeight || 180;
  let tooltipStyle: React.CSSProperties;
  if (rect) {
    const sy = Math.max(4, rect.top - pad);
    const sh = Math.min(viewport.h - sy - 4, rect.height + pad * 2);
    const place = step.placement || (viewport.h - rect.top - rect.height > rect.top ? "bottom" : "top");
    const left = Math.min(
      viewport.w - ttW - 12,
      Math.max(12, rect.left + rect.width / 2 - ttW / 2),
    );
    const top =
      place === "top"
        ? Math.max(12, sy - ttH - 12)
        : Math.min(viewport.h - ttH - 12, sy + sh + 12);
    tooltipStyle = {
      position: "fixed",
      left,
      top,
      width: ttW,
      zIndex: 101,
    };
  } else {
    tooltipStyle = {
      position: "fixed",
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      width: Math.min(420, viewport.w - 32),
      zIndex: 101,
    };
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Onboarding tour"
      onClick={(e) => {
        if (e.target === e.currentTarget) finish();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99,
        background: rect ? "transparent" : "rgba(15,22,50,0.55)",
      }}
    >
      <div aria-hidden="true" style={spotlightStyle} />
      <div
        ref={tooltipRef}
        role="document"
        style={{
          ...tooltipStyle,
          background: "var(--bg-elevated)",
          color: "var(--fg)",
          border: "1px solid var(--border-strong)",
          borderRadius: 10,
          padding: "14px 16px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
        }}
      >
        <h3
          className="m-0 mb-1.5 text-[15px] font-semibold"
          style={{ color: "var(--fg)" }}
        >
          {step.title}
        </h3>
        <p className="m-0 text-[13px]" style={{ color: "var(--fg-muted)" }}>
          {step.body}
        </p>
        <div
          className="mt-2 text-[11px] uppercase tracking-wider"
          style={{ color: "var(--fg-faint)" }}
        >
          Step {idx + 1} of {steps.length}
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={finish}
            className="text-[12px] px-3 py-1.5 rounded border"
            style={{
              borderColor: "var(--border-strong)",
              background: "var(--bg-base)",
              color: "var(--fg)",
            }}
          >
            Skip
          </button>
          <button
            ref={nextBtnRef}
            type="button"
            onClick={advance}
            className="text-[12px] px-3 py-1.5 rounded border font-semibold"
            style={{
              borderColor: "var(--accent)",
              background: "var(--accent)",
              color: "var(--accent-fg, #fff)",
            }}
          >
            {idx === steps.length - 1 ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
