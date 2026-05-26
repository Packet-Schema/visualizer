import { LAYOUT } from "@/lib/diagram-export";

/**
 * Lock icon SVG for encrypted cells.
 * Used by both HybridDiagram (interactive) and StaticDiagram (static export).
 */
export function LockIcon({
  size,
  color = "currentColor",
  className,
  ariaHidden,
}: {
  size: number;
  color?: string;
  className?: string;
  ariaHidden?: boolean;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${LAYOUT.badgeSvgViewBox} ${LAYOUT.badgeSvgViewBox}`}
      fill="none"
      stroke={color}
      strokeWidth={LAYOUT.strokeWidthBadge}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={ariaHidden ? "true" : undefined}
      focusable="false"
    >
      <rect
        x={LAYOUT.badgeSvgRectX}
        y={LAYOUT.badgeSvgRectY}
        width={LAYOUT.badgeSvgRectWidth}
        height={LAYOUT.badgeSvgRectHeight}
        rx={LAYOUT.badgeSvgRectRadius}
      />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/**
 * Overridable marker gradient bar shown at the bottom of cells with runtime overrides.
 */
export function OverridableMarker({
  x,
  y,
  width,
  height,
  markerAccent,
  markerAccentSoft,
  isSubfield = false,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  markerAccent: string;
  markerAccentSoft: string;
  isSubfield?: boolean;
}) {
  if (isSubfield) {
    const markerX = x + 4;
    const markerY = y + height - 3;
    const markerW = Math.max(width - 8, 1);
    return (
      <div
        style={{
          position: "absolute",
          left: markerX,
          top: markerY,
          width: markerW,
          height: 1.5,
          borderRadius: 1.5,
          background: `linear-gradient(90deg, ${markerAccentSoft} 0%, ${markerAccent} 50%, ${markerAccentSoft} 100%)`,
          pointerEvents: "none",
        }}
      />
    );
  } else {
    const markerX = x + 7;
    const markerY = y + height - 5.5;
    const markerW = Math.max(width - 14, 1);
    return (
      <div
        style={{
          position: "absolute",
          left: markerX,
          top: markerY,
          width: markerW,
          height: 2.5,
          borderRadius: 2,
          background: `linear-gradient(90deg, ${markerAccentSoft} 0%, ${markerAccent} 50%, ${markerAccentSoft} 100%)`,
          pointerEvents: "none",
          zIndex: 2,
        }}
      />
    );
  }
}
