import { useEffect, useId, useRef, useState } from "react";

import { CATEGORY_LABELS } from "@/lib/constants";
import { EnrichedText } from "@/components/common/EnrichedText";
import type {
  CategoryToken,
  ControllerState,
  Field,
  Packet,
  SubField,
} from "@/lib/psdl/renderer";
import { parseTlvCellId } from "@/components/field-details/tlv-cell-id";

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
  // TLV instance cells (e.g. `options__inst_0` / `options__inst_0__type`)
  // and the trailing remaining placeholder (`options__remaining`) are
  // synthetic — they don't live in `packet.fields`. Resolve them back to
  // the parent TLV's catalog so the popover still has something to show.
  const role = parseTlvCellId(selectedFieldId);
  if (role.kind === "instance") {
    const parent = packet.fields.find(
      (f) =>
        f.id === role.baseId && f.tlv?.instances[role.instanceIndex] != null,
    );
    if (parent?.tlv) {
      const inst = parent.tlv.instances[role.instanceIndex];
      const entry = parent.tlv.catalog.find((e) => e.kind === inst.kind);
      const bits = (entry?.fields ?? []).reduce((a, f) => a + f.bits, 0);
      const variantField: Field = {
        id: `${parent.id}__inst_${role.instanceIndex}`,
        name: entry?.name ?? `Record #${role.instanceIndex}`,
        bits,
        category: parent.category,
        description:
          entry?.description ??
          `One ${parent.name} record. Click to change variant or extras.`,
      };
      return { kind: "field", field: variantField, bits };
    }
  }
  if (role.kind === "leaf") {
    const parent = packet.fields.find(
      (f) =>
        f.id === role.baseId && f.tlv?.instances[role.instanceIndex] != null,
    );
    if (parent?.tlv) {
      const inst = parent.tlv.instances[role.instanceIndex];
      const entry = parent.tlv.catalog.find((e) => e.kind === inst.kind);
      const leaf = entry?.fields?.find((f) => f.id === role.leafId);
      if (leaf) {
        const parentName = entry?.name ?? parent.name;
        const variantParent: Field = {
          id: `${parent.id}__inst_${role.instanceIndex}`,
          name: parentName,
          bits: 0,
        };
        const sub: SubField = {
          id: leaf.id,
          name: leaf.name,
          bits: leaf.bits,
          description: leaf.description,
        };
        return { kind: "subfield", parent: variantParent, sub };
      }
    }
  }
  if (role.kind === "remaining") {
    const parent = packet.fields.find((f) => f.id === role.baseId && f.tlv);
    if (parent) {
      const placeholder: Field = {
        id: selectedFieldId,
        name: `${parent.name} remaining`,
        bits: 0,
        description:
          "Unused space in the slot reserved by the upstream length controller. Append more records to fill it.",
      };
      return { kind: "field", field: placeholder, bits: 0 };
    }
  }
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

  // Entry animation is handled in CSS via `@starting-style` (see
  // app/styles/popover.css). That keeps the bundle free of an animation
  // runtime and respects prefers-reduced-motion through the global rule
  // in app/globals.css.

  // `useId()` must run on every render to satisfy the Rules of Hooks —
  // earlier the call was placed after the `if (!resolved) return null`
  // early-return, so a frame where `resolved === null` skipped the
  // hook, and the next frame with `resolved` set added it back,
  // tripping React's "Rendered fewer hooks than expected" guard
  // (Codex P1). Hoist it above any conditional return.
  const titleId = useId();

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

  // A non-modal dialog: it floats over the diagram but doesn't trap focus or
  // block the backdrop, so we set `aria-modal="false"` to be explicit. The
  // visible heading provides the label.
  //
  // `titleId` was hoisted above the early-return so the hook order stays
  // stable across `resolved === null` frames; PSDL ids may carry
  // spaces / colons (e.g. nested `flags:df`) that produce invalid HTML
  // id attributes and silently break the `aria-labelledby` link, so we
  // rely on React's `useId` for a DOM-safe, unique value.
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
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
        style={{
          left: Math.max(12, Math.min(POPOVER_WIDTH - 12, centerX - left)),
        }}
      />
      {resolved.kind === "field" ? (
        <FieldBody
          field={resolved.field}
          bits={resolved.bits}
          titleId={titleId}
        />
      ) : (
        <SubfieldBody
          parent={resolved.parent}
          sub={resolved.sub}
          titleId={titleId}
        />
      )}
    </div>
  );
}

function FieldBody({
  field,
  bits,
  titleId,
}: {
  field: Field;
  bits: number;
  titleId: string;
}) {
  const sizeStr = `${bits} bits${Number.isInteger(bits / 8) ? ` (${bits / 8} bytes)` : ""}`;
  return (
    <div>
      <h3 id={titleId} className="field-popover-title">
        {field.name}
      </h3>
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
            <dd>
              <EnrichedText text={field.description} />
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function SubfieldBody({
  parent,
  sub,
  titleId,
}: {
  parent: Field;
  sub: SubField;
  titleId: string;
}) {
  return (
    <div>
      <h3 id={titleId} className="field-popover-title">
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
            <dd>
              <EnrichedText text={sub.description} />
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
