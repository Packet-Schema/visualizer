import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";

const fontsDir = resolve(process.cwd(), "public", "fonts");
mkdirSync(fontsDir, { recursive: true });

const geistPath = resolve(fontsDir, "geist-regular.ttf");

try {
  // Download Geist TTF from vercel/geist-font repository
  if (!require("fs").existsSync(geistPath)) {
    execSync(
      `curl -sL -o "${geistPath}" https://github.com/vercel/geist-font/raw/main/packages/font/files/GeistVF.ttf`,
      { stdio: "pipe" },
    );
  }
  console.log("✓ Geist font setup complete");
} catch (error) {
  console.error("Failed to setup Geist font:", error);
  process.exit(1);
}
