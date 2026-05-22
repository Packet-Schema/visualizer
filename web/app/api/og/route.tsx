import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

import {
  DEFAULT_THEME,
  LAYOUT,
  fieldFill,
  rowsFor,
  textForCell,
} from "@/lib/diagram-export";
import type { DiagramExportTheme } from "@/lib/diagram-export";
import { PRESETS } from "@/lib/psml/presets";
import { resolveLayout } from "@/lib/psml/layout";
import { initialState } from "@/lib/psml/renderer-helpers";
import { initialEnv } from "@/lib/psml/normalize";
import { psmlToRenderer } from "@/lib/psml/psml-to-renderer";
import { parseShareParams } from "@/lib/share-url";
import type { Cell, Packet, ResolvedLayout } from "@/lib/psml/renderer";

const FALLBACK_PRESET_KEY = "ipv4";
const MAX_LAYOUT_RETRY = 32;
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const OG_MARGIN = 60;
const FONT_NAME = "Noto Sans";

function buildOgElement(
  packet: Packet,
  layout: ResolvedLayout,
  theme: DiagramExportTheme,
): React.ReactElement {
  const rows = rowsFor(layout);
  const packetFieldsById = new Map(
    packet.fields.map((field) => [field.id, field]),
  );

  const availableW = OG_WIDTH - OG_MARGIN * 2;
  const availableH = OG_HEIGHT - OG_MARGIN * 2;

  // X: stretch bit width to fill available width exactly
  const bitWidth = (availableW - LAYOUT.padding * 2) / packet.rowBits;

  // Y: scale all vertical values to fill available height exactly
  const naturalH =
    LAYOUT.padding * 2 +
    LAYOUT.rulerHeight +
    LAYOUT.rulerGap +
    rows.length * LAYOUT.rowHeight +
    Math.max(rows.length - 1, 0) * LAYOUT.rowGap;
  const yScale = availableH / naturalH;

  const scaledPaddingY = LAYOUT.padding * yScale;
  const scaledRulerHeight = LAYOUT.rulerHeight * yScale;
  const scaledRulerGap = LAYOUT.rulerGap * yScale;
  const scaledRowHeight = LAYOUT.rowHeight * yScale;
  const scaledRowGap = LAYOUT.rowGap * yScale;
  const scaledCellInset = LAYOUT.cellInset * yScale;

  const scaledRowY = (row: number) =>
    scaledPaddingY +
    scaledRulerHeight +
    scaledRulerGap +
    row * (scaledRowHeight + scaledRowGap);

  // SVG layer: ruler ticks
  const rulerBottom = scaledPaddingY + scaledRulerHeight;
  const rulerLines = Array.from(
    { length: packet.rowBits },
    (_, bit): React.ReactElement => {
      const x = LAYOUT.padding + bit * bitWidth;
      const major = bit % 8 === 0;
      const tickHeight = (major ? 10 : 6) * yScale;
      return (
        <line
          key={`tick-${bit}`}
          x1={x}
          y1={rulerBottom - tickHeight}
          x2={x}
          y2={rulerBottom}
          stroke={theme.rulerTick}
          strokeWidth={1}
          opacity={major ? 1 : 0.6}
        />
      );
    },
  );

  // SVG layer: row bands and cell rects
  const shapeLayers = rows.flatMap(
    (cells: Cell[], rowIndex: number): React.ReactElement[] => {
      const y = scaledRowY(rowIndex);
      const bandFill = rowIndex % 2 === 0 ? theme.rowEven : theme.rowOdd;

      const band = (
        <rect
          key={`band-${rowIndex}`}
          x={LAYOUT.padding}
          y={y}
          width={packet.rowBits * bitWidth}
          height={scaledRowHeight}
          rx={8}
          fill={bandFill}
        />
      );

      const cellRects = cells.map((cell: Cell): React.ReactElement => {
        const x = LAYOUT.padding + cell.startBit * bitWidth + LAYOUT.cellInset;
        const cy = y + scaledCellInset;
        const cw =
          (cell.endBit - cell.startBit + 1) * bitWidth - LAYOUT.cellInset * 2;
        const ch = scaledRowHeight - scaledCellInset * 2;
        const exportField = packetFieldsById.get(cell.field.id) ?? cell.field;
        const fill = fieldFill(exportField, theme);
        const strokeColor = cell.encryptedParentId
          ? theme.accent
          : theme.fieldStroke;

        return (
          <rect
            key={`rect-${cell.row}-${cell.segmentIndex}-${cell.field.id}`}
            x={x}
            y={cy}
            width={Math.max(cw, 1)}
            height={ch}
            rx={10}
            fill={fill}
            stroke={strokeColor}
            strokeWidth={1}
            strokeDasharray={cell.encrypted ? "5 3" : undefined}
          />
        );
      });

      return [band, ...cellRects];
    },
  );

  // HTML text layer: ruler labels
  const rulerLabels = Array.from(
    { length: packet.rowBits },
    (_, bit): React.ReactElement | null => {
      if (bit % 4 !== 0) return null;
      const x = LAYOUT.padding + bit * bitWidth;
      return (
        <div
          key={`rlabel-${bit}`}
          style={{
            display: "flex",
            position: "absolute",
            left: x - 6,
            top: scaledPaddingY,
            fontSize: 10,
            fontFamily: FONT_NAME,
            color: theme.rulerLabel,
            lineHeight: "1",
          }}
        >
          {bit}
        </div>
      );
    },
  ).filter((el): el is React.ReactElement => el !== null);

  // HTML text layer: cell labels
  const cellLabels = rows.flatMap((cells: Cell[]): React.ReactElement[] =>
    cells.map((cell: Cell): React.ReactElement => {
      const x = LAYOUT.padding + cell.startBit * bitWidth + LAYOUT.cellInset;
      const cy = scaledRowY(cell.row) + scaledCellInset;
      const { title, subtitle } = textForCell(cell);
      const titleColor = cell.isFirst
        ? theme.fieldLabel
        : theme.fieldContinuation;

      return (
        <div
          key={`label-${cell.row}-${cell.segmentIndex}-${cell.field.id}`}
          style={{
            position: "absolute",
            left: x + 8,
            top: cy + 10,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              fontFamily: FONT_NAME,
              color: titleColor,
              lineHeight: "1.2",
            }}
          >
            {title}
          </span>
          <span
            style={{
              fontSize: 10,
              fontFamily: FONT_NAME,
              color: theme.fieldSublabel,
              marginTop: 4,
              lineHeight: "1",
            }}
          >
            {subtitle}
          </span>
        </div>
      );
    }),
  );

  return (
    <div
      style={{
        width: OG_WIDTH,
        height: OG_HEIGHT,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: theme.background,
      }}
    >
      <div
        style={{
          position: "relative",
          width: availableW,
          height: availableH,
          display: "flex",
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width={availableW}
          height={availableH}
          style={{ position: "absolute", top: 0, left: 0 }}
        >
          <rect width={availableW} height={availableH} fill={theme.background} />
          {rulerLines}
          {shapeLayers}
        </svg>

        {rulerLabels}
        {cellLabels}
      </div>
    </div>
  );
}

let fontBuffer: ArrayBuffer | null = null;

async function getFont(origin: string): Promise<ArrayBuffer> {
  if (fontBuffer) return fontBuffer;
  const resp = await fetch(`${origin}/fonts/NotoSans-Regular.ttf`);
  fontBuffer = await resp.arrayBuffer();
  return fontBuffer;
}

export async function GET(request: NextRequest) {
  const builtInKeys = Object.keys(PRESETS);
  const parsed = parseShareParams(request.nextUrl.searchParams, builtInKeys);
  const fallbackPsml = PRESETS[FALLBACK_PRESET_KEY] ?? PRESETS[builtInKeys[0]];
  const psml =
    parsed.kind === "psml"
      ? parsed.packet
      : parsed.kind === "preset"
        ? (PRESETS[parsed.presetKey] ?? fallbackPsml)
        : fallbackPsml;

  const packet = psmlToRenderer(psml);
  const env = initialEnv(psml);
  const mergedControllers = {
    ...initialState(packet),
    ...parsed.controllers,
  };
  for (const [key, value] of Object.entries(mergedControllers)) {
    env.set(key, value);
  }
  const ihl = Number(env.get("ihl") ?? 5);
  env.set("ipv4OptionsCount", Math.max(0, ihl - 5));
  const dataOffset = Number(env.get("dataOffset") ?? 5);
  env.set("tcpOptionsCount", Math.max(0, dataOffset - 5));

  let layout;
  for (let i = 0; i < MAX_LAYOUT_RETRY; i++) {
    try {
      layout = resolveLayout(psml, { env });
      break;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const match = text.match(/missing reference "([^"]+)"/i);
      if (!match) throw error;
      if (!env.has(match[1])) {
        env.set(match[1], 0);
        continue;
      }
      throw error;
    }
  }
  if (!layout) {
    throw new Error("Failed to resolve layout for og image");
  }

  const origin = new URL(request.url).origin;
  const fontData = await getFont(origin);

  return new ImageResponse(buildOgElement(packet, layout, DEFAULT_THEME), {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: [
      {
        name: FONT_NAME,
        data: fontData,
        weight: 400,
        style: "normal",
      },
    ],
    headers: {
      "content-type": "image/png",
      "cache-control": "public, immutable, no-transform, max-age=31536000",
      "x-robots-tag": "noindex",
    },
  });
}
