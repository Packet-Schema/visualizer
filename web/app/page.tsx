import type { Metadata } from "next";
import { headers } from "next/headers";
import SiteHeader from "@/components/app-shell/SiteHeader";
import PacketViewer from "@/components/packet-viewer/PacketViewer";
import { PRESETS } from "@/lib/psml/presets";
import { initialState } from "@/lib/psml/renderer-helpers";
import { psmlToRenderer } from "@/lib/psml/psml-to-renderer";
import { parseShareParams, CONTROLLER_PARAM_PREFIX } from "@/lib/share-url";
import type { ControllerState } from "@/lib/psml/renderer";
import { OG_WIDTH, OG_HEIGHT } from "@/app/api/og/route";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const SHARE_PARAM_KEYS = ["preset", "psml"] as const;
const DEFAULT_PACKET_KEY = "ipv4";

function appendQueryParam(
  out: URLSearchParams,
  key: string,
  value: string | string[] | undefined,
) {
  if (typeof value === "string") {
    out.set(key, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      out.append(key, item);
    }
  }
}

export async function generateMetadata({
  searchParams,
}: Props): Promise<Metadata> {
  const params = await searchParams;
  const shareQuery = buildShareQuery(params);
  const parsed = parseShareParams(
    new URLSearchParams(shareQuery),
    Object.keys(PRESETS),
  );

  const imageUrl = new URL(
    shareQuery ? `/api/og?${shareQuery}` : "/api/og",
    await getRequestOrigin(),
  ).toString();

  const hasExplicitParams = parsed.kind === "preset" || parsed.kind === "psml";
  const packet = hasExplicitParams
    ? parsed.kind === "preset"
      ? (PRESETS[parsed.presetKey] ?? PRESETS[DEFAULT_PACKET_KEY])
      : parsed.packet
    : PRESETS[DEFAULT_PACKET_KEY];

  const title = `${packet.name} | Packet Visualizer`;
  const description =
    hasExplicitParams && packet?.description
      ? packet.description
      : "Visual viewer for common network packet headers.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: imageUrl, width: OG_WIDTH, height: OG_HEIGHT }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default async function Page({ searchParams }: Props) {
  const params = await searchParams;
  const parsed = parseShareParams(
    new URLSearchParams(buildShareQuery(params)),
    Object.keys(PRESETS),
  );
  const initialPacketKey =
    parsed.kind === "preset" ? parsed.presetKey : DEFAULT_PACKET_KEY;
  const initialControllers = mergeInitialControllers(
    initialPacketKey,
    parsed.controllers,
  );

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />
      <PacketViewer
        initialPacketKey={initialPacketKey}
        initialControllers={initialControllers}
      />
    </div>
  );
}

function buildShareQuery(
  params: Record<string, string | string[] | undefined>,
): string {
  const out = new URLSearchParams();
  for (const key of SHARE_PARAM_KEYS) {
    appendQueryParam(out, key, params[key]);
  }
  for (const [key, value] of Object.entries(params)) {
    if (!key.startsWith(CONTROLLER_PARAM_PREFIX)) continue;
    appendQueryParam(out, key, value);
  }
  return out.toString();
}

function mergeInitialControllers(
  packetKey: string,
  controllers: ControllerState,
): ControllerState {
  const packet = PRESETS[packetKey] ?? PRESETS[DEFAULT_PACKET_KEY];
  return {
    ...initialState(psmlToRenderer(packet)),
    ...controllers,
  };
}

async function getRequestOrigin(): Promise<string> {
  const envOrigin = process.env.APP_URL ?? process.env.NEXTAUTH_URL;
  if (envOrigin) return envOrigin;

  const headerList = await headers();
  const forwardedProto = headerList.get("x-forwarded-proto");
  const host = headerList.get("host") ?? "localhost:3000";

  const isLocalhost = /^localhost(:\d+)?$/.test(host);
  const protocol =
    forwardedProto?.split(",")[0]?.trim() ?? (isLocalhost ? "http" : "https");

  return `${protocol}://${host}`;
}
