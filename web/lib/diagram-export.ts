import { CATEGORY_TO_TOKEN } from "./constants";
import type {
  Cell,
  Field,
  Packet,
  ResolvedLayout,
  SubCell,
} from "./psml/renderer";

export type DiagramExportTheme = {
  background: string;
  rowEven: string;
  rowOdd: string;
  rulerTick: string;
  rulerLabel: string;
  accent: string;
  fieldStroke: string;
  fieldLabel: string;
  fieldSublabel: string;
  fieldContinuation: string;
  fieldPalette: Record<string, string>;
  resolveCssColor?: (name: string, fallback: string) => string;
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
  accent: "#2563eb",
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

function xmlAttribute(value: string): string {
  return xmlEscape(value);
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
    ? (theme.resolveCssColor?.(
        cssVariable[1],
        DEFAULT_THEME.fieldPalette.slate,
      ) ?? cssColor(cssVariable[1], DEFAULT_THEME.fieldPalette.slate))
    : token;
}

function rowsFor(layout: ResolvedLayout): Cell[][] {
  // ResolvedLayout contract: row indices are non-negative integers.
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
  const width =
    (cell.endBit - cell.startBit + 1) * bitWidth - LAYOUT.cellInset * 2;
  const height = LAYOUT.rowHeight - LAYOUT.cellInset * 2;
  return { x, y, width, height };
}

function clipPathIdForCell(cell: Cell): string {
  const encodedFieldId = Array.from(
    cell.field.id,
    (char) => char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "fffd",
  ).join("-");
  return `cell-${cell.row}-${cell.segmentIndex}-${encodedFieldId}`;
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
      const width =
        (sub.endBit - sub.startBit + 1) * bitWidth - LAYOUT.cellInset * 2 - 8;
      const label = sub.isFirst ? xmlEscape(sub.subfield.name) : "";
      return [
        `<rect x="${x}" y="${y}" width="${Math.max(width, 1)}" height="${LAYOUT.subfieldHeight}" rx="5" fill="${xmlAttribute(theme.background)}" fill-opacity="0.52" stroke="${xmlAttribute(theme.fieldStroke)}" stroke-width="0.8" />`,
        label
          ? `<text x="${x + 6}" y="${y + 12}" font-size="10" font-family="ui-sans-serif, system-ui, sans-serif" fill="${xmlAttribute(theme.fieldLabel)}">${label}</text>`
          : "",
      ].join("");
    })
    .join("");
}

function renderLockBadge(
  x: number,
  y: number,
  size: number,
  color: string,
): string {
  const scale = size / 16;
  return [
    `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="${xmlAttribute(color)}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">`,
    '<rect x="3" y="7" width="10" height="7" rx="1.5" />',
    '<path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />',
    "</g>",
  ].join("");
}

function renderCellBadges(
  cell: Cell,
  x: number,
  y: number,
  width: number,
  height: number,
  theme: DiagramExportTheme,
): string {
  if (!cell.isFirst) return "";
  const badges: string[] = [];
  if (cell.encrypted === true) {
    badges.push(renderLockBadge(x + width - 20, y + 6, 14, theme.accent));
  }
  if (cell.encryptedParentId) {
    badges.push(
      renderLockBadge(x + width - 14, y + height - 14, 10, theme.accent),
    );
  }
  if (cell.headerProtected === true) {
    badges.push(
      `<text x="${x + width - 28}" y="${y + height - 6}" font-size="9" font-weight="700" font-family="ui-monospace, SFMono-Regular, monospace" fill="${xmlAttribute(theme.accent)}">HP</text>`,
    );
  }
  return badges.join("");
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
  const packetFieldsById = new Map(
    packet.fields.map((field) => [field.id, field]),
  );
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
    const label =
      bit % 4 === 0
        ? `<text x="${x}" y="${LAYOUT.padding + 10}" text-anchor="middle" font-size="10" font-family="ui-monospace, SFMono-Regular, monospace" fill="${theme.rulerLabel}">${bit}</text>`
        : "";
    return `${label}<line x1="${x}" y1="${LAYOUT.padding + LAYOUT.rulerHeight - tickHeight}" x2="${x}" y2="${LAYOUT.padding + LAYOUT.rulerHeight}" stroke="${xmlAttribute(theme.rulerTick)}" stroke-width="1" opacity="${major ? 1 : 0.6}" />`;
  }).join("");

  const body = rows
    .map((cells, rowIndex) => {
      const y = rowY(rowIndex);
      const band = transparentBackground
        ? ""
        : `<rect x="${LAYOUT.padding}" y="${y}" width="${packet.rowBits * bitWidth}" height="${LAYOUT.rowHeight}" rx="8" fill="${xmlAttribute(rowIndex % 2 === 0 ? theme.rowEven : theme.rowOdd)}" />`;
      const renderedCells = cells
        .map((cell) => {
          const {
            x,
            y: cy,
            width: cw,
            height: ch,
          } = cellGeometry(cell, bitWidth);
          const { title, subtitle } = textForCell(cell);
          const escapedTitle = xmlEscape(title);
          const escapedSubtitle = xmlEscape(subtitle);
          const exportField = packetFieldsById.get(cell.field.id) ?? cell.field;
          const fill = fieldFill(exportField, theme);
          const dash = cell.encrypted ? ' stroke-dasharray="5 3"' : "";
          const stroke = cell.encryptedParentId
            ? theme.accent
            : theme.fieldStroke;
          const clipId = clipPathIdForCell(cell);
          return [
            `<rect x="${x}" y="${cy}" width="${Math.max(cw, 1)}" height="${ch}" rx="10" fill="${xmlAttribute(fill)}" stroke="${xmlAttribute(stroke)}" stroke-width="1"${dash} />`,
            `<text clip-path="url(#${clipId})" x="${x + 8}" y="${cy + 23}" font-size="12" font-weight="600" font-family="ui-sans-serif, system-ui, sans-serif" fill="${xmlAttribute(cell.isFirst ? theme.fieldLabel : theme.fieldContinuation)}">${escapedTitle}</text>`,
            `<text clip-path="url(#${clipId})" x="${x + 8}" y="${cy + 40}" font-size="10" font-family="ui-sans-serif, system-ui, sans-serif" fill="${xmlAttribute(theme.fieldSublabel)}">${escapedSubtitle}</text>`,
            renderCellBadges(cell, x, cy, cw, ch, theme),
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
      return `<clipPath id="${clipPathIdForCell(cell)}"><rect x="${x + 4}" y="${y}" width="${Math.max(width - 8, 1)}" height="${height}" /></clipPath>`;
    })
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xmlEscape(packet.name)} diagram">`,
    `<defs>${clipPaths}</defs>`,
    transparentBackground
      ? ""
      : `<rect width="${width}" height="${height}" fill="${xmlAttribute(theme.background)}" />`,
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

type ThemeVariableMaps = {
  light: Map<string, string>;
  dark: Map<string, string>;
};

function collectThemeVariables(): ThemeVariableMaps {
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  if (typeof document === "undefined") {
    return { light, dark };
  }

  const visitRules = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const selector = rule.selectorText;
        const target =
          selector.includes('[data-theme="dark"]') ||
          selector === "[data-theme='dark']"
            ? dark
            : selector.includes(":root")
              ? light
              : null;
        if (!target) continue;
        for (const name of Array.from(rule.style)) {
          if (!name.startsWith("--")) continue;
          target.set(name, rule.style.getPropertyValue(name).trim());
        }
        continue;
      }
      if (rule instanceof CSSMediaRule || rule instanceof CSSLayerBlockRule) {
        visitRules(rule.cssRules);
      }
    }
  };

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visitRules(sheet.cssRules);
    } catch {
      // Ignore cross-origin or inaccessible stylesheets.
    }
  }

  return { light, dark };
}

