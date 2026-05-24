"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { resolveLayout } from "@/lib/psml/layout";
import { initialEnv } from "@/lib/psml/normalize";
import { PRESETS, PRESET_KEYS } from "@/lib/psml/presets";
import { collectPsmlRefs } from "@/lib/psml/source-refs";
import {
  decodeSource,
  encodeSource,
  SourceParseError,
  type SourceFormat,
} from "@/lib/psml/source-format";
import type { ResolvedLayout } from "@/lib/psml/renderer";
import type { PsmlPacket } from "@/lib/psml/types";

import PreviewPanel from "./PreviewPanel";
import SourceTextarea from "./SourceTextarea";

const DEFAULT_PRESET_KEY: string = PRESET_KEYS.includes("ipv4")
  ? "ipv4"
  : (PRESET_KEYS[0] ?? "");

const DRAFT_STORAGE_KEY = "packet-view-edit-draft";
const FORMAT_STORAGE_KEY = "packet-view-edit-format";
const PARSE_DEBOUNCE_MS = 200;

type StoredDraft = {
  format: SourceFormat;
  text: string;
};

type ParseError = { message: string; line: number | null };

function readStoredDraft(): StoredDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (
      typeof parsed.text === "string" &&
      (parsed.format === "yaml" || parsed.format === "json")
    ) {
      return { format: parsed.format, text: parsed.text };
    }
  } catch {
    // ignore corrupt drafts; falls through to default
  }
  return null;
}

function readStoredFormat(): SourceFormat {
  if (typeof window === "undefined") return "yaml";
  const raw = window.localStorage.getItem(FORMAT_STORAGE_KEY);
  return raw === "json" ? "json" : "yaml";
}

/**
 * PsmlPacket → ResolvedLayout の準備。 fallback seed (`collectPsmlRefs` で
 * 拾った未 seed の ref を 0 で埋める) は PacketViewer と揃える。
 * 失敗時は throw — 呼び出し側で catch して banner に倒す。
 */
function computeLayout(packet: PsmlPacket): ResolvedLayout {
  const env = initialEnv(packet);
  for (const r of collectPsmlRefs(packet)) {
    if (!env.has(r)) env.set(r, 0);
  }
  return resolveLayout(packet, { env });
}

type ParseResult =
  | { ok: true; packet: PsmlPacket; layout: ResolvedLayout }
  | { ok: false; error: ParseError };

function parseAndLayout(text: string, format: SourceFormat): ParseResult {
  let packet: PsmlPacket;
  try {
    packet = decodeSource(text, format);
  } catch (e) {
    if (e instanceof SourceParseError) {
      return { ok: false, error: { message: e.message, line: e.line } };
    }
    return {
      ok: false,
      error: {
        message: e instanceof Error ? e.message : String(e),
        line: null,
      },
    };
  }
  try {
    const layout = computeLayout(packet);
    return { ok: true, packet, layout };
  } catch (e) {
    return {
      ok: false,
      error: {
        message: e instanceof Error ? e.message : String(e),
        line: null,
      },
    };
  }
}

/**
 * Issue #87 で要望された「左に PSML を書いて、右に live preview」画面。
 *
 * 動線
 *   1. format toggle (YAML / JSON)。 デフォルトは YAML —
 *      `data/presets/*.psml.yaml` と同じ書き味で authoring できる。
 *   2. 入力に応じて debounce (200ms) で parse → validate → resolveLayout →
 *      preview 更新。 失敗中は最後に成功した packet/layout を preview に
 *      残す (typo 中に diagram が消える regression を防ぐ)。
 *   3. preset セレクタで built-in を読み込んで叩き台にできる。
 *
 * 永続化は localStorage 一本 (URL 共有は次フェーズ予定 — `buildShareUrl`
 * は controllers と組で encode するので、controllers 概念を持たないこの
 * 画面では半分しか活かせない)。
 */
