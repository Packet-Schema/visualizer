import { CATEGORY_TO_TOKEN } from "./constants";
import type { Cell, Field, Packet, ResolvedLayout, SubCell } from "./psml/renderer";

export type DiagramExportTheme = {
  background: string;
  rowEven: string;
  rowOdd: string;
  rulerTick: string;
  rulerLabel: string;
  fieldStroke: string;
  fieldLabel: string;
  fieldSublabel: string;
  fieldContinuation: string;
  fieldPalette: Record<string, string>;
};

export type DiagramThemeMode = "follow-ui" | "light" | "dark";

export type DiagramSvgOptions = {
  theme?: DiagramExportTheme;
  bitWidth?: number;
  transparentBackground?: boolean;
};

const DEFAULT_THEME: DiagramExportTheme = {
  background: "#ffffff",
  rowEven: "#f5f7fb",
  rowOdd: "#fbfcfe",
  rulerTick: "#667085",
  rulerLabel: "#475467",
  fieldStroke: "#344054",
  fieldLabel: "#101828",
  fieldSublabel: "#344054",
  fieldContinuation: "#667085",
  fieldPalette: {
    blue: "#7fb7ff",
    indigo: "#a8a6ff",
    violet: "#d1a5ff",
    teal: "#8ed7d1",
    green: "#a8df9f",
    amber: "#f3d77e",
    orange: "#f7b27a",
    rose: "#f4a1ae",
    slate: "#c3c8d3",
  },
};

const LAYOUT = {
  padding: 16,
  rulerHeight: 26,
  rulerGap: 8,
  rowHeight: 64,
  rowGap: 6,
  cellInset: 2,
  subfieldHeight: 18,
} as const;

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function resolveToken(field: Field): string {
  if (field.category && CATEGORY_TO_TOKEN[field.category]) {
    return CATEGORY_TO_TOKEN[field.category];
  }
  return field.color ?? "slate";
}

function fieldFill(field: Field, theme: DiagramExportTheme): string {
  const token = resolveToken(field);
  if (theme.fieldPalette[token]) return theme.fieldPalette[token];
  const cssVariable = token.match(/^var\((--[^)]+)\)$/);
  return cssVariable
    ? cssColor(cssVariable[1], DEFAULT_THEME.fieldPalette.slate)
    : token;
}

function rowsFor(layout: ResolvedLayout): Cell[][] {
  const rowsTotal = layout.cells.length
    ? Math.max(...layout.cells.map((cell) => cell.row)) + 1
    : 0;
  const rows: Cell[][] = Array.from({ length: rowsTotal }, () => []);
  for (const cell of layout.cells) {
    if (!Number.isInteger(cell.row) || cell.row < 0 || cell.row >= rowsTotal) {
      throw new Error(`Invalid diagram row index: ${cell.row}`);
    }
    rows[cell.row].push(cell);
  }
  return rows;
}

function rowY(row: number): number {
  return (
    LAYOUT.padding +
    LAYOUT.rulerHeight +
    LAYOUT.rulerGap +
    row * (LAYOUT.rowHeight + LAYOUT.rowGap)
  );
}

function cellGeometry(cell: Cell, bitWidth: number) {
  const x = LAYOUT.padding + cell.startBit * bitWidth + LAYOUT.cellInset;
  const y = rowY(cell.row) + LAYOUT.cellInset;
  const width = (cell.endBit - cell.startBit + 1) * bitWidth - LAYOUT.cellInset * 2;
  const height = LAYOUT.rowHeight - LAYOUT.cellInset * 2;
  return { x, y, width, height };
}

function textForCell(cell: Cell): { title: string; subtitle: string } {
  if (!cell.isFirst) {
    return {
      title: `… ${cell.field.variable ? `~${cell.field.name}` : cell.field.name}`,
      subtitle: "cont.",
    };
  }
  const title = cell.field.variable ? `~${cell.field.name}` : cell.field.name;
  // The first segment shows the whole field size so split fields retain one
  // authoritative label across rows; continuation segments stay lightweight.
  const bytes = cell.bitsTotal / 8;
  const suffix = cell.field.variable ? " (var)" : "";
  const subtitle = Number.isInteger(bytes)
    ? `${cell.bitsTotal} bits / ${bytes}B${suffix}`
    : `${cell.bitsTotal} bits${suffix}`;
  return { title, subtitle };
}

