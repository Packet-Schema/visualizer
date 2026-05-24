"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useSearchParams } from "next/navigation";

import DiagramRuler from "@/components/diagram/DiagramRuler";
import HybridDiagram from "@/components/diagram/HybridDiagram";
import {
  EMBED_SIZE_MESSAGE_TYPE,
  parseEmbedThemeParam,
  type EmbedSizeMessage,
  type EmbedTheme,
} from "@/lib/embed-url";
import { collectPsmlRefs, resolvePsmlLayout } from "@/lib/psml/layout-env";
import { PRESETS } from "@/lib/psml/presets";
import { psmlToRenderer } from "@/lib/psml/psml-to-renderer";
import { initialState } from "@/lib/psml/renderer-helpers";
import { parseShareParams } from "@/lib/share-url";
import type {
  ControllerState,
  Field,
  Packet,
  SubField,
} from "@/lib/psml/renderer";
import type { Packet as PsmlPacket } from "@/lib/psml/types";

const DEFAULT_PACKET_KEY = "ipv4";
const BUILT_IN_PRESET_KEYS = Object.keys(PRESETS);

type EmbedState = {
  packet: Packet;
  psml: PsmlPacket;
  controllers: ControllerState;
  error: string | null;
  theme: EmbedTheme | null;
};

const DEFAULT_EMBED_STATE = makePresetState(DEFAULT_PACKET_KEY, {}, null, null);

export default function EmbedViewer() {
  const rootRef = useRef<HTMLElement | null>(null);
  const searchParams = useSearchParams();
  const searchString = searchParams ? `?${searchParams.toString()}` : "";

  const [embedState, setEmbedState] = useState<EmbedState>(DEFAULT_EMBED_STATE);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setEmbedState(readEmbedState(window.location.search));
  }, [searchString]);

  useEmbedTheme(embedState.theme);
  useEmbedSizeReporter(rootRef);

  const refs = useMemo(
    () => collectPsmlRefs(embedState.psml),
    [embedState.psml],
  );
  const layout = useMemo(
    () =>
      resolvePsmlLayout(embedState.psml, embedState.controllers, "wire", refs),
    [embedState.psml, embedState.controllers, refs],
  );

  const handleFieldClick = useCallback((field: Field) => {
    setSelectedFieldId(field.id);
  }, []);
  const handleSubfieldClick = useCallback(
    (parentField: Field, subfield: SubField) => {
      setSelectedFieldId(`${parentField.id}:${subfield.id}`);
    },
    [],
  );

  if (embedState.error) {
    return (
      <main ref={rootRef} className="embed-root" aria-label="Packet embed">
        <p role="alert" className="embed-error">
          {embedState.error}
        </p>
      </main>
    );
  }

  return (
    <main
      ref={rootRef}
      className="embed-root"
      aria-label={`${embedState.packet.name} embed`}
    >
      <div className="diagram-shell embed-diagram-shell">
        <DiagramRuler rowBits={embedState.packet.rowBits} />
        <HybridDiagram
          packet={embedState.packet}
          layout={layout}
          selectedFieldId={selectedFieldId}
          onFieldClick={handleFieldClick}
          onSubfieldClick={handleSubfieldClick}
        />
      </div>
    </main>
  );
}

function readEmbedState(search: string): EmbedState {
  try {
    const parsed = parseShareParams(search, BUILT_IN_PRESET_KEYS);
    const theme = parseEmbedThemeParam(search);
    if (parsed.kind === "psml") {
      const packet = psmlToRenderer(parsed.packet);
      return {
        packet,
        psml: parsed.packet,
        controllers: { ...initialState(packet), ...parsed.controllers },
        error: null,
        theme,
      };
    }
    if (parsed.kind === "preset") {
      return makePresetState(parsed.presetKey, parsed.controllers, null, theme);
    }
    if (parsed.error) {
      return makePresetState(DEFAULT_PACKET_KEY, {}, parsed.error, theme);
    }
    return makePresetState(DEFAULT_PACKET_KEY, parsed.controllers, null, theme);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makePresetState(
      DEFAULT_PACKET_KEY,
      {},
      message || "Invalid embed URL.",
      parseEmbedThemeParam(search),
    );
  }
}

function makePresetState(
  presetKey: string,
  controllers: ControllerState,
  error: string | null,
  theme: EmbedTheme | null,
): EmbedState {
  const psml = PRESETS[presetKey] ?? PRESETS[DEFAULT_PACKET_KEY];
  const packet = psmlToRenderer(psml);
  return {
    packet,
    psml,
    controllers: { ...initialState(packet), ...controllers },
    error,
    theme,
  };
}

function useEmbedTheme(theme: EmbedTheme | null): void {
  useEffect(() => {
    if (typeof window === "undefined") return;

    if (theme === null) {
      document.documentElement.removeAttribute("data-theme");
      return;
    }

    if (theme !== "system") {
      document.documentElement.setAttribute("data-theme", theme);
      return;
    }

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applySystemTheme = () => {
      document.documentElement.setAttribute(
        "data-theme",
        media?.matches ? "dark" : "light",
      );
    };

    applySystemTheme();
    if (media?.addEventListener) {
      media.addEventListener("change", applySystemTheme);
      return () => {
        media.removeEventListener("change", applySystemTheme);
      };
    }

    media?.addListener?.(applySystemTheme);

    return () => {
      media?.removeListener?.(applySystemTheme);
    };
  }, [theme]);
}

function useEmbedSizeReporter(rootRef: RefObject<HTMLElement | null>): void {
  const sendSize = useCallback(() => {
    if (typeof window === "undefined" || window.parent === window) return;
    const root = rootRef.current;
    if (!root) return;

    const rect = root.getBoundingClientRect();
    const message: EmbedSizeMessage = {
      type: EMBED_SIZE_MESSAGE_TYPE,
      height: Math.ceil(Math.max(rect.height, root.scrollHeight)),
      width: Math.ceil(Math.max(rect.width, root.scrollWidth)),
    };
    window.parent.postMessage(message, "*");
  }, [rootRef]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = rootRef.current;
    if (!root) return;

    let frame: number | null = null;
    const scheduleSize = () => {
      if (typeof window.requestAnimationFrame !== "function") {
        sendSize();
        return;
      }
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        sendSize();
      });
    };

    scheduleSize();
    const observer =
      typeof window.ResizeObserver === "function"
        ? new window.ResizeObserver(scheduleSize)
        : null;
    observer?.observe(root);
    window.addEventListener("resize", scheduleSize);

    return () => {
      if (frame !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frame);
      }
      observer?.disconnect();
      window.removeEventListener("resize", scheduleSize);
    };
  }, [rootRef, sendSize]);
}
