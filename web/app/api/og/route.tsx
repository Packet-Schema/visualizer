import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

import { CATEGORY_TO_TOKEN } from "@/lib/constants";
import { PRESETS } from "@/lib/psml/presets";
import { resolveLayout } from "@/lib/psml/layout";
import { initialState } from "@/lib/psml/renderer-helpers";
import { initialEnv } from "@/lib/psml/normalize";
import { psmlToRenderer } from "@/lib/psml/psml-to-renderer";
import { parseShareParams } from "@/lib/share-url";
import type { Cell, Packet } from "@/lib/psml/renderer";

const OGP_SIZE = { width: 1200, height: 630 } as const;
const FALLBACK_PRESET_KEY = "ipv4";
const MAX_ROWS = 4;
const MAX_CELLS = 48;

const FIELD_PALETTE: Record<string, string> = {
  blue: "#7fb7ff",
  indigo: "#a8a6ff",
  violet: "#d1a5ff",
  teal: "#8ed7d1",
  green: "#a8df9f",
  amber: "#f3d77e",
  orange: "#f7b27a",
  rose: "#f4a1ae",
  slate: "#c3c8d3",
};

function packetFromShareParams(searchParams: URLSearchParams): {
  packet: Packet;
  cells: Cell[];
} {
  const builtInKeys = Object.keys(PRESETS);
  const parsed = parseShareParams(searchParams, builtInKeys);
  const fallbackPsml = PRESETS[FALLBACK_PRESET_KEY] ?? PRESETS[builtInKeys[0]];
  const psml =
    parsed.kind === "psml"
      ? parsed.packet
      : parsed.kind === "preset"
        ? (PRESETS[parsed.presetKey] ?? fallbackPsml)
        : fallbackPsml;

  const env = initialEnv(psml);
  for (const [key, value] of Object.entries(parsed.controllers)) {
    env.set(key, value);
  }

  const packet = psmlToRenderer(psml);
  for (const [key, value] of Object.entries(initialState(packet))) {
    if (!env.has(key)) env.set(key, value);
  }

  const layout = resolveLayout(psml, { env });
  return { packet, cells: layout.cells };
}

function rowsFor(cells: Cell[]): Cell[][] {
  const rows: Cell[][] = [];
  for (const cell of cells) {
    if (cell.row >= MAX_ROWS || rows.flat().length >= MAX_CELLS) continue;
    rows[cell.row] ??= [];
    rows[cell.row].push(cell);
  }
  return rows.filter(Boolean);
}

function fieldFill(cell: Cell): string {
  const token =
    cell.field.category && CATEGORY_TO_TOKEN[cell.field.category]
      ? CATEGORY_TO_TOKEN[cell.field.category]
      : (cell.field.color ?? "slate");
  return FIELD_PALETTE[token] ?? FIELD_PALETTE.slate;
}

function labelFor(cell: Cell): string {
  const prefix = cell.isFirst ? "" : "... ";
  const label = `${prefix}${cell.field.name}`;
  return label.length > 28 ? `${label.slice(0, 27)}...` : label;
}

function renderOgImage(packet: Packet, cells: Cell[]): ImageResponse {
  const rows = rowsFor(cells);
  const rowBits = Math.max(packet.rowBits, 1);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#ffffff",
        padding: "36px",
        fontFamily: "Arial, Helvetica, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          paddingBottom: "24px",
          borderBottom: "1px solid #d0d5dd",
        }}
      >
        <div
          style={{
            fontSize: 42,
            lineHeight: 1.12,
            fontWeight: 700,
            color: "#111827",
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          {packet.name}
        </div>
        <div
          style={{
            fontSize: 20,
            lineHeight: 1.35,
            color: "#475467",
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          {packet.description ??
            "Visual viewer for common network packet headers."}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          marginTop: "30px",
          border: "1px solid #d0d5dd",
          borderRadius: "18px",
          padding: "18px",
          background: "#fbfcfe",
        }}
      >
        {rows.map((row, rowIndex) => (
          <div
            key={rowIndex}
            style={{
              display: "flex",
              width: "100%",
              height: "72px",
              background: rowIndex % 2 === 0 ? "#f5f7fb" : "#ffffff",
              borderRadius: "12px",
              overflow: "hidden",
            }}
          >
            {row.map((cell) => {
              const bits = Math.max(cell.endBit - cell.startBit + 1, 1);
              const basis = `${(bits / rowBits) * 100}%`;
              return (
                <div
                  key={`${cell.field.id}-${cell.row}-${cell.segmentIndex}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    flex: `0 0 ${basis}`,
                    minWidth: "0",
                    height: "72px",
                    padding: "0 10px",
                    borderRight: "1px solid #344054",
                    background: fieldFill(cell),
                    color: "#101828",
                  }}
                >
                  <div
                    style={{
                      fontSize: bits < 2 ? 0 : 18,
                      fontWeight: 700,
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {labelFor(cell)}
                  </div>
                  <div
                    style={{
                      fontSize: bits < 4 ? 0 : 13,
                      color: "#344054",
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {cell.bitsTotal} bits
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          marginTop: "18px",
          fontSize: 18,
          color: "#667085",
        }}
      >
        Packet Visualizer
      </div>
    </div>,
    OGP_SIZE,
  );
}

export async function GET(request: NextRequest) {
  const { packet, cells } = packetFromShareParams(request.nextUrl.searchParams);
  return renderOgImage(packet, cells);
}
