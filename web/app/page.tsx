import SiteHeader from "@/components/app-shell/SiteHeader";
import PacketViewer from "@/components/packet-viewer/PacketViewer";

export default function Page() {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader activeNav="viewer" />
      <PacketViewer />
    </div>
  );
}
