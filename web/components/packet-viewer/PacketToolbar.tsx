import type { PacketRegistry } from "@/lib/psml/renderer";
import type { PsmlPacket, ViewMode } from "@/lib/psml/types";
import PresetPicker from "@/components/presets/PresetPicker";
import ToolbarButton from "./ToolbarButton";

type Props = {
  packetKey: string;
  importedPackets: PacketRegistry;
  customPresets: Record<string, PsmlPacket>;
  hexStripVisible: boolean;
  dependenciesVisible: boolean;
  editMode: boolean;
  viewMode: ViewMode;
  headerSizeLabel: string;
  shareStatus: { msg: string; kind: "ok" | "error" } | null;
  onPacketChange: (nextKey: string) => void;
  onExportCustomPresets: () => void;
  onImportCustomPresets: () => void;
  onOpenImport: () => void;
  onOpenExport: () => void;
  onShare: () => void;
  onToggleHexStrip: () => void;
  onToggleDependencies: () => void;
  onToggleViewMode: () => void;
  onToggleEditMode: () => void;
  onDeleteCustomPreset: () => void;
};

export default function PacketToolbar({
  packetKey,
  importedPackets,
  customPresets,
  hexStripVisible,
  dependenciesVisible,
  editMode,
  viewMode,
  headerSizeLabel,
  shareStatus,
  onPacketChange,
  onExportCustomPresets,
  onImportCustomPresets,
  onOpenImport,
  onOpenExport,
  onShare,
  onToggleHexStrip,
  onToggleDependencies,
  onToggleViewMode,
  onToggleEditMode,
  onDeleteCustomPreset,
}: Props) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 mb-2 rounded-[10px] border px-3.5 py-2.5"
      style={{
        background: "var(--bg-elevated)",
        borderColor: "var(--border)",
        boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
      }}
    >
      <PresetPicker
        value={packetKey}
        onChange={onPacketChange}
        imported={importedPackets}
        customPresets={customPresets}
        onExportCustomPresets={onExportCustomPresets}
        onImportCustomPresets={onImportCustomPresets}
      />
      <div className="flex items-center gap-1.5 ml-2">
        <ToolbarButton onClick={onOpenImport}>Import</ToolbarButton>
        <ToolbarButton onClick={onOpenExport}>Export</ToolbarButton>
        <ToolbarButton onClick={onShare} ariaLabel="Copy share URL">
          Share
        </ToolbarButton>
        <ToolbarButton
          onClick={onToggleHexStrip}
          pressed={hexStripVisible}
          ariaLabel={`${hexStripVisible ? "Hide" : "Show"} hex byte strip`}
        >
          Hex view
        </ToolbarButton>
        <ToolbarButton
          onClick={onToggleDependencies}
          pressed={dependenciesVisible}
          ariaLabel={
            dependenciesVisible
              ? "Hide dependency arrows"
              : "Show dependency arrows"
          }
        >
          Dependencies
        </ToolbarButton>
        <ToolbarButton
          onClick={onToggleViewMode}
          pressed={viewMode === "semantic"}
          ariaLabel={
            viewMode === "semantic"
              ? "Switch to wire view (collapse encrypted payloads)"
              : "Switch to decrypted view (expand encrypted payloads)"
          }
        >
          Decrypted view
        </ToolbarButton>
        <ToolbarButton
          onClick={onToggleEditMode}
          pressed={editMode}
          ariaLabel={editMode ? "Exit edit mode" : "Enter edit mode"}
        >
          Edit packet
        </ToolbarButton>
        {packetKey.startsWith("custom:") ? (
          <ToolbarButton
            onClick={onDeleteCustomPreset}
            ariaLabel="Delete this custom preset"
          >
            Delete preset
          </ToolbarButton>
        ) : null}
      </div>
      {shareStatus ? (
        <div
          role="status"
          aria-live="polite"
          className="text-xs font-medium"
          style={{
            color:
              shareStatus.kind === "error"
                ? "var(--field-rose)"
                : "var(--field-green)",
          }}
        >
          {shareStatus.msg}
        </div>
      ) : null}
      <div
        className="ml-auto text-[13px] font-mono tabular-nums"
        style={{ color: "var(--fg-muted)" }}
      >
        Header size: {headerSizeLabel}
      </div>
    </div>
  );
}
