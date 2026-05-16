"use client";

import { useCallback, useMemo, useState } from "react";

import { PRESETS } from "@/lib/presets.generated";
import {
  initialState,
  packetCategories,
  resolvePacket,
} from "@/lib/packet-resolver";
import { DEFAULT_BYTE_ORDER } from "@/lib/constants";
import type { ControllerState } from "@/lib/types";

import ControlsPanel from "./ControlsPanel";
import DetailPanel from "./DetailPanel";
import DiagramSvg from "./DiagramSvg";
import Legend from "./Legend";
import PresetPicker from "./PresetPicker";
import ThemeToggle from "./ThemeToggle";

const DEFAULT_PACKET_KEY = "ipv4";

export default function PacketViewer() {
  const [packetKey, setPacketKey] = useState<string>(DEFAULT_PACKET_KEY);
  const packet = PRESETS[packetKey];

  const [controllers, setControllers] = useState<ControllerState>(() =>
    initialState(PRESETS[DEFAULT_PACKET_KEY]),
  );
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);

  const handlePacketChange = useCallback((nextKey: string) => {
    setPacketKey(nextKey);
    setControllers(initialState(PRESETS[nextKey]));
    setSelectedFieldId(null);
  }, []);

  const handleControllerChange = useCallback((key: string, value: number) => {
    setControllers((prev) => ({ ...prev, [key]: value }));
  }, []);

  const layout = useMemo(
    () => resolvePacket(packet, controllers),
    [packet, controllers],
  );

  const categories = useMemo(() => packetCategories(packet), [packet]);

  const bytes = layout.totalBits / 8;
  const byteStr = Number.isInteger(bytes)
    ? `${bytes} bytes`
    : `${layout.totalBits} bits`;

  return (
    <div className="min-h-screen flex flex-col">
      <header
        className="sticky top-0 z-50 shadow-md"
        style={{
          background: "var(--bg-header)",
          color: "var(--header-fg)",
        }}
      >
        <div className="max-w-[1200px] mx-auto px-6 py-2 flex items-center justify-between gap-4">
          <div className="flex flex-wrap items-baseline gap-2.5 min-w-0">
            <h1 className="m-0 text-[18px] font-semibold tracking-wide whitespace-nowrap">
              Packet View
            </h1>
            <p
              className="m-0 text-xs truncate min-w-0"
              style={{ color: "var(--header-fg-muted)" }}
            >
              Visual viewer for common network packet headers.
            </p>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="max-w-[1200px] mx-auto px-6 py-3 pb-10 w-full flex-1">
        <div
          className="flex flex-wrap items-center gap-3 mb-2 rounded-[10px] border px-3.5 py-2.5"
          style={{
            background: "var(--bg-elevated)",
            borderColor: "var(--border)",
            boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
          }}
        >
          <PresetPicker value={packetKey} onChange={handlePacketChange} />
          <div
            className="ml-auto text-[13px] font-mono tabular-nums"
            style={{ color: "var(--fg-muted)" }}
          >
            Header size: {layout.totalBits} bits ({byteStr})
          </div>
        </div>

        {packet.description ? (
          <p
            className="text-[13px] mx-0.5 mt-2 mb-1"
            style={{ color: "var(--fg-muted)" }}
          >
            {packet.description}
          </p>
        ) : null}
        <p
          className="text-xs mx-0.5 mb-3 italic flex items-center gap-1.5"
          style={{ color: "var(--fg-faint)" }}
        >
          <span
            className="not-italic font-bold"
            style={{ color: "var(--accent)" }}
            aria-hidden="true"
          >
            ↦
          </span>
          {packet.byteOrder || DEFAULT_BYTE_ORDER}
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_max-content] gap-3 items-start">
          <div
            className="rounded-[10px] border p-3.5 overflow-x-auto"
            style={{
              background: "var(--bg-elevated)",
              borderColor: "var(--border)",
              boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
            }}
          >
            <DiagramSvg
              packet={packet}
              layout={layout}
              selectedFieldId={selectedFieldId}
              onFieldClick={(field) => setSelectedFieldId(field.id)}
              onSubfieldClick={(parentField, subfield) =>
                setSelectedFieldId(`${parentField.id}:${subfield.id}`)
              }
            />
          </div>
          <Legend categories={categories} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
          <section
            className="rounded-[10px] border px-4 py-3.5"
            style={{
              background: "var(--bg-elevated)",
              borderColor: "var(--border)",
              boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
            }}
          >
            <h2
              className="text-xs m-0 mb-3 uppercase tracking-wider font-bold"
              style={{ color: "var(--fg-muted)" }}
            >
              Controls
            </h2>
            <ControlsPanel
              packet={packet}
              controllers={controllers}
              onChange={handleControllerChange}
            />
          </section>

          <section
            className="rounded-[10px] border px-4 py-3.5"
            style={{
              background: "var(--bg-elevated)",
              borderColor: "var(--border)",
              boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
            }}
          >
            <h2
              className="text-xs m-0 mb-3 uppercase tracking-wider font-bold"
              style={{ color: "var(--fg-muted)" }}
            >
              Field detail
            </h2>
            <DetailPanel
              packet={packet}
              selectedFieldId={selectedFieldId}
              controllers={controllers}
            />
          </section>
        </div>
      </main>
    </div>
  );
}