function renderSubfields(
  subCells: SubCell[] | undefined,
  cell: Cell,
  bitWidth: number,
  theme: DiagramExportTheme,
): string {
  if (!subCells?.length) return "";
  const parent = cellGeometry(cell, bitWidth);
  const y = parent.y + parent.height - LAYOUT.subfieldHeight - 5;
  return subCells
    .map((sub) => {
      const x = LAYOUT.padding + sub.startBit * bitWidth + LAYOUT.cellInset + 4;
      const width = (sub.endBit - sub.startBit + 1) * bitWidth - LAYOUT.cellInset * 2 - 8;
      const label = sub.isFirst ? xmlEscape(sub.subfield.name) : "";
      return [
        `<rect x="${x}" y="${y}" width="${Math.max(width, 1)}" height="${LAYOUT.subfieldHeight}" rx="5" fill="#ffffff" fill-opacity="0.52" stroke="${theme.fieldStroke}" stroke-width="0.8" />`,
        label
          ? `<text x="${x + 6}" y="${y + 12}" font-size="10" font-family="ui-sans-serif, system-ui, sans-serif" fill="${theme.fieldLabel}">${label}</text>`
          : "",
      ].join("");
    })
    .join("");
}

export function buildDiagramSvg(
  packet: Packet,
  layout: ResolvedLayout,
  options: DiagramSvgOptions = {},
): string {
  const theme = options.theme ?? DEFAULT_THEME;
  const bitWidth = options.bitWidth ?? 24;
  const transparentBackground = options.transparentBackground === true;
  const rows = rowsFor(layout);
  const width = LAYOUT.padding * 2 + packet.rowBits * bitWidth;
  const height =
    LAYOUT.padding * 2 +
    LAYOUT.rulerHeight +
    LAYOUT.rulerGap +
    rows.length * LAYOUT.rowHeight +
    Math.max(rows.length - 1, 0) * LAYOUT.rowGap;

  const ruler = Array.from({ length: packet.rowBits }, (_, bit) => {
    const x = LAYOUT.padding + bit * bitWidth;
    const major = bit % 8 === 0;
    const tickHeight = major ? 10 : 6;
    const label = bit % 4 === 0
      ? `<text x="${x}" y="${LAYOUT.padding + 10}" text-anchor="middle" font-size="10" font-family="ui-monospace, SFMono-Regular, monospace" fill="${theme.rulerLabel}">${bit}</text>`
      : "";
    return `${label}<line x1="${x}" y1="${LAYOUT.padding + LAYOUT.rulerHeight - tickHeight}" x2="${x}" y2="${LAYOUT.padding + LAYOUT.rulerHeight}" stroke="${theme.rulerTick}" stroke-width="1" opacity="${major ? 1 : 0.6}" />`;
  }).join("");

  const body = rows
    .map((cells, rowIndex) => {
      const y = rowY(rowIndex);
      const band = transparentBackground
        ? ""
        : `<rect x="${LAYOUT.padding}" y="${y}" width="${packet.rowBits * bitWidth}" height="${LAYOUT.rowHeight}" rx="8" fill="${rowIndex % 2 === 0 ? theme.rowEven : theme.rowOdd}" />`;
      const renderedCells = cells
        .map((cell) => {
          const { x, y: cy, width: cw, height: ch } = cellGeometry(cell, bitWidth);
          const { title, subtitle } = textForCell(cell);
          const escapedTitle = xmlEscape(title);
          const escapedSubtitle = xmlEscape(subtitle);
          const fill = fieldFill(cell.field, theme);
          const dash = cell.encrypted ? ' stroke-dasharray="5 3"' : "";
          const clipId = `cell-${cell.row}-${cell.segmentIndex}-${cell.field.id}`;
          return [
            `<rect x="${x}" y="${cy}" width="${Math.max(cw, 1)}" height="${ch}" rx="10" fill="${fill}" stroke="${theme.fieldStroke}" stroke-width="1"${dash} />`,
            `<text clip-path="url(#${clipId})" x="${x + 8}" y="${cy + 23}" font-size="12" font-weight="600" font-family="ui-sans-serif, system-ui, sans-serif" fill="${cell.isFirst ? theme.fieldLabel : theme.fieldContinuation}">${escapedTitle}</text>`,
            `<text clip-path="url(#${clipId})" x="${x + 8}" y="${cy + 40}" font-size="10" font-family="ui-sans-serif, system-ui, sans-serif" fill="${theme.fieldSublabel}">${escapedSubtitle}</text>`,
            renderSubfields(cell.subCells, cell, bitWidth, theme),
          ].join("");
        })
        .join("");
      return `${band}${renderedCells}`;
    })
    .join("");

  const clipPaths = layout.cells
    .map((cell) => {
      const { x, y, width, height } = cellGeometry(cell, bitWidth);
      return `<clipPath id="cell-${cell.row}-${cell.segmentIndex}-${cell.field.id}"><rect x="${x + 4}" y="${y}" width="${Math.max(width - 8, 1)}" height="${height}" /></clipPath>`;
    })
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xmlEscape(packet.name)} diagram">`,
    `<defs>${clipPaths}</defs>`,
    transparentBackground
      ? ""
      : `<rect width="${width}" height="${height}" fill="${theme.background}" />`,
    ruler,
    body,
    "</svg>",
  ].join("");
}

