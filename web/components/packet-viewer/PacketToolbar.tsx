import type { PacketRegistry } from "@/lib/psdl/renderer";
import type { PsdlPacket, ViewMode } from "@/lib/psdl/types";
import PresetPicker from "@/components/presets/PresetPicker";
import ToolbarButton from "./ToolbarButton";

/**
 * Every action the toolbar fires. Bundling them lets the parent (PacketViewer)
 * pass one prop instead of eleven, and keeps the prop list focused on what
 * the toolbar actually *renders*.
 */
export type PacketToolbarActions = {
  onPacketChange: (nextKey: string) => void;
  onExportCustomPresets: () => void;
  onImportCustomPresets: () => void;
  onOpenImport: () => void;
  onOpenExport: () => void;
  onShare: () => void;
  onToggleHexStrip: () => void;
  onToggleViewMode: () => void;
  onToggleEditMode: () => void;
  onDeleteCustomPreset: () => void;
};

type Props = {
  packetKey: string;
  importedPackets: PacketRegistry;
  customPresets: Record<string, PsdlPacket>;
  hexStripVisible: boolean;
  editMode: boolean;
  viewMode: ViewMode;
  headerSizeLabel: string;
  shareStatus: { msg: string; kind: "ok" | "error" } | null;
  actions: PacketToolbarActions;
};

type ToolbarSwitchProps = {
  label: string;
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
};

function ToolbarSwitch({
  label,
  checked,
  onChange,
  ariaLabel,
}: ToolbarSwitchProps) {
  return (
    <label
      className="pv-toolbar-switch"
      data-checked={checked ? "true" : "false"}
    >
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={onChange}
        aria-label={ariaLabel}
        className="pv-switch-input"
      />
      <span className="pv-switch-track" aria-hidden="true" />
      <span className="whitespace-nowrap font-bold">{label}</span>
    </label>
  );
}

export default function PacketToolbar({
  packetKey,
  importedPackets,
  customPresets,
  hexStripVisible,
  editMode,
  viewMode,
  headerSizeLabel,
  shareStatus,
  actions,
}: Props) {
  const {
    onPacketChange,
    onExportCustomPresets,
    onImportCustomPresets,
    onOpenImport,
    onOpenExport,
    onShare,
    onToggleHexStrip,
    onToggleViewMode,
    onToggleEditMode,
    onDeleteCustomPreset,
  } = actions;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-3 rounded-[10px] border border-border bg-bg-elevated px-3.5 py-2.5 shadow-[0_1px_2px_rgba(15,22,50,0.05)]">
      <PresetPicker
        value={packetKey}
        onChange={onPacketChange}
        imported={importedPackets}
        customPresets={customPresets}
        onExportCustomPresets={onExportCustomPresets}
        onImportCustomPresets={onImportCustomPresets}
      />
      <div className="flex flex-wrap items-center gap-1.5 ml-2">
        <ToolbarButton onClick={onOpenImport}>Import</ToolbarButton>
        <ToolbarButton onClick={onOpenExport}>Export</ToolbarButton>
        <ToolbarButton onClick={onShare} ariaLabel="Copy share URL">
          Share
        </ToolbarButton>
        <div
          role="group"
          aria-label="Diagram display options"
          className="ml-1 flex flex-wrap items-center gap-1.5 border-l border-border pl-2"
        >
          <ToolbarSwitch
            label="Hex view"
            checked={hexStripVisible}
            onChange={onToggleHexStrip}
            ariaLabel={`${hexStripVisible ? "Hide" : "Show"} hex byte strip`}
          />
          <ToolbarSwitch
            label="Decrypted view"
            checked={viewMode === "semantic"}
            onChange={onToggleViewMode}
            ariaLabel={
              viewMode === "semantic"
                ? "Switch to wire view (collapse encrypted payloads)"
                : "Switch to decrypted view (expand encrypted payloads)"
            }
          />
        </div>
        <ToolbarSwitch
          label="Edit packet"
          checked={editMode}
          onChange={onToggleEditMode}
          ariaLabel={editMode ? "Exit edit mode" : "Enter edit mode"}
        />
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
          className={`text-xs font-medium ${
            shareStatus.kind === "error"
              ? "text-field-rose"
              : "text-field-green"
          }`}
        >
          {shareStatus.msg}
        </div>
      ) : null}
      <div className="ml-auto text-sm-tight font-mono tabular-nums text-fg-muted">
        Header size: {headerSizeLabel}
      </div>
    </div>
  );
}
