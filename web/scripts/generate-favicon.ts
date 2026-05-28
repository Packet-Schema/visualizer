import sharp from "sharp";
import pngToIco from "png-to-ico";
import { promises as fs } from "fs";
import { resolve } from "path";

const sourceIcon = resolve(process.cwd(), "assets/icon.png");
const appDir = resolve(process.cwd(), "app");

async function generateFavicon() {
  try {
    // Check if source icon exists
    await fs.access(sourceIcon);
  } catch {
    console.warn(
      `Source icon not found at ${sourceIcon}. Skipping favicon generation.`
    );
    return;
  }

  // Generate favicon.ico with multiple sizes (16, 32, 48)
  const sizes = [16, 32, 48];
  const buffers = await Promise.all(
    sizes.map((size) =>
      sharp(sourceIcon).resize(size, size, { fit: "cover" }).png().toBuffer()
    )
  );

  const icoBuffer = await pngToIco(buffers);
  await fs.writeFile(resolve(appDir, "favicon.ico"), icoBuffer);

  // Generate apple-icon.png (180x180)
  await sharp(sourceIcon)
    .resize(180, 180, { fit: "cover" })
    .png()
    .toFile(resolve(appDir, "apple-icon.png"));

  // Copy icon.png (512x512) to app directory for PWA
  await fs.copyFile(sourceIcon, resolve(appDir, "icon.png"));

  console.log("✓ Favicon files generated successfully");
  console.log("  - app/favicon.ico (16, 32, 48px)");
  console.log("  - app/apple-icon.png (180x180)");
  console.log("  - app/icon.png (512x512)");
}

generateFavicon().catch((error) => {
  console.error("Failed to generate favicon:", error);
  process.exit(1);
});
