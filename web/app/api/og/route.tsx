import type { NextRequest } from "next/server";

import { CATEGORY_TO_TOKEN } from "@/lib/constants";
import { PRESETS } from "@/lib/psml/presets";
import { resolveLayout } from "@/lib/psml/layout";
import { initialState } from "@/lib/psml/renderer-helpers";
import { initialEnv } from "@/lib/psml/normalize";
import { psmlToRenderer } from "@/lib/psml/psml-to-renderer";
import { parseShareParams } from "@/lib/share-url";
import type { Cell, Packet } from "@/lib/psml/renderer";

const WIDTH = 1200;
const HEIGHT = 630;
const FALLBACK_PRESET_KEY = "ipv4";
const MAX_ROWS = 4;
const MAX_CELLS = 48;

const COLORS = {
  white: [255, 255, 255, 255],
  black: [16, 24, 40, 255],
  slate: [71, 84, 103, 255],
  muted: [102, 112, 133, 255],
  border: [208, 213, 221, 255],
  bandEven: [245, 247, 251, 255],
  bandOdd: [251, 252, 254, 255],
  panel: [251, 252, 254, 255],
} as const;

const FIELD_PALETTE: Record<string, [number, number, number, number]> = {
  blue: [127, 183, 255, 255],
  indigo: [168, 166, 255, 255],
  violet: [209, 165, 255, 255],
  teal: [142, 215, 209, 255],
  green: [168, 223, 159, 255],
  amber: [243, 215, 126, 255],
  orange: [247, 178, 122, 255],
  rose: [244, 161, 174, 255],
  slate: [195, 200, 211, 255],
};

const GLYPHS: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00001", "00001", "00001", "00001", "10001", "10001", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "10001", "11001", "10101", "10011", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  5: ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  6: ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  ",": ["00000", "00000", "00000", "00000", "01100", "01100", "01000"],
  "~": ["00000", "00000", "01001", "10110", "00000", "00000", "00000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
};

type PngCanvas = {
  width: number;
  height: number;
  data: Uint8Array;
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

function createCanvas(width: number, height: number, fill: readonly number[]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0] ?? 0;
    data[i + 1] = fill[1] ?? 0;
    data[i + 2] = fill[2] ?? 0;
    data[i + 3] = fill[3] ?? 255;
  }
  return { width, height, data };
}

function setPixel(
  canvas: PngCanvas,
  x: number,
  y: number,
  color: readonly number[],
) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const idx = (y * canvas.width + x) * 4;
  canvas.data[idx] = color[0] ?? 0;
  canvas.data[idx + 1] = color[1] ?? 0;
  canvas.data[idx + 2] = color[2] ?? 0;
  canvas.data[idx + 3] = color[3] ?? 255;
}

function fillRect(
  canvas: PngCanvas,
  x: number,
  y: number,
  width: number,
  height: number,
  color: readonly number[],
) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(canvas.width, Math.ceil(x + width));
  const y1 = Math.min(canvas.height, Math.ceil(y + height));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) setPixel(canvas, xx, yy, color);
  }
}

function strokeRect(
  canvas: PngCanvas,
  x: number,
  y: number,
  width: number,
  height: number,
  thickness: number,
  color: readonly number[],
) {
  fillRect(canvas, x, y, width, thickness, color);
  fillRect(canvas, x, y + height - thickness, width, thickness, color);
  fillRect(canvas, x, y, thickness, height, color);
  fillRect(canvas, x + width - thickness, y, thickness, height, color);
}

function rowsFor(cells: Cell[]): Cell[][] {
  const rows: Cell[][] = [];
  let visible = 0;
  for (const cell of cells) {
    if (cell.row >= MAX_ROWS || visible >= MAX_CELLS) continue;
    rows[cell.row] ??= [];
    rows[cell.row].push(cell);
    visible += 1;
  }
  return rows.filter(Boolean);
}

function fieldFill(cell: Cell): [number, number, number, number] {
  const token =
    cell.field.category && CATEGORY_TO_TOKEN[cell.field.category]
      ? CATEGORY_TO_TOKEN[cell.field.category]
      : (cell.field.color ?? "slate");
  return FIELD_PALETTE[token] ?? FIELD_PALETTE.slate;
}

function sanitizeText(value: string, maxChars: number): string {
  const upper = value.toUpperCase();
  const normalized = Array.from(upper, (char) =>
    GLYPHS[char] ? char : char === "…" ? "." : "?",
  ).join("");
  return normalized.length > maxChars
    ? `${normalized.slice(0, Math.max(0, maxChars - 3))}...`
    : normalized;
}