function resolveThemeVariable(
  maps: ThemeVariableMaps,
  mode: DiagramThemeMode,
  name: string,
  fallback: string,
): string {
  if (mode === "follow-ui") {
    return cssColor(name, fallback);
  }
  const value =
    (mode === "dark" ? maps.dark.get(name) : maps.light.get(name)) ??
    maps.light.get(name) ??
    fallback;
  return value || fallback;
}

function readCssColorFromRoot(
  root: ParentNode,
  name: string,
  fallback: string,
): string {
  if (typeof document === "undefined") return fallback;
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  probe.style.display = "none";
  root.appendChild(probe);
  const color = getComputedStyle(probe).color || fallback;
  probe.remove();
  return color;
}

function buildTheme(
  resolveCssColor: (name: string, fallback: string) => string,
): DiagramExportTheme {
  return {
    background: resolveCssColor("--bg-elevated", DEFAULT_THEME.background),
    rowEven: resolveCssColor("--row-band-even", DEFAULT_THEME.rowEven),
    rowOdd: resolveCssColor("--row-band-odd", DEFAULT_THEME.rowOdd),
    rulerTick: resolveCssColor("--ruler-tick", DEFAULT_THEME.rulerTick),
    rulerLabel: resolveCssColor("--ruler-label", DEFAULT_THEME.rulerLabel),
    accent: resolveCssColor("--accent", DEFAULT_THEME.accent),
    fieldStroke: resolveCssColor("--field-stroke", DEFAULT_THEME.fieldStroke),
    fieldLabel: resolveCssColor("--field-label", DEFAULT_THEME.fieldLabel),
    fieldSublabel: resolveCssColor(
      "--field-sublabel",
      DEFAULT_THEME.fieldSublabel,
    ),
    fieldContinuation: resolveCssColor(
      "--field-continuation",
      DEFAULT_THEME.fieldContinuation,
    ),
    fieldPalette: Object.fromEntries(
      Object.keys(DEFAULT_THEME.fieldPalette).map((token) => [
        token,
        resolveCssColor(`--field-${token}`, DEFAULT_THEME.fieldPalette[token]),
      ]),
    ),
    resolveCssColor,
  };
}

function readDiagramThemeFromRoot(root: ParentNode): DiagramExportTheme {
  const resolveCssColor = (name: string, fallback: string): string =>
    readCssColorFromRoot(root, name, fallback);

  return buildTheme(resolveCssColor);
}

export function readDiagramTheme(mode: DiagramThemeMode): DiagramExportTheme {
  if (typeof document === "undefined" || !document.body) {
    return readDiagramThemeFromDocument();
  }

  if (mode === "follow-ui") {
    return readDiagramThemeFromRoot(document.body);
  }

  const maps = collectThemeVariables();
  const resolveCssColor = (name: string, fallback: string): string =>
    resolveThemeVariable(maps, mode, name, fallback);
  return buildTheme(resolveCssColor);
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

export function downloadTextFile(
  filename: string,
  mime: string,
  content: string,
): void {
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
