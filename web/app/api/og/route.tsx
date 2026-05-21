import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

import { buildDiagramSvg, type DiagramExportTheme } from "@/lib/diagram-export";
import { PRESETS } from "@/lib/psml/presets";
import { resolveLayout } from "@/lib/psml/layout";
import { initialEnv } from "@/lib/psml/normalize";
import { psmlToRenderer } from "@/lib/psml/psml-to-renderer";
import { parseShareParams } from "@/lib/share-url";

const OGP_SIZE = { width: 1200, height: 630 } as const;
const FALLBACK_PRESET_KEY = "ipv4";

const LIGHT_THEME: DiagramExportTheme = {
  background: "#ffffff",
  rowEven: "#f5f7fb",
  rowOdd: "#fbfcfe",
  rulerTick: "#667085",
  rulerLabel: "#475467",
  accent: "#2563eb",
  fieldStroke: "#344054",
  fieldLabel: "#101828",
  fieldSublabel: "#344054",
  fieldContinuation: "#667085",
  fieldPalette: {
    blue: "#7fb7ff",
    indigo: "#a8a6ff",
    violet: "#d1a5ff",
    teal: "#8ed7d1",
    green: "#a8df9f",
    amber: "#f3d77e",
    orange: "#f7b27a",
    rose: "#f4a1ae",
    slate: "#c3c8d3",
  },
};

function buildSvgFromShareParams(searchParams: URLSearchParams): {
  title: string;
  svg: string;
} {
  const builtInKeys = Object.keys(PRESETS);
  const parsed = parseShareParams(searchParams, builtInKeys);
  const fallbackPsml = PRESETS[FALLBACK_PRESET_KEY] ?? PRESETS[builtInKeys[0]];

  const psml =
    parsed.kind === "psml"
      ? parsed.packet
      : parsed.kind === "preset"
        ? (PRESETS[parsed.presetKey] ?? fallbackPsml)
        : fallbackPsml;

  const env = initialEnv(psml);
  for (const [key, value] of Object.entries(parsed.controllers)) {
    env.set(key, value);
  }

  const runtime = psmlToRenderer(psml);
  const layout = resolveLayout(psml, { env });
  const svg = buildDiagramSvg(runtime, layout, {
    theme: LIGHT_THEME,
    transparentBackground: false,
    bitWidth: 24,
  });

  return { title: psml.name, svg };
}

export async function GET(request: NextRequest) {
  const { title, svg } = buildSvgFromShareParams(request.nextUrl.searchParams);
  const encodedSvg = encodeURIComponent(svg);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#ffffff",
        padding: "32px",
        gap: "18px",
      }}
    >
      <div
        style={{
          fontSize: 36,
          lineHeight: 1.2,
          fontWeight: 700,
          color: "#111827",
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
        }}
      >
        {title}
      </div>
      <div
        style={{
          border: "1px solid #d0d5dd",
          borderRadius: "14px",
          overflow: "hidden",
          display: "flex",
          background: "#ffffff",
          width: "100%",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse JSX does not support next/image */}
        <img
          src={`data:image/svg+xml;charset=utf-8,${encodedSvg}`}
          width={1136}
          height={512}
          alt="Packet diagram"
        />
      </div>
    </div>,
    OGP_SIZE,
  );
}
