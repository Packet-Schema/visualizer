import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

import { DEFAULT_THEME } from "@/lib/diagram-export";
import { PRESETS } from "@/lib/psml/presets";
import { resolveLayout } from "@/lib/psml/layout";
import { initialState } from "@/lib/psml/renderer-helpers";
import { initialEnv } from "@/lib/psml/normalize";
import { psmlToRenderer } from "@/lib/psml/psml-to-renderer";
import { parseShareParams } from "@/lib/share-url";
import { StaticDiagram } from "@/components/diagram/StaticDiagram";

const FALLBACK_PRESET_KEY = "ipv4";
const MAX_LAYOUT_RETRY = 32;
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const OG_MARGIN = 60;
const FONT_NAME = "Geist";

let fontBuffer: ArrayBuffer | null = null;

async function getFont(origin: string): Promise<ArrayBuffer> {
  if (fontBuffer) return fontBuffer;
  const resp = await fetch(`${origin}/fonts/geist-regular.woff`);
  fontBuffer = await resp.arrayBuffer();
  return fontBuffer;
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

  const origin = new URL(request.url).origin;
  const fontData = await getFont(origin);

  const availableW = OG_WIDTH - OG_MARGIN * 2;
  const availableH = OG_HEIGHT - OG_MARGIN * 2;

  return new ImageResponse(
    <div
      style={{
        width: OG_WIDTH,
        height: OG_HEIGHT,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: DEFAULT_THEME.background,
      }}
    >
      <div
        style={{
          width: availableW,
          height: availableH,
          display: "flex",
          alignItems: "center",
        }}
      >
        <StaticDiagram
          packet={packet}
          layout={layout}
          theme={DEFAULT_THEME}
          fontFamily={FONT_NAME}
          targetHeight={availableH}
        />
      </div>
    </div>,
    {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      fonts: [
        {
          name: FONT_NAME,
          data: fontData,
          weight: 400,
          style: "normal",
        },
      ],
      headers: {
        "content-type": "image/png",
        "cache-control": "public, immutable, no-transform, max-age=31536000",
        "x-robots-tag": "noindex",
      },
    },
  );
}
