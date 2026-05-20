"use client";

import ToolbarButton from "@/components/packet-viewer/ToolbarButton";

type Props = {
  onClick: () => void;
};

export default function ExportButton({ onClick }: Props) {
  return (
    <ToolbarButton
      onClick={onClick}
      ariaLabel="Save diagram as image"
      aria-haspopup="dialog"
    >
      Save image
    </ToolbarButton>
  );
}
