"use client";

import satori from "satori";
import type { ReactNode } from "react";
import { EXPORT_FONT_BUFFER } from "@/lib/og-font";

const FONT_FAMILY = "LINE Seed JP, system-ui, sans-serif";

/**
 * Renders a React element to SVG using Satori in the browser.
 * Primarily used for diagram export (SVG files and PNG conversion).
 *
 * @param element React element to render (e.g., StaticDiagram)
 * @param width SVG width in pixels
 * @param height SVG height in pixels
 * @returns SVG string
 */
export async function renderToSvgString(
  element: ReactNode,
  width: number,
  height: number,
): Promise<string> {
  const svg = await satori(element, {
    width,
    height,
    fonts: [
      {
        name: FONT_FAMILY,
        data: EXPORT_FONT_BUFFER,
        weight: 400,
        style: "normal",
      },
    ],
  });

  return svg;
}
