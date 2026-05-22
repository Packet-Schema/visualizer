import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

import { DEFAULT_THEME } from "@/lib/diagram-export";
import { PRESETS } from "@/lib/psml/presets";
import { resolveLayout } from "@/lib/psml/layout";
import { initialState } from "@/lib/psml/renderer-helpers";
import { initialEnv } from "@/lib/psml/normalize";
import { collectPsmlRefs } from "@/lib/psml/collect-refs";
import { psmlToRenderer } from "@/lib/psml/psml-to-renderer";
import { parseShareParams } from "@/lib/share-url";
import { StaticDiagram } from "@/components/diagram/StaticDiagram";

const FALLBACK_PRESET_KEY = "ipv4";
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

  // Seed all referenced fields to 0 to ensure resolveLayout succeeds
  const refs = collectPsmlRefs(psml);
  for (const ref of refs) {
    if (!env.has(ref)) {
      env.set(ref, 0);
    }
  }

  const layout = resolveLayout(psml, { env });

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
