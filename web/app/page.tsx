import type { Metadata } from "next";
import { headers } from "next/headers";
import SiteHeader from "@/components/app-shell/SiteHeader";
import PacketViewer from "@/components/packet-viewer/PacketViewer";
import { PRESETS } from "@/lib/psml/presets";
import { initialState } from "@/lib/psml/renderer-helpers";
import { psmlToRenderer } from "@/lib/psml/psml-to-renderer";
import { parseShareParams, buildShareQueryFromParams } from "@/lib/share-url";
import type { ControllerState } from "@/lib/psml/renderer";
import { OG_WIDTH, OG_HEIGHT, OG_MAX_QUERY_LENGTH } from "@/app/api/og/route";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const DEFAULT_PACKET_KEY = "ipv4";

export async function generateMetadata({
  searchParams,
}: Props): Promise<Metadata> {
  const params = await searchParams;
  const shareQuery = buildShareQueryFromParams(params);
  // URL が長すぎる場合は共有パラメータのデコードをスキップしてフォールバック
  const parsed =
    new URLSearchParams(shareQuery).toString().length <= OG_MAX_QUERY_LENGTH
      ? parseShareParams(new URLSearchParams(shareQuery), Object.keys(PRESETS))
      : { kind: "none" as const, controllers: {} };

  const imageUrl = new URL(
    shareQuery ? `/api/og?${shareQuery}` : "/api/og",
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
  // URL が長すぎる場合は共有パラメータのデコードをスキップしてフォールバック
  const parsed =
    new URLSearchParams(shareQuery).toString().length <= OG_MAX_QUERY_LENGTH
      ? parseShareParams(new URLSearchParams(shareQuery), Object.keys(PRESETS))
      : { kind: "none" as const, controllers: {} };

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
