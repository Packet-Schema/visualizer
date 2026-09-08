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
import { THEME_STORAGE_KEY } from "@/lib/constants";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import { PRESET_INDEX, getLoadedPreset, loadPreset } from "@/lib/psdl/presets";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { initialState } from "@/lib/psdl/renderer-helpers";
import { parseShareParams } from "@/lib/share-url";
import type {
  ControllerState,
  Field,
  Packet,
  SubField,
} from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

const DEFAULT_PACKET_KEY = "ipv4";
const BUILT_IN_PRESET_KEYS = Object.keys(PRESET_INDEX);

type EmbedState = {
  packet: Packet;
  psdl: PsdlPacket;
  controllers: ControllerState;
  error: string | null;
  theme: EmbedTheme | null;
};

export default function EmbedViewer() {
  const rootRef = useRef<HTMLElement | null>(null);
  const searchParams = useSearchParams();
  const searchParamsString = searchParams?.toString() ?? "";
  const windowSearchString =
    typeof window === "undefined"
      ? ""
      : new URLSearchParams(window.location.search).toString();
  const searchString = searchParamsString || windowSearchString;

  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const intent = useMemo(
    () => readEmbedIntent(searchString ? `?${searchString}` : ""),
    [searchString],
  );

  // Resolve the PSDL body: a `psdl` share has it inline; a preset share fetches
  // it lazily (from the session cache first, then `/presets/<key>.json`).
  const [psdlBody, setPsdlBody] = useState<PsdlPacket | null>(
    () => intent.psdl ?? getLoadedPreset(intent.presetKey ?? "") ?? null,
  );
  useEffect(() => {
    if (intent.psdl) {
      setPsdlBody(intent.psdl);
      return;
    }
    const key = intent.presetKey ?? DEFAULT_PACKET_KEY;
    const cached = getLoadedPreset(key);
    if (cached) {
      setPsdlBody(cached);
      return;
    }
    let cancelled = false;
    loadPreset(key)
      .catch(() => loadPreset(DEFAULT_PACKET_KEY))
      .then((p) => {
        if (!cancelled) setPsdlBody(p);
      })
      .catch(() => {
        /* leave psdlBody null → loading placeholder */
      });
    return () => {
      cancelled = true;
    };
    // Only the body source matters here; controllers/theme changes must not
    // re-trigger a preset fetch.
  }, [intent.psdl, intent.presetKey]);

  const embedState = useMemo(
    () => (psdlBody ? makeEmbedState(psdlBody, intent) : null),
    [psdlBody, intent],
  );

  useEmbedTheme(embedState?.theme ?? null);
  useEmbedSizeReporter(rootRef);

  const refs = useMemo(
    () => (embedState ? collectPsdlRefs(embedState.psdl) : new Set<string>()),
    [embedState],
  );
  const layout = useMemo(() => {
    if (!embedState) return null;
    const env = new Map(
      Object.entries(embedState.controllers).map(
        ([k, v]) => [k, Number(v)] as const,
      ),
    );

    const packetDefaults = initialEnv(embedState.psdl);
    for (const [k, v] of packetDefaults) {
      if (!env.has(k)) env.set(k, v);
    }

    for (const ref of refs) {
      if (!env.has(ref)) env.set(ref, 0);
    }
    seedDynamicWidthDefaults(embedState.psdl, env);

    // A malformed shared link (controllers that over-consume a `bounded`
    // scope, etc.) makes core normalize throw. The embed is read-only with no
    // previous frame to fall back to, so degrade to the loading placeholder
    // instead of white-screening the iframe (override-audit finding A8).
    try {
      return resolveLayout(embedState.psdl, { env, viewMode: "wire" });
    } catch {
      return null;
    }
  }, [embedState, refs]);

  const handleFieldClick = useCallback((field: Field) => {
    setSelectedFieldId(field.id);
  }, []);
  const handleSubfieldClick = useCallback(
    (parentField: Field, subfield: SubField) => {
      setSelectedFieldId(`${parentField.id}:${subfield.id}`);
    },
    [],
  );

  // Preset body still loading (lazy fetch) — render nothing visible yet.
  if (!embedState || !layout) {
    return (
      <main ref={rootRef} className="embed-root" aria-label="Packet embed" />
    );
  }

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

// What the URL asks for, before the (now lazily-fetched) preset body resolves.
// A `psdl` share carries its own packet; a preset share carries only a key
// whose body is fetched from `/presets/<key>.json`.
type EmbedIntent = {
  psdl?: PsdlPacket;
  presetKey?: string;
  controllers: ControllerState;
  error: string | null;
  theme: EmbedTheme | null;
};

function readEmbedIntent(search: string): EmbedIntent {
  try {
    const parsed = parseShareParams(search, BUILT_IN_PRESET_KEYS);
    const theme = parseEmbedThemeParam(search);
    if (parsed.kind === "psdl") {
      return {
        psdl: parsed.packet,
        controllers: parsed.controllers,
        error: null,
        theme,
      };
    }
    if (parsed.kind === "preset") {
      return {
        presetKey: parsed.presetKey,
        controllers: parsed.controllers,
        error: null,
        theme,
      };
    }
    if (parsed.error) {
      return {
        presetKey: DEFAULT_PACKET_KEY,
        controllers: {},
        error: parsed.error,
        theme,
      };
    }
    return {
      presetKey: DEFAULT_PACKET_KEY,
      controllers: parsed.controllers,
      error: null,
      theme,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      presetKey: DEFAULT_PACKET_KEY,
      controllers: {},
      error: message || "Invalid embed URL.",
      theme: parseEmbedThemeParam(search),
    };
  }
}

/** Build the renderable embed state once the PSDL body is resolved. */
function makeEmbedState(psdl: PsdlPacket, intent: EmbedIntent): EmbedState {
  const packet = psdlToRenderer(psdl);
  return {
    packet,
    psdl,
    controllers: { ...initialState(packet), ...intent.controllers },
    error: intent.error,
    theme: intent.theme,
  };
}

function useEmbedTheme(theme: EmbedTheme | null): void {
  useEffect(() => {
    if (typeof window === "undefined") return;

    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
      return;
    }

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const readSystemTheme = () => (media?.matches ? "dark" : "light");
    const readStoredTheme = (): "light" | "dark" | null => {
      try {
        const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
        return stored === "light" || stored === "dark" ? stored : null;
      } catch {
        return null;
      }
    };
    const applyResolvedTheme = () => {
      const resolved =
        theme === "system"
          ? readSystemTheme()
          : (readStoredTheme() ?? readSystemTheme());
      document.documentElement.setAttribute("data-theme", resolved);
    };

    applyResolvedTheme();
    if (media?.addEventListener) {
      media.addEventListener("change", applyResolvedTheme);
      return () => {
        media.removeEventListener("change", applyResolvedTheme);
      };
    }

    media?.addListener?.(applyResolvedTheme);

    return () => {
      media?.removeListener?.(applyResolvedTheme);
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