export default function SourceEditor() {
  const initialFormat = useMemo(() => readStoredFormat(), []);
  const initialPacket = PRESETS[DEFAULT_PRESET_KEY];
  const initialLayout = useMemo(
    () => computeLayout(initialPacket),
    [initialPacket],
  );

  const [format, setFormat] = useState<SourceFormat>(initialFormat);
  const [text, setText] = useState<string>(() =>
    encodeSource(initialPacket, initialFormat),
  );
  const [lastGood, setLastGood] = useState<{
    packet: PsmlPacket;
    layout: ResolvedLayout;
  }>({ packet: initialPacket, layout: initialLayout });
  const [parseError, setParseError] = useState<ParseError | null>(null);
  const [presetKey, setPresetKey] = useState<string>(DEFAULT_PRESET_KEY);

  // localStorage の draft を hydrate。 SSR では window が無いので useEffect で。
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const draft = readStoredDraft();
    if (!draft) return;
    setFormat(draft.format);
    setText(draft.text);
    const result = parseAndLayout(draft.text, draft.format);
    if (result.ok) {
      setLastGood({ packet: result.packet, layout: result.layout });
      setParseError(null);
    } else {
      setParseError(result.error);
    }
  }, []);

  // debounce parse + layout。 text が settle してから preview を更新する。
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const result = parseAndLayout(text, format);
      if (result.ok) {
        setLastGood({ packet: result.packet, layout: result.layout });
        setParseError(null);
      } else {
        setParseError(result.error);
      }
    }, PARSE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [text, format]);

  // draft 永続化。 hydrate 完了後にのみ書き込んで、SSR 直後の初期 text で
  // 既存 draft を上書きしないようにする。
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!hydratedRef.current) return;
    try {
      window.localStorage.setItem(
        DRAFT_STORAGE_KEY,
        JSON.stringify({ format, text } satisfies StoredDraft),
      );
      window.localStorage.setItem(FORMAT_STORAGE_KEY, format);
    } catch {
      // quota 超過などは無視 (draft が失われても全体は止めない)
    }
  }, [text, format]);

  const handleFormatChange = useCallback(
    (next: SourceFormat) => {
      if (next === format) return;
      // 直近 parse が成功している packet を新 format に書き直す。 失敗中
      // (= lastGood は古い) なら、ユーザーの未保存テキストを残す方が期待値
      // に近いので変換しない。
      if (!parseError) {
        try {
          setText(encodeSource(lastGood.packet, next));
        } catch {
          // 失敗時は text を据え置き — toggle だけ反映する
        }
      }
      setFormat(next);
    },
    [format, parseError, lastGood.packet],
  );

  const handlePresetChange = useCallback(
    (next: string) => {
      const packet = PRESETS[next];
      if (!packet) return;
      setPresetKey(next);
      setText(encodeSource(packet, format));
    },
    [format],
  );

  const handleReset = useCallback(() => {
    const packet = PRESETS[presetKey] ?? PRESETS[DEFAULT_PRESET_KEY];
    if (!packet) return;
    setText(encodeSource(packet, format));
  }, [presetKey, format]);

  const handleCopy = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard API failure — silently ignore (browser will surface its
      // own permission UI; nothing to recover here)
    }
  }, [text]);

  return (
    <main className="flex-1 max-w-[1400px] mx-auto px-6 py-4 w-full flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <h1 className="m-0 text-base font-semibold">PSML source editor</h1>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-fg-muted" htmlFor="src-preset">
            Preset
          </label>
          <select
            id="src-preset"
            value={presetKey}
            onChange={(e) => handlePresetChange(e.target.value)}
            className="text-xs px-2 py-1 rounded border bg-bg-subtle text-fg"
            style={{ borderColor: "var(--border)" }}
          >
            {PRESET_KEYS.map((k) => (
              <option key={k} value={k}>
                {PRESETS[k]?.name ?? k}
              </option>
            ))}
          </select>
          <div
            role="radiogroup"
            aria-label="Source format"
            className="inline-flex rounded border text-xs overflow-hidden"
            style={{ borderColor: "var(--border)" }}
          >
            {(["yaml", "json"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={format === f}
                onClick={() => handleFormatChange(f)}
                className="px-3 py-1 uppercase tracking-wide"
                style={{
                  background:
                    format === f ? "var(--accent)" : "var(--bg-subtle)",
                  color: format === f ? "var(--accent-fg)" : "var(--fg)",
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="text-xs px-2 py-1 rounded border bg-bg-subtle"
            style={{ borderColor: "var(--border)" }}
          >
            Copy
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="text-xs px-2 py-1 rounded border bg-bg-subtle"
            style={{ borderColor: "var(--border)" }}
          >
            Reset
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 flex-1 min-h-0">
        <div className="flex flex-col gap-2 min-h-[60vh]">
          <div className="flex-1 min-h-0">
            <SourceTextarea
              id="psml-source"
              ariaLabel={`PSML ${format.toUpperCase()} source`}
              value={text}
              onChange={setText}
              errorLine={parseError?.line ?? null}
            />
          </div>
          {parseError ? (
            <p
              role="alert"
              className="text-xs px-2 py-1 rounded border"
              style={{
                borderColor: "var(--field-rose, #b00020)",
                color: "var(--field-rose, #b00020)",
                background: "var(--bg-subtle)",
              }}
            >
              {parseError.line != null ? (
                <strong>Line {parseError.line}: </strong>
              ) : null}
              {parseError.message}
            </p>
          ) : (
            <p className="text-xs text-fg-faint m-0">
              PSML を直接編集すると右ペインに反映されます。
            </p>
          )}
        </div>
        <div className="min-h-[60vh] overflow-auto">
          <PreviewPanel packet={lastGood.packet} layout={lastGood.layout} />
        </div>
      </div>
    </main>
  );
}
