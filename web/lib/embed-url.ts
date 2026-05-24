import type { ControllerState, ResolvedLayout } from "./psml/renderer";
import type { Packet as PsmlPacket } from "./psml/types";

export const EMBED_SIZE_MESSAGE_TYPE = "packet-view:embed-size";

export type EmbedTheme = "light" | "dark" | "system";

export const EMBED_DEFAULT_THEME: EmbedTheme = "system";
export const EMBED_MIN_HEIGHT = 280;

export type EmbedSizeMessage = {
  type: typeof EMBED_SIZE_MESSAGE_TYPE;
  height: number;
  width: number;
};

export function parseEmbedThemeParam(
  input: string | URLSearchParams,
): EmbedTheme | null {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  const raw = params.get("theme");
  if (raw === null) return null;
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "system";
}

export type BuildEmbedUrlOptions = {
  baseUrl: string | URL;
  packet: PsmlPacket;
  controllers: ControllerState;
  theme?: EmbedTheme;
};

export type BuildIframeEmbedHtmlOptions = BuildEmbedUrlOptions & {
  title?: string;
  height?: number;
};

export function buildEmbedUrl({ baseUrl }: BuildEmbedUrlOptions): string {
  const url = new URL(baseUrl.toString());
  url.pathname = "/embed";
  return url.toString();
}

export function buildIframeEmbedHtml({
  title,
  height = EMBED_MIN_HEIGHT,
  ...urlOptions
}: BuildIframeEmbedHtmlOptions): string {
  const src = buildEmbedUrl(urlOptions);
  const roundedHeight = Number.isFinite(height)
    ? Math.ceil(height)
    : EMBED_MIN_HEIGHT;
  const safeHeight = Math.max(EMBED_MIN_HEIGHT, roundedHeight);
  const safeTitle = title ?? `${urlOptions.packet.name} packet diagram`;

  return [
    `<iframe`,
    `  title="${escapeHtmlAttribute(safeTitle)}"`,
    `  src="${escapeHtmlAttribute(src)}"`,
    `  width="100%"`,
    `  height="${String(safeHeight)}"`,
    `  loading="lazy"`,
    `  style="width:100%;border:0;"`,
    `></iframe>`,
  ].join("\n");
}

export function estimateEmbedIframeHeight(layout: ResolvedLayout): number {
  const rowCount = layout.cells.length
    ? Math.max(...layout.cells.map((cell) => cell.row)) + 1
    : 1;
  const rulerHeight = 30;
  const rowHeight = 68;
  const verticalPadding = 20;
  return Math.max(
    EMBED_MIN_HEIGHT,
    verticalPadding + rulerHeight + rowCount * rowHeight,
  );
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
