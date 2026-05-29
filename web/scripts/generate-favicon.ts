import sharp from "sharp";
import toIco from "to-ico";
import { promises as fs } from "fs";
import { resolve } from "path";

const sourceIcon = resolve(process.cwd(), "assets/icon.png");
const appDir = resolve(process.cwd(), "app");

function roundedMask(size: number): Buffer {
  const r = Math.round(size * 0.16);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="white"/>
  </svg>`;
  return Buffer.from(svg);
}

async function resizeWithRoundedCorners(
  src: string,
  size: number,
): Promise<Buffer> {
  const mask = await sharp(roundedMask(size)).png().toBuffer();
  return sharp(src)
    .resize(size, size, { fit: "cover" })
    .png()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function generateFavicon() {
  try {
    // Check if source icon exists
    await fs.access(sourceIcon);
  } catch {
    console.warn(
      `Source icon not found at ${sourceIcon}. Skipping favicon generation.`,
    );
    return;
  }

  // Generate favicon.ico with multiple sizes (16, 32, 48)
  const sizes = [16, 32, 48];
  const buffers = await Promise.all(
    sizes.map((size) => resizeWithRoundedCorners(sourceIcon, size)),
  );

  const icoBuffer = await toIco(buffers);
  await fs.writeFile(resolve(appDir, "favicon.ico"), icoBuffer);

  // Generate apple-icon.png (180x180)
  const appleIconBuffer = await resizeWithRoundedCorners(sourceIcon, 180);
  await fs.writeFile(resolve(appDir, "apple-icon.png"), appleIconBuffer);

  // Generate icon.png (512x512) for PWA
  const iconBuffer = await resizeWithRoundedCorners(sourceIcon, 512);
  await fs.writeFile(resolve(appDir, "icon.png"), iconBuffer);

  console.log("✓ Favicon files generated successfully");
  console.log("  - app/favicon.ico (16, 32, 48px)");
  console.log("  - app/apple-icon.png (180x180)");
  console.log("  - app/icon.png (512x512)");
}

generateFavicon().catch((error) => {
  console.error("Failed to generate favicon:", error);
  process.exit(1);
});
