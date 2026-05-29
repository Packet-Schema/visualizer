"use client";

import { useMemo } from "react";

import DiagramRuler from "@/components/diagram/DiagramRuler";
import HybridDiagram from "@/components/diagram/HybridDiagram";
import Legend from "@/components/diagram/Legend";
import { packetCategories } from "@/lib/psdl/renderer-helpers";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { DEFAULT_BYTE_ORDER } from "@/lib/constants";
import type { ResolvedLayout } from "@/lib/psdl/renderer";
import type { PsdlPacket } from "@/lib/psdl/types";

type Props = {
  packet: PsdlPacket;
  layout: ResolvedLayout;
};

const noop = () => {};

/**
 * SourceEditor 右ペイン — PsdlPacket をそのまま静的 preview として描画する。
 *
 * クリック / hover の編集動線は持たない。 PSDL を直書きしているユーザーは
 * テキスト側で field を編集するので、diagram は read-only な「見える鏡」に
 * 徹する方が動線が混ざらない。
 *
 * パース / layout 失敗は SourceEditor 側で受けているので、このコンポーネ
 * ントが受け取る `packet` / `layout` は必ず妥当である前提。
 */
export default function PreviewPanel({ packet, layout }: Props) {
  const rendererPacket = useMemo(() => psdlToRenderer(packet), [packet]);
  const categories = useMemo(
    () => packetCategories(rendererPacket),
    [rendererPacket],
  );

  const bytes = layout.totalBits / 8;
  const byteStr = Number.isInteger(bytes)
    ? `${bytes} bytes`
    : `${layout.totalBits} bits`;

  return (
    <div className="flex flex-col gap-3 h-full overflow-auto">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold m-0 truncate">{packet.name}</h2>
        <span className="text-xs text-fg-faint whitespace-nowrap">
          {layout.totalBits} bits ({byteStr})
        </span>
      </div>
      {packet.description ? (
        <p className="text-xs m-0 text-fg-muted">{packet.description}</p>
      ) : null}
      <p className="text-xs m-0 italic flex items-center gap-1.5 text-fg-faint">
        <span className="not-italic font-bold text-accent" aria-hidden="true">
          ↦
        </span>
        {packet.byteOrder || DEFAULT_BYTE_ORDER}
      </p>
      <div
        className="rounded-[10px] border p-3.5 overflow-x-auto"
        style={{
          background: "var(--bg-elevated)",
          borderColor: "var(--border)",
          boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
        }}
      >
        <DiagramRuler rowBits={rendererPacket.rowBits} />
        <HybridDiagram
          packet={rendererPacket}
          layout={layout}
          selectedFieldId={null}
          onFieldClick={noop}
          onSubfieldClick={noop}
        />
      </div>
      <Legend categories={categories} />
    </div>
  );
}
