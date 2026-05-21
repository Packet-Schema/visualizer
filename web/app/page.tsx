import type { Metadata } from "next";
import SiteHeader from "@/components/app-shell/SiteHeader";
import PacketViewer from "@/components/packet-viewer/PacketViewer";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const SHARE_PARAM_KEYS = ["preset", "psml"] as const;
const CONTROLLER_PREFIX = "controllers.";

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
  const ogParams = new URLSearchParams();

  for (const key of SHARE_PARAM_KEYS) {
    appendQueryParam(ogParams, key, params[key]);
  }
  for (const [key, value] of Object.entries(params)) {
    if (!key.startsWith(CONTROLLER_PREFIX)) continue;
    appendQueryParam(ogParams, key, value);
  }

  const query = ogParams.toString();
  const imageUrl = query ? `/api/og?${query}` : "/api/og";
  return {
    openGraph: {
      images: [{ url: imageUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      images: [imageUrl],
    },
  };
}

export default function Page() {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />
      <PacketViewer />
    </div>
  );
}
