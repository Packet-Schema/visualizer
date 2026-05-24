"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import PreviewPanel from "@/components/source-editor/PreviewPanel";
import SourceTextarea from "@/components/source-editor/SourceTextarea";
import type { EditAction } from "@/lib/psml/edit-reducer";
import { resolveLayout } from "@/lib/psml/layout";
import { initialEnv } from "@/lib/psml/normalize";
import { collectPsmlRefs } from "@/lib/psml/source-refs";
import {
  decodeSource,
  encodeSource,
  SourceParseError,
  type SourceFormat,
} from "@/lib/psml/source-format";
import type { ResolvedLayout } from "@/lib/psml/renderer";
import type { PsmlPacket } from "@/lib/psml/types";

type Props = {
  packet: PsmlPacket;
  dispatch: (a: EditAction) => void;
};

type ParseError = { message: string; line: number | null };

const DEBOUNCE_MS = 200;

/**
 * Custom Packet Studio の「source pane」 — issue #87 の「左に PSML を書ける
 * markdown エディタ風 UI」を、既存 editMode (Edit packet トグル) の動線に
 * 載せる形で提供する。
 *
 * 旧 `JsonPane` は packet を JSON.stringify した textarea 1 枚だった。
 * 本コンポーネントは:
 *   1. YAML / JSON 切替 (preset は元から YAML なので YAML を default に)
 *   2. 左に textarea (行番号付き)、右に live diagram preview の二分割
 *   3. パースは 200ms debounce で `replace-packet` を dispatch、エラー時は
 *      最後に成功した packet が studio reducer に残るので diagram は据置
 *
 * 親の Studio reducer から packet が押し戻されてきた時 (undo / form 編集)
 * は dirty でなければ textarea の内容を再 encode して同期する。
 */
export default function SourcePane({ packet, dispatch }: Props) {
  const [format, setFormat] = useState<SourceFormat>("yaml");
  const upstreamText = useMemo(
    () => encodeSource(packet, format),
    [packet, format],
  );
  const [text, setText] = useState<string>(upstreamText);
  const [dirty, setDirty] = useState(false);
  const [parseError, setParseError] = useState<ParseError | null>(null);

  // upstream (= reducer 側の packet) が変わった時、こちらが dirty で
  // なければ textarea を同期する。 dirty 中に上書きすると編集中の text が
  // 飛ぶ — 旧 JsonPane と同じポリシー。
  useEffect(() => {
    if (!dirty) setText(upstreamText);
  }, [upstreamText, dirty]);

  // debounce で parse + dispatch。 dirty が true の時しか走らないので
  // 親からの packet 更新ループは発生しない。
  useEffect(() => {
    if (!dirty) return;
    const handle = window.setTimeout(() => {
      try {
        const next = decodeSource(text, format);
        setParseError(null);
        dispatch({ type: "replace-packet", packet: next });
        // dispatch 直後に upstream が変わって useEffect で text が
        // 再 encode されると、ユーザーの空白などが整形されて差分が出る。
        // それを避けるため dirty=false にするのは upstream sync が走った
        // 次の render に任せる (= dispatch → reducer → packet → encode →
        // text === current text or 異なるが受け入れる)。
        setDirty(false);
      } catch (e) {
        if (e instanceof SourceParseError) {
          setParseError({ message: e.message, line: e.line });
        } else {
          setParseError({
            message: e instanceof Error ? e.message : String(e),
            line: null,
          });
        }
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [text, dirty, format, dispatch]);

  // live preview 用の layout を計算する。 dirty 中で parse 成功している
  // (= parseError 無し) の場合は text を再 decode した結果を preview に
  // 入れる。 そうすると debounce 前でも preview がほぼ即時に更新される。
  // dispatch を待つと 200ms のラグで diagram が遅れて見える。
  const previewRef = useRef<{ packet: PsmlPacket; layout: ResolvedLayout }>({
    packet,
    layout: computeLayoutSafe(packet) ?? makeEmptyLayout(),
  });
  const preview = useMemo(() => {
    // dirty 中は text を尊重、 dirty なしなら upstream packet を使う。
    const source: PsmlPacket | null = dirty ? safeDecode(text, format) : packet;
    if (!source) {
      // parse 中 — 直近の preview を返す。
      return previewRef.current;
    }
    const layout = computeLayoutSafe(source);
    if (!layout) return previewRef.current;
    const next = { packet: source, layout };
    previewRef.current = next;
    return next;
  }, [text, format, dirty, packet]);

  const handleFormatChange = (next: SourceFormat) => {
    if (next === format) return;
    if (!parseError) {
      // parse が通っている packet (= dirty 中なら text、そうでなければ
      // upstream) を新 format で書き直して text を更新する。
      const source = dirty ? safeDecode(text, format) : packet;
      if (source) setText(encodeSource(source, next));
    }
    // dirty フラグはそのまま据え置き — format toggle 由来の text 変更で
    // dispatch を発火させないようにする。
    setFormat(next);
  };

  const handleTextChange = (next: string) => {
    setText(next);
    setDirty(true);
  };

  return (
    <section
      aria-label="PSML source pane"
      className="flex flex-col gap-2 p-2 border-t bg-bg-elevated"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-xs text-fg-muted" htmlFor="psml-source-pane">
          PSML source
        </label>
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
                background: format === f ? "var(--accent)" : "var(--bg-subtle)",
                color: format === f ? "var(--accent-fg)" : "var(--fg)",
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 min-h-[360px]">
        <div className="min-h-[360px]">
          <SourceTextarea
            id="psml-source-pane"
            ariaLabel={`PSML ${format.toUpperCase()} source`}
            value={text}
            onChange={handleTextChange}
            errorLine={parseError?.line ?? null}
          />
        </div>
        <div
          className="overflow-auto rounded border p-2"
          style={{
            borderColor: "var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          <PreviewPanel packet={preview.packet} layout={preview.layout} />
        </div>
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
          編集を {DEBOUNCE_MS}ms 静止すると上の diagram にも反映されます。
        </p>
      )}
    </section>
  );
}

function safeDecode(text: string, format: SourceFormat): PsmlPacket | null {
  try {
    return decodeSource(text, format);
  } catch {
    return null;
  }
}

function computeLayoutSafe(packet: PsmlPacket): ResolvedLayout | null {
  try {
    const env = initialEnv(packet);
    for (const r of collectPsmlRefs(packet)) {
      if (!env.has(r)) env.set(r, 0);
    }
    return resolveLayout(packet, { env });
  } catch {
    return null;
  }
}

function makeEmptyLayout(): ResolvedLayout {
  return { cells: [], totalBits: 0 };
}
