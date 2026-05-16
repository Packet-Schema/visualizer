"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { Field, Packet } from "@/lib/types";

type Props = {
  packet: Packet;
  containerRef: RefObject<HTMLElement | null>;
  visible: boolean;
};

type EdgeKind = "controls" | "drives";

type Edge = {
  id: string;
  /** Source field id (driver / controller). */
  fromFieldId: string;
  /** Target field id (driven / variable). */
  toFieldId: string;
  kind: EdgeKind;
};

type RenderedEdge = Edge & {
  /** Source point in container-local coords. */
  sx: number;
  sy: number;
  /** Target point in container-local coords. */
  tx: number;
  ty: number;
  /** Quadratic Bezier control point. */
  cx: number;
  cy: number;
  /** Path d attribute. */
  d: string;
};

/**
 * Walk the packet definition and emit dependency edges:
 *   - controlsLength controller -> the variable field whose lengthFrom matches.
 *   - tlv.drivesController on a TLV-bearing field -> reverse edge from the
 *     TLV (variable) field to the controller field. Rendered dashed.
 */
function computeEdges(packet: Packet): Edge[] {
  const edges: Edge[] = [];
  // Index controllers by the key they write into state.
  const controllerByKey = new Map<string, Field>();
  for (const f of packet.fields) {
    if (f.controlsLength) controllerByKey.set(f.controlsLength, f);
  }
  // Forward edges: controller -> variable field.
  for (const f of packet.fields) {
    if (f.variable && f.lengthFrom) {
      const ctrl = controllerByKey.get(f.lengthFrom);
      if (ctrl && ctrl.id !== f.id) {
        edges.push({
          id: `controls:${ctrl.id}->${f.id}`,
          fromFieldId: ctrl.id,
          toFieldId: f.id,
          kind: "controls",
        });
      }
    }
  }
  // Reverse edges: TLV field with drivesController -> back to the controller.
  for (const f of packet.fields) {
    const driven = f.tlv?.drivesController;
    if (!driven) continue;
    const ctrl = controllerByKey.get(driven);
    if (ctrl && ctrl.id !== f.id) {
      edges.push({
        id: `drives:${f.id}->${ctrl.id}`,
        fromFieldId: f.id,
        toFieldId: ctrl.id,
        kind: "drives",
      });
    }
  }
  return edges;
}

/**
 * Locate the rendered cell for a field id. TLV-bearing fields expand into
 * virtual cells like `<id>#0`, so when the literal id is not present we fall
 * back to the first virtual segment.
 */
function findCellElement(
  root: HTMLElement,
  fieldId: string,
): HTMLElement | null {
  const direct = root.querySelector<HTMLElement>(
    `[data-field-id="${CSS.escape(fieldId)}"]`,
  );
  if (direct) return direct;
  // TLV expansion: look for the first segment whose id starts with `${id}#`.
  return root.querySelector<HTMLElement>(
    `[data-field-id^="${CSS.escape(fieldId)}#"]`,
  );
}

