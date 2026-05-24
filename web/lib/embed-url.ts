export const EMBED_SIZE_MESSAGE_TYPE = "packet-view:embed-size";

export type EmbedTheme = "light" | "dark" | "system";

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
