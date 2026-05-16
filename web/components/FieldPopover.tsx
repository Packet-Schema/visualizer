"use client";

import { useEffect, useRef, useState } from "react";

import { CATEGORY_LABELS } from "@/lib/constants";
import { enrichDescriptionHtml } from "@/lib/enrich";
import type {
  CategoryToken,
  ControllerState,
  Field,
  Packet,
  SubField,
} from "@/lib/psml/renderer";

type Props = {
  packet: Packet;
  controllers: ControllerState;
  selectedFieldId: string;
  anchorRect: DOMRect;
  onDismiss: () => void;
};

// Width budget for the popover. Keep in sync with the maxWidth below.
const POPOVER_WIDTH = 320;
const POPOVER_OFFSET = 10;

type Resolved =
  | { kind: "field"; field: Field; bits: number }
  | { kind: "subfield"; parent: Field; sub: SubField };

function resolve(
  packet: Packet,
  controllers: ControllerState,
  selectedFieldId: string,
): Resolved | null {
  if (selectedFieldId.includes(":")) {
    const [parentId, subId] = selectedFieldId.split(":");
    const parent = packet.fields.find((f) => f.id === parentId);
    const sub = parent?.subfields?.find((s) => s.id === subId);
    if (!parent || !sub) return null;
    return { kind: "subfield", parent, sub };
  }
  const field = packet.fields.find((f) => f.id === selectedFieldId);
  if (!field) return null;
  const bits =
    field.variable && field.toBits && field.lengthFrom
      ? field.toBits(controllers[field.lengthFrom] ?? 0)
      : (field.bits ?? 0);
  return { kind: "field", field, bits };
}

export default function FieldPopover({
  packet,
  controllers,
  selectedFieldId,
  anchorRect,
  onDismiss,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<"below" | "above">("below");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const spaceAbove = anchorRect.top;
    // Roughly estimate height; switch to "above" only if there's clearly more
    // space there. The arrow direction follows placement.
    if (spaceBelow < 200 && spaceAbove > spaceBelow) {
      setPlacement("above");
    } else {
      setPlacement("below");
    }
  }, [anchorRect]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    }
    function onPointer(e: MouseEvent) {
      const node = ref.current;
      if (!node) return;
      if (e.target instanceof Node && node.contains(e.target)) return;
      onDismiss();
    }
    window.addEventListener("keydown", onKey);
    // Capture-phase so we dismiss before any internal handlers run.
    window.addEventListener("mousedown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer, true);
    };
  }, [onDismiss]);

  // Spring entry via Motion One. Lazy-import so SSR + bundle stay small.
  // Respects prefers-reduced-motion.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    let cancelled = false;
    (async () => {
      try {
        const { animate } = await import("motion");
        if (cancelled || !ref.current) return;
        animate(
          ref.current,
          { opacity: [0, 1], scale: [0.96, 1] },
          { duration: 0.22, ease: [0.32, 0.72, 0, 1] },
        );
      } catch {
        // ignore — popover is still visible without the bounce
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resolved = resolve(packet, controllers, selectedFieldId);
  if (!resolved) return null;

  // Position: horizontally center over the anchor; vertically above or below.
  const centerX = anchorRect.left + anchorRect.width / 2;
  const left = Math.min(
    Math.max(8, centerX - POPOVER_WIDTH / 2),
    typeof window !== "undefined"
      ? window.innerWidth - POPOVER_WIDTH - 8
      : centerX,
  );
  const top =
    placement === "below"
      ? anchorRect.bottom + POPOVER_OFFSET
      : Math.max(8, anchorRect.top - POPOVER_OFFSET - 220);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Field detail"
      className="field-popover"
      style={{
        position: "fixed",
        top,
        left,
        width: POPOVER_WIDTH,
        zIndex: 80,
      }}
    >
      <span
        className={`field-popover-arrow ${placement === "above" ? "arrow-down" : "arrow-up"}`}
        aria-hidden="true"
        style={{ left: Math.max(12, Math.min(POPOVER_WIDTH - 12, centerX - left)) }}
      />
      {resolved.kind === "field" ? (
        <FieldBody field={resolved.field} bits={resolved.bits} />
      ) : (
        <SubfieldBody parent={resolved.parent} sub={resolved.sub} />
      )}
    </div>
  );
}

function FieldBody({ field, bits }: { field: Field; bits: number }) {
  const sizeStr = `${bits} bits${Number.isInteger(bits / 8) ? ` (${bits / 8} bytes)` : ""}`;
  return (
    <div>
      <h3 className="field-popover-title">{field.name}</h3>
      <dl className="field-popover-list">
        <dt>Size</dt>
        <dd>
          <span className="font-mono tabular-nums">{sizeStr}</span>
          {field.variable ? (
            <em className="not-italic ml-1 text-[var(--fg-muted)]">
              (variable)
            </em>
          ) : null}
        </dd>
        {field.category ? (
          <>
            <dt>Category</dt>
            <dd>
              {CATEGORY_LABELS[field.category as CategoryToken] ||
                field.category}
            </dd>
          </>
        ) : null}
        {field.description ? (
          <>
            <dt>Description</dt>
            <dd
              dangerouslySetInnerHTML={{
                __html: enrichDescriptionHtml(field.description),
              }}
            />
          </>
        ) : null}
      </dl>
    </div>
  );
}

function SubfieldBody({ parent, sub }: { parent: Field; sub: SubField }) {
  return (
    <div>
      <h3 className="field-popover-title">
        {sub.name}{" "}
        <span className="field-popover-subnote">
          (subfield of {parent.name})
        </span>
      </h3>
      <dl className="field-popover-list">
        <dt>Size</dt>
        <dd>
          <span className="font-mono tabular-nums">
            {sub.bits} bit{sub.bits === 1 ? "" : "s"}
          </span>
        </dd>
        <dt>Parent</dt>
        <dd>{parent.name}</dd>
        {sub.description ? (
          <>
            <dt>Description</dt>
            <dd
              dangerouslySetInnerHTML={{
                __html: enrichDescriptionHtml(sub.description),
              }}
            />
          </>
        ) : null}
      </dl>
    </div>
  );
}
