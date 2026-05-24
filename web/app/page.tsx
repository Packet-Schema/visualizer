import type { Metadata } from "next";
import { headers } from "next/headers";
import SiteHeader from "@/components/app-shell/SiteHeader";
import PacketViewer from "@/components/packet-viewer/PacketViewer";
import { PRESETS } from "@/lib/psml/presets";
import { initialState } from "@/lib/psml/renderer-helpers";
import { psmlToRenderer } from "@/lib/psml/psml-to-renderer";
import {
  parseShareParams,
  buildShareQueryFromParams,
  isShareQueryLengthValid,
} from "@/lib/share-url";
import type { ControllerState } from "@/lib/psml/renderer";
import { OG_WIDTH, OG_HEIGHT } from "@/app/api/og/route";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const DEFAULT_PACKET_KEY = "ipv4";

function parseShareParamsOrFallback(
  shareQuery: string,
): ReturnType<typeof parseShareParams> {
  return isShareQueryLengthValid(shareQuery)
    ? parseShareParams(new URLSearchParams(shareQuery), Object.keys(PRESETS))
    : { kind: "none" as const, controllers: {} };
}

export async function generateMetadata({
  searchParams,
}: Props): Promise<Metadata> {
  const params = await searchParams;
  const shareQuery = buildShareQueryFromParams(params);
  const parsed = parseShareParamsOrFallback(shareQuery);

  const isValidLength = isShareQueryLengthValid(shareQuery);
  const imageUrl = new URL(
    isValidLength && shareQuery ? `/api/og?${shareQuery}` : "/api/og",
    await getRequestOrigin(),
  ).toString();

  const hasExplicitParams = parsed.kind === "preset" || parsed.kind === "psml";
  const packet = hasExplicitParams
    ? parsed.kind === "preset"
      ? (PRESETS[parsed.presetKey] ?? PRESETS[DEFAULT_PACKET_KEY])
      : parsed.packet
    : null;

  const title = packet
    ? `${packet.name} | Packet Visualizer`
    : "Packet Visualizer";
  const description =
    packet?.description ?? "Visual viewer for common network packet headers.";

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
  const shareQuery = buildShareQueryFromParams(params);
  const parsed = parseShareParamsOrFallback(shareQuery);

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

function mergeInitialControllers(
  packetKey: string,
  controllers: ControllerState | undefined,
): ControllerState {
  const packet = PRESETS[packetKey] ?? PRESETS[DEFAULT_PACKET_KEY];
  return {
    ...initialState(psmlToRenderer(packet)),
    ...(controllers ?? {}),
  };
}

async function getRequestOrigin(): Promise<string> {
  // APP_URL: explicit origin override for OG image generation (e.g., when behind a proxy)
  // NEXTAUTH_URL: Next.js auth library convention; used as fallback if APP_URL is not set
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
