import { copyFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const fontsDir = resolve(process.cwd(), "public", "fonts");
mkdirSync(fontsDir, { recursive: true });

try {
  // Copy Geist WOFF from @fontsource/geist npm package
  const sourceWoff = resolve(
    process.cwd(),
    "node_modules",
    "@fontsource",
    "geist",
    "files",
    "geist-latin-400-normal.woff",
  );
  const destWoff = resolve(fontsDir, "geist-regular.woff");
  copyFileSync(sourceWoff, destWoff);

  console.log("✓ Geist font setup complete");
} catch (error) {
  console.error("Failed to setup Geist font:", error);
  process.exit(1);
}
