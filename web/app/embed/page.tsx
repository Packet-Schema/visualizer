import { Suspense } from "react";
import EmbedViewer from "@/components/embed/EmbedViewer";

export default function EmbedPage() {
  return (
    <Suspense>
      <EmbedViewer />
    </Suspense>
  );
}
