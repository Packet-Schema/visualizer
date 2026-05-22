import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const fontPath = resolve(process.cwd(), "public", "fonts", "geist-regular.ttf");

try {
  const buffer = readFileSync(fontPath);
  const base64 = buffer.toString("base64");
  const outputPath = resolve(process.cwd(), "lib", "og-font.ts");

  const content = `// Auto-generated font data for OGP image generation
const GEIST_FONT_BUFFER_B64 = "${base64}";

export function getGeistFontBuffer(): ArrayBuffer {
  const buffer = Buffer.from(GEIST_FONT_BUFFER_B64, "base64");
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}
`;

  writeFileSync(outputPath, content);
  console.log("✓ Generated og-font.ts with embedded Geist font");
} catch (error) {
  console.error(
    "Failed to generate og-font.ts:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
}
