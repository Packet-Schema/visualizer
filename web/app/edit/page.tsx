import SiteHeader from "@/components/app-shell/SiteHeader";
import { SourceEditor } from "@/components/source-editor";

export const metadata = {
  title: "PSML Editor — Packet Visualizer",
  description:
    "Author PSML in YAML or JSON with a live diagram preview alongside the source.",
};

export default function EditPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader activeNav="editor" />
      <SourceEditor />
    </div>
  );
}