export default function DependencyOverlay({
  packet,
  containerRef,
  visible,
}: Props) {
  const edges = useMemo(() => computeEdges(packet), [packet]);

  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [rendered, setRendered] = useState<RenderedEdge[]>([]);
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);

  const recompute = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    // Cover the full scrollable area, not just the visible viewport, so
    // arrows that go beyond the horizontal scroll edge still render.
    setSize({
      w: Math.max(container.clientWidth, container.scrollWidth),
      h: Math.max(container.clientHeight, container.scrollHeight),
    });

    const next: RenderedEdge[] = [];
    for (const edge of edges) {
      const fromEl = findCellElement(container, edge.fromFieldId);
      const toEl = findCellElement(container, edge.toFieldId);
      if (!fromEl || !toEl) continue;
      const fr = fromEl.getBoundingClientRect();
      const tr = toEl.getBoundingClientRect();

      // Anchor at the cell's top-center so multiple arrows in the same row
      // don't overlap badly. Convert to container-local coordinates accounting
      // for any horizontal scroll inside the diagram-shell.
      const sx = fr.left - containerRect.left + fr.width / 2 + container.scrollLeft;
      const sy = fr.top - containerRect.top + fr.height / 2 + container.scrollTop;
      const tx = tr.left - containerRect.left + tr.width / 2 + container.scrollLeft;
      const ty = tr.top - containerRect.top + tr.height / 2 + container.scrollTop;

      // Quadratic Bezier control point: arc above the midpoint by an amount
      // proportional to the horizontal distance, clamped so vertical neighbors
      // still get a visible curve.
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      const dx = tx - sx;
      const dy = ty - sy;
      const dist = Math.hypot(dx, dy);
      const lift = Math.min(120, Math.max(40, dist * 0.35));
      // Perpendicular (left-hand normal) direction so the arc bows upward
      // when going right, downward when going left -- consistent visual.
      const len = dist || 1;
      const nx = -dy / len;
      const ny = dx / len;
      // Forward arrows bow up (negative-y bias); reverse arrows bow down so
      // they read as "feedback" loops rather than overlapping the forward edge.
      const sign = edge.kind === "controls" ? -1 : 1;
      const cx = mx + nx * lift * sign;
      const cy = my + ny * lift * sign;

      const d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`;
      next.push({ ...edge, sx, sy, tx, ty, cx, cy, d });
    }
    setRendered(next);
  }, [containerRef, edges]);

  const scheduleRecompute = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      recompute();
    });
  }, [recompute]);

  // Recompute synchronously after layout when packet/visibility changes so
  // arrows are correct on the very first paint.
  useLayoutEffect(() => {
    if (!visible) return;
    recompute();
  }, [visible, recompute]);

  // ResizeObserver on the diagram container catches slider drags (which
  // mutate cell widths via grid spans) and viewport resizes uniformly. We
  // also listen on window scroll/resize for completeness.
  useEffect(() => {
    if (!visible) return;
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver(scheduleRecompute);
    ro.observe(container);
    // Observe each field cell too -- a cell that grows from 0 to N bits
    // (Options after the IHL slider moves past 5) would otherwise not trigger
    // a container resize at all.
    const cells = container.querySelectorAll<HTMLElement>("[data-field-id]");
    cells.forEach((c) => ro.observe(c));

    const onWin = () => scheduleRecompute();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    container.addEventListener("scroll", onWin);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
      container.removeEventListener("scroll", onWin);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [visible, containerRef, scheduleRecompute, edges]);

  // Highlight endpoints by tagging the matching cell elements with marker
  // classes. We collect every node whose data-field-id equals the field id or
  // begins with `<id>#` (TLV virtual segments) so multi-segment fields light
  // up uniformly.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function collect(fieldId: string): HTMLElement[] {
      if (!container) return [];
      const exact = Array.from(
        container.querySelectorAll<HTMLElement>(
          `[data-field-id="${CSS.escape(fieldId)}"]`,
        ),
      );
      const virtual = Array.from(
        container.querySelectorAll<HTMLElement>(
          `[data-field-id^="${CSS.escape(fieldId)}#"]`,
        ),
      );
      return [...exact, ...virtual];
    }

    if (!hoverEdgeId) return;
    const edge = rendered.find((e) => e.id === hoverEdgeId);
    if (!edge) return;
    const sources = collect(edge.fromFieldId);
    const targets = collect(edge.toFieldId);
    sources.forEach((el) => el.classList.add("dep-endpoint-source"));
    targets.forEach((el) => el.classList.add("dep-endpoint-target"));
    return () => {
      sources.forEach((el) => el.classList.remove("dep-endpoint-source"));
      targets.forEach((el) => el.classList.remove("dep-endpoint-target"));
    };
  }, [hoverEdgeId, rendered, containerRef]);

  if (!visible) return null;

  return (
    <svg
      className="dependency-overlay"
      width={size.w}
      height={size.h}
      viewBox={`0 0 ${size.w} ${size.h}`}
      aria-hidden="true"
      role="presentation"
    >
      <defs>
        <marker
          id="dep-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" opacity="0.55" />
        </marker>
      </defs>
      {rendered.map((edge) => {
        const isHover = hoverEdgeId === edge.id;
        return (
          <g key={edge.id}>
            {/* Wide invisible hit path for easier hovering. */}
            <path
              d={edge.d}
              fill="none"
              stroke="transparent"
              strokeWidth={14}
              style={{ pointerEvents: "auto", cursor: "help" }}
              onMouseEnter={() => setHoverEdgeId(edge.id)}
              onMouseLeave={() =>
                setHoverEdgeId((cur) => (cur === edge.id ? null : cur))
              }
            />
            <path
              d={edge.d}
              fill="none"
              stroke="var(--accent)"
              strokeOpacity={isHover ? 0.9 : 0.4}
              strokeWidth={isHover ? 2 : 1.5}
              strokeDasharray={edge.kind === "drives" ? "5 4" : undefined}
              markerEnd="url(#dep-arrow)"
              style={{ transition: "stroke-opacity 120ms" }}
            />
          </g>
        );
      })}
    </svg>
  );
}