function drawText(
  canvas: PngCanvas,
  x: number,
  y: number,
  text: string,
  scale: number,
  color: readonly number[],
) {
  let cursor = x;
  for (const rawChar of text) {
    const glyph = GLYPHS[rawChar] ?? GLYPHS["?"];
    for (let gy = 0; gy < glyph.length; gy++) {
      for (let gx = 0; gx < glyph[gy].length; gx++) {
        if (glyph[gy][gx] !== "1") continue;
        fillRect(
          canvas,
          cursor + gx * scale,
          y + gy * scale,
          scale,
          scale,
          color,
        );
      }
    }
    cursor += 6 * scale;
  }
}

function drawPacket(canvas: PngCanvas, packet: Packet, cells: Cell[]) {
  const rows = rowsFor(cells);
  fillRect(canvas, 36, 36, WIDTH - 72, 88, COLORS.white);
  strokeRect(canvas, 36, 124, WIDTH - 72, 1, 1, COLORS.border);
  drawText(canvas, 44, 48, sanitizeText(packet.name, 32), 4, COLORS.black);
  drawText(
    canvas,
    44,
    90,
    sanitizeText(
      packet.description ?? "Visual viewer for common network packet headers.",
      74,
    ),
    2,
    COLORS.slate,
  );

  fillRect(canvas, 36, 154, WIDTH - 72, 384, COLORS.panel);
  strokeRect(canvas, 36, 154, WIDTH - 72, 384, 1, COLORS.border);

  const rowBits = Math.max(packet.rowBits, 1);
  const innerWidth = WIDTH - 108;
  const rowHeight = 72;
  const rowGap = 16;

  rows.forEach((row, rowIndex) => {
    const y = 172 + rowIndex * (rowHeight + rowGap);
    fillRect(
      canvas,
      54,
      y,
      innerWidth,
      rowHeight,
      rowIndex % 2 === 0 ? COLORS.bandEven : COLORS.bandOdd,
    );
    row.forEach((cell, cellIndex) => {
      const bits = Math.max(cell.endBit - cell.startBit + 1, 1);
      const x = 54 + Math.floor((cell.startBit / rowBits) * innerWidth);
      const nextX = 54 + Math.floor(((cell.endBit + 1) / rowBits) * innerWidth);
      const width = Math.max(nextX - x, 8);
      fillRect(canvas, x, y, width, rowHeight, fieldFill(cell));
      if (cellIndex > 0) fillRect(canvas, x, y, 1, rowHeight, COLORS.border);
      if (bits >= 2) {
        drawText(
          canvas,
          x + 8,
          y + 14,
          sanitizeText(
            `${cell.isFirst ? "" : ". "}${cell.field.name}`,
            Math.max(1, Math.floor((width - 12) / 12)),
          ),
          2,
          COLORS.black,
        );
      }
      if (bits >= 4) {
        drawText(
          canvas,
          x + 8,
          y + 40,
          sanitizeText(`${cell.bitsTotal} bits`, 14),
          1,
          COLORS.slate,
        );
      }
    });
  });

  drawText(canvas, 42, 570, "PACKET VISUALIZER", 2, COLORS.muted);
}

function uint32Bytes(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buffers: Uint8Array[]) {
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (const value of buffer) {
      crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type);
  const crc = crc32([typeBytes, data]);
  return concatBytes([
    uint32Bytes(data.length),
    typeBytes,
    data,
    uint32Bytes(crc),
  ]);
}

async function encodePng(canvas: PngCanvas) {
  const stride = canvas.width * 4;
  const raw = new Uint8Array((stride + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 0;
    raw.set(canvas.data.subarray(y * stride, (y + 1) * stride), rowOffset + 1);
  }

  const compressed = await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
  ).arrayBuffer();

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = concatBytes([
    uint32Bytes(canvas.width),
    uint32Bytes(canvas.height),
    new Uint8Array([8, 6, 0, 0, 0]),
  ]);
  return concatBytes([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(compressed)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

export async function GET(request: NextRequest) {
  const { packet, cells } = packetFromShareParams(request.nextUrl.searchParams);
  const canvas = createCanvas(WIDTH, HEIGHT, COLORS.white);
  drawPacket(canvas, packet, cells);
  const png = await encodePng(canvas);
  return new Response(png, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, immutable, no-transform, max-age=31536000",
      "x-robots-tag": "noindex",
    },
  });
}