function cssColor(name: string, fallback: string): string {
  if (typeof document === "undefined" || !document.body) return fallback;
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color || fallback;
  probe.remove();
  return color;
}

function readDiagramThemeFromRoot(root: ParentNode): DiagramExportTheme {
  const cssColorFromRoot = (name: string, fallback: string): string => {
    if (typeof document === "undefined") return fallback;
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    probe.style.display = "none";
    root.appendChild(probe);
    const color = getComputedStyle(probe).color || fallback;
    probe.remove();
    return color;
  };

  return {
    background: cssColorFromRoot("--bg-elevated", DEFAULT_THEME.background),
    rowEven: cssColorFromRoot("--row-band-even", DEFAULT_THEME.rowEven),
    rowOdd: cssColorFromRoot("--row-band-odd", DEFAULT_THEME.rowOdd),
    rulerTick: cssColorFromRoot("--ruler-tick", DEFAULT_THEME.rulerTick),
    rulerLabel: cssColorFromRoot("--ruler-label", DEFAULT_THEME.rulerLabel),
    fieldStroke: cssColorFromRoot("--field-stroke", DEFAULT_THEME.fieldStroke),
    fieldLabel: cssColorFromRoot("--field-label", DEFAULT_THEME.fieldLabel),
    fieldSublabel: cssColorFromRoot("--field-sublabel", DEFAULT_THEME.fieldSublabel),
    fieldContinuation: cssColorFromRoot(
      "--field-continuation",
      DEFAULT_THEME.fieldContinuation,
    ),
    fieldPalette: Object.fromEntries(
      Object.keys(DEFAULT_THEME.fieldPalette).map((token) => [
        token,
        cssColorFromRoot(`--field-${token}`, DEFAULT_THEME.fieldPalette[token]),
      ]),
    ),
  };
}

export function readDiagramTheme(mode: DiagramThemeMode): DiagramExportTheme {
  if (typeof document === "undefined" || !document.body || mode === "follow-ui") {
    return readDiagramThemeFromDocument();
  }

  const root = document.documentElement;
  const previousTheme = root.getAttribute("data-theme");
  root.setAttribute("data-theme", mode);
  try {
    return readDiagramThemeFromDocument();
  } finally {
    if (previousTheme === null) {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", previousTheme);
    }
  }
}

export function readDiagramThemeFromDocument(): DiagramExportTheme {
  if (typeof document === "undefined" || !document.body) {
    return {
      ...DEFAULT_THEME,
      fieldPalette: { ...DEFAULT_THEME.fieldPalette },
    };
  }
  return readDiagramThemeFromRoot(document.body);
}

export function downloadTextFile(filename: string, mime: string, content: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const blob = new Blob([content], { type: mime });
  downloadBlobFile(filename, blob);
}

export function downloadBlobFile(filename: string, blob: Blob): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function svgToPngBlob(svg: string, scale: number): Promise<Blob> {
  const svgBlob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("SVG image could not be loaded."));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context is unavailable.");
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("PNG encoding failed."));
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
