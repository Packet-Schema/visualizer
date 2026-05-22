import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

import {
  DEFAULT_THEME,
  LAYOUT,
  cellGeometry,
  fieldFill,
  rowY,
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
const BIT_WIDTH = 24;
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

  const svgWidth = LAYOUT.padding * 2 + packet.rowBits * BIT_WIDTH;
  const svgHeight =
    LAYOUT.padding * 2 +
    LAYOUT.rulerHeight +
    LAYOUT.rulerGap +
    rows.length * LAYOUT.rowHeight +
    Math.max(rows.length - 1, 0) * LAYOUT.rowGap;

  // SVG layer: only shapes (no <text> nodes — not supported in Satori SVG)
  const rulerLines = Array.from(
    { length: packet.rowBits },
    (_, bit): React.ReactElement => {
      const x = LAYOUT.padding + bit * BIT_WIDTH;
      const major = bit % 8 === 0;
      const tickHeight = major ? 10 : 6;
      return (
        <line
          key={`tick-${bit}`}
          x1={x}
          y1={LAYOUT.padding + LAYOUT.rulerHeight - tickHeight}
          x2={x}
          y2={LAYOUT.padding + LAYOUT.rulerHeight}
          stroke={theme.rulerTick}
          strokeWidth={1}
          opacity={major ? 1 : 0.6}
        />
      );
    },
  );

  const shapeLayers = rows.flatMap(
    (cells: Cell[], rowIndex: number): React.ReactElement[] => {
      const y = rowY(rowIndex);
      const bandFill = rowIndex % 2 === 0 ? theme.rowEven : theme.rowOdd;

      const band = (
        <rect
          key={`band-${rowIndex}`}
          x={LAYOUT.padding}
          y={y}
          width={packet.rowBits * BIT_WIDTH}
          height={LAYOUT.rowHeight}
          rx={8}
          fill={bandFill}
        />
      );

      const cellRects = cells.map((cell: Cell): React.ReactElement => {
        const {
          x,
          y: cy,
          width: cw,
          height: ch,
        } = cellGeometry(cell, BIT_WIDTH);
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
      const x = LAYOUT.padding + bit * BIT_WIDTH;
      return (
        <div
          key={`rlabel-${bit}`}
          style={{
            display: "flex",
            position: "absolute",
            left: x - 6,
            top: LAYOUT.padding,
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
  const cellLabels = rows.flatMap((cells: Cell[]): React.ReactElement[] => {
    return cells.map((cell: Cell): React.ReactElement => {
      const { x, y: cy } = cellGeometry(cell, BIT_WIDTH);
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
    });
  });

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
          width: svgWidth,
          height: svgHeight,
          display: "flex",
        }}
      >
        {/* SVG layer: shapes only */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width={svgWidth}
          height={svgHeight}
          style={{ position: "absolute", top: 0, left: 0 }}
        >
          <rect width={svgWidth} height={svgHeight} fill={theme.background} />
          {rulerLines}
          {shapeLayers}
        </svg>

        {/* HTML text layers */}
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
