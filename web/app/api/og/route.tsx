import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

import { PRESETS } from "@/lib/psdl/presets";
import { LIGHT_DIAGRAM_THEME } from "@/lib/theme";
import { createExportTheme } from "@/lib/colors";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialState } from "@/lib/psdl/renderer-helpers";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { setupDerivedCounts } from "@/lib/psdl/setup-derived-counts";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import {
  parseShareParams,
  buildShareQueryFromParams,
  isShareQueryLengthValid,
} from "@/lib/share-url";
import { OG_FONT_BUFFER } from "@/lib/og-font";
import { StaticDiagram } from "@/components/diagram/StaticDiagram";

const FALLBACK_PRESET_KEY = "ipv4";
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
const OG_MARGIN = 60;
const FONT_NAME = "Geist";

function getDefaultPreset() {
  const primary = PRESETS[FALLBACK_PRESET_KEY];
  if (primary) return primary;
  const builtIn = Object.values(PRESETS);
  if (builtIn.length > 0) return builtIn[0];
  throw new Error("No presets available");
}

const OG_HEADERS = {
  "content-type": "image/png",
  "cache-control": "public, no-transform, max-age=86400",
  "x-robots-tag": "noindex",
} as const;

const OG_THEME = createExportTheme(LIGHT_DIAGRAM_THEME);

const createOGImageResponseOptions = () => ({
  width: OG_WIDTH,
  height: OG_HEIGHT,
  fonts: [
    {
      name: FONT_NAME,
      data: OG_FONT_BUFFER,
      weight: 400 as const,
      style: "normal" as const,
    },
  ],
  headers: OG_HEADERS,
});

const FALLBACK_GRADIENT = "linear-gradient(135deg, #3B2F6F 0%, #2D1E52 100%)";
const FALLBACK_TITLE_FONT_SIZE = 120;
const FALLBACK_TITLE_COLOR = "#FAFAF8";
const FALLBACK_LETTER_SPACING = "0.025em";

const MAX_CONTROLLER_VALUE = 100; // Slider max value from UI controls; protects against URL-injected oversized values
const MAX_ROW_BITS = 256; // Safety limit to prevent memory/rendering issues with oversized packets
const OG_MAX_ROWS = 6; // Maximum rows to display in OG image; excess rows shown as ellipsis

function renderFallbackImage() {
  return new ImageResponse(
    <div
      style={{
        width: OG_WIDTH,
        height: OG_HEIGHT,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: FALLBACK_GRADIENT,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
          fontSize: FALLBACK_TITLE_FONT_SIZE,
          fontWeight: 600,
          color: FALLBACK_TITLE_COLOR,
          fontFamily: FONT_NAME,
          letterSpacing: FALLBACK_LETTER_SPACING,
          lineHeight: 1,
        }}
      >
        <div>Packet</div>
        <div>Schema</div>
        <div>Visualizer</div>
      </div>
    </div>,
    createOGImageResponseOptions(),
  );
}

function sanitizeControllers(
  controllers: Record<string, unknown>,
): Record<string, number> {
  const sanitized: Record<string, number> = {};
  for (const [key, value] of Object.entries(controllers)) {
    const num = Number(value);
    if (Number.isInteger(num)) {
      // Clamp to [0, MAX_CONTROLLER_VALUE] to prevent bugs from URL-injected oversized values.
      // This mirrors the UI slider constraint and ensures consistent behavior between
      // direct URL edits and UI-generated shares.
      sanitized[key] = Math.max(0, Math.min(num, MAX_CONTROLLER_VALUE));
    }
  }
  return sanitized;
}

export async function GET(request: NextRequest) {
  if (!OG_FONT_BUFFER) {
    console.error(
      "OG_FONT_BUFFER not initialized. Ensure generate:og-font script has run.",
    );
    return new Response("OG font not available", { status: 503 });
  }

  try {
    const shareQuery = buildShareQueryFromParams(request.nextUrl.searchParams);
    const parsed = isShareQueryLengthValid(shareQuery)
      ? parseShareParams(new URLSearchParams(shareQuery), Object.keys(PRESETS))
      : (() => {
          console.warn(
            `OG URL too long: ${shareQuery.length} bytes. Falling back to default image.`,
          );
          return null;
        })();

    if (!parsed || parsed.kind === "none") {
      return renderFallbackImage();
    }

    const fallbackPsdl = getDefaultPreset();
    const psdl =
      parsed.kind === "psdl"
        ? parsed.packet
        : parsed.kind === "preset"
          ? (PRESETS[parsed.presetKey] ?? fallbackPsdl)
          : fallbackPsdl;

    if (psdl.rowBits > MAX_ROW_BITS) {
      return renderFallbackImage();
    }

    const packet = psdlToRenderer(psdl);
    const env = initialEnv(psdl);
    const sanitized = sanitizeControllers(parsed.controllers ?? {});
    const mergedControllers = {
      ...initialState(packet),
      ...sanitized,
    };
    for (const [key, value] of Object.entries(mergedControllers)) {
      env.set(key, value);
    }

    setupDerivedCounts(env);

    const refs = collectPsdlRefs(psdl);
    for (const ref of refs) {
      if (!env.has(ref)) {
        env.set(ref, 0);
      }
    }

    const layout = resolveLayout(psdl, { env, viewMode: "semantic" });

    const availableW = OG_WIDTH - OG_MARGIN * 2;
    const availableH = OG_HEIGHT - OG_MARGIN * 2;

    // Force Satori to render synchronously inside this try/catch so any
    // JSX layout error (e.g. "display: flex" constraint) is caught here
    // rather than escaping as an unhandled "failed to pipe response" 500.
    const imgResponse = new ImageResponse(
      <div
        style={{
          width: OG_WIDTH,
          height: OG_HEIGHT,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: OG_THEME.background,
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
            theme={OG_THEME}
            fontFamily={FONT_NAME}
            targetHeight={availableH}
            maxRows={OG_MAX_ROWS}
          />
        </div>
      </div>,
      createOGImageResponseOptions(),
    );
    const buffer = await imgResponse.arrayBuffer();
    return new Response(buffer, { headers: OG_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("OGP generation failed:", message);
    return renderFallbackImage();
  }
}
