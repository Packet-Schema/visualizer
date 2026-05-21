import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

import { buildDiagramSvg } from "@/lib/diagram-export";
import { PRESETS } from "@/lib/psml/presets";
import { resolveLayout } from "@/lib/psml/layout";
import { initialState } from "@/lib/psml/renderer-helpers";
import { initialEnv } from "@/lib/psml/normalize";
import { psmlToRenderer } from "@/lib/psml/psml-to-renderer";
import { parseShareParams } from "@/lib/share-url";

const WIDTH = 1200;
const HEIGHT = 630;
const FALLBACK_PRESET_KEY = "ipv4";
const MAX_LAYOUT_RETRY = 32;

function svgToDataUrl(svg: string): string {
  const encoded = encodeURIComponent(svg)
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  return `data:image/svg+xml,${encoded}`;
}

export async function GET(request: NextRequest) {
  const builtInKeys = Object.keys(PRESETS);
  const parsed = parseShareParams(request.nextUrl.searchParams, builtInKeys);
  const fallbackPsml = PRESETS[FALLBACK_PRESET_KEY] ?? PRESETS[builtInKeys[0]];
  const psml =
    parsed.kind === "psml"
      ? parsed.packet
      : parsed.kind === "preset"
        ? (PRESETS[parsed.presetKey] ?? fallbackPsml)
        : fallbackPsml;

  const packet = psmlToRenderer(psml);
  const env = initialEnv(psml);
  const mergedControllers = {
    ...initialState(packet),
    ...parsed.controllers,
  };
  for (const [key, value] of Object.entries(mergedControllers)) {
    env.set(key, value);
  }
  const ihl = Number(env.get("ihl") ?? 5);
  env.set("ipv4OptionsCount", Math.max(0, ihl - 5));
  const dataOffset = Number(env.get("dataOffset") ?? 5);
  env.set("tcpOptionsCount", Math.max(0, dataOffset - 5));

  let layout;
  for (let i = 0; i < MAX_LAYOUT_RETRY; i++) {
    try {
      layout = resolveLayout(psml, { env });
      break;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const match = text.match(/missing reference "([^"]+)"/i);
      if (!match) throw error;
      if (!env.has(match[1])) {
        env.set(match[1], 0);
        continue;
      }
      throw error;
    }
  }
  if (!layout) {
    throw new Error("Failed to resolve layout for og image");
  }
  const svg = buildDiagramSvg(packet, layout, { bitWidth: 24 });
  const svgUrl = svgToDataUrl(svg);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={svgUrl}
          width={WIDTH}
          height={HEIGHT}
          style={{
            width: `${WIDTH}px`,
            height: `${HEIGHT}px`,
            objectFit: "contain",
          }}
          alt="packet diagram"
        />
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      headers: {
        "content-type": "image/png",
        "cache-control": "public, immutable, no-transform, max-age=31536000",
        "x-robots-tag": "noindex",
      },
    },
  );
}
