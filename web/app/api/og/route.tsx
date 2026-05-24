import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

import { DEFAULT_THEME } from "@/lib/diagram-export";
import { PRESETS } from "@/lib/psml/presets";
import { resolveLayout } from "@/lib/psml/layout";
import { initialState } from "@/lib/psml/renderer-helpers";
import { initialEnv } from "@/lib/psml/normalize";
import { collectPsmlRefs } from "@/lib/psml/collect-refs";
import { psmlToRenderer } from "@/lib/psml/psml-to-renderer";
import { parseShareParams, CONTROLLER_PARAM_PREFIX } from "@/lib/share-url";
import { OG_FONT_BUFFER } from "@/lib/og-font";
import { StaticDiagram } from "@/components/diagram/StaticDiagram";

const FALLBACK_PRESET_KEY = "ipv4";
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
export const OG_MAX_QUERY_LENGTH = 2048;
const OG_MARGIN = 60;
const FONT_NAME = "Geist";

const OG_HEADERS = {
  "content-type": "image/png",
  "cache-control": "public, no-transform, max-age=86400",
  "x-robots-tag": "noindex",
} as const;

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

function buildShareQuery(params: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const key of ["preset", "psml"]) {
    const value = params.get(key);
    if (value) out.set(key, value);
  }
  for (const [key, value] of params.entries()) {
    if (!key.startsWith(CONTROLLER_PARAM_PREFIX)) continue;
    out.append(key, value);
  }
  return out.toString();
}

export async function GET(request: NextRequest) {
  try {
    const shareQuery = buildShareQuery(request.nextUrl.searchParams);
    // 共有パラメータの長さが上限を超えた場合はデコードをスキップしてフォールバック
    const parsed =
      shareQuery.length <= OG_MAX_QUERY_LENGTH
        ? parseShareParams(new URLSearchParams(shareQuery), Object.keys(PRESETS))
        : null;

    // プロトコルパラメータがない場合は、サービス名のみを表示する画像を生成
    if (!parsed || parsed.kind === "none") {
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
            <div>Visualizer</div>
          </div>
        </div>,
        createOGImageResponseOptions(),
      );
    }

    const builtInKeys = Object.keys(PRESETS);
    const fallbackPsml =
      PRESETS[FALLBACK_PRESET_KEY] ?? PRESETS[builtInKeys[0]];
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
      ...(parsed.controllers ?? {}),
    };
    for (const [key, value] of Object.entries(mergedControllers)) {
      env.set(key, value);
    }

    // ihl/dataOffset から派生カウントを補完（UI の PacketViewer と同じ処理）
    const ihl = Number(env.get("ihl") ?? 5);
    env.set("ipv4OptionsCount", Math.max(0, ihl - 5));
    const dataOffset = Number(env.get("dataOffset") ?? 5);
    env.set("tcpOptionsCount", Math.max(0, dataOffset - 5));

    const refs = collectPsmlRefs(psml);
    for (const ref of refs) {
      if (!env.has(ref)) {
        env.set(ref, 0);
      }
    }

    const layout = resolveLayout(psml, { env });

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
      createOGImageResponseOptions(),
    );
  } catch (error) {
    console.error("OGP generation failed:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
