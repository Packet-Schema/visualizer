"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import SourceTextarea from "@/components/source-editor/SourceTextarea";
import type { EditAction } from "@/lib/psml/edit-reducer";
import {
  decodeSource,
  encodeSource,
  SourceParseError,
} from "@/lib/psml/source-format";
import type { PsmlPacket } from "@/lib/psml/types";

type Props = {
  packet: PsmlPacket;
  dispatch: (a: EditAction) => void;
};

type ParseError = { message: string; line: number | null };

const DEBOUNCE_MS = 200;

/**
 * Custom Packet Studio の "source" ビュー — PSML を YAML で直編集する
 * 単純な textarea。 issue #87 の「Markdown エディタみたいに PSML を書ける」
 * 動線を「上部の diagram を live preview として共有」 の形で実装する。
 *
 * 注意点
 * ------
 * - **このコンポーネント内に diagram preview は持たない**。 上部の本物
 *   diagram (HybridDiagram) が studio reducer の最新 packet を映すので、
 *   ここで mini preview を出すと「同じ diagram が 2 個並ぶ」 視覚的混乱が
 *   起きる。 ユーザーは textarea を見ながら同時に上の diagram を見れば
 *   十分。
 * - **format は YAML 一択**。 PSML preset と同じ書き味で書ける YAML を
 *   canonical な authoring 形式にする。 wire JSON は import/export drawer
 *   経由で扱うので、 ここでは混入させない。
 * - studio reducer 経由で `replace-packet` を dispatch する。 dirty=true
 *   の間は upstream sync をスキップして、 ユーザーの type 中に textarea
 *   が勝手に上書きされる事故を防ぐ (旧 JsonPane と同じポリシー)。
 *
 * a11y
 * ----
 * - mount 時に textarea へ自動 focus、 すぐ書き始められる状態にする。
 */
export default function SourcePane({ packet, dispatch }: Props) {
  const upstreamText = encodeSource(packet);
  const [text, setText] = useState<string>(upstreamText);
  const [dirty, setDirty] = useState(false);
  const [parseError, setParseError] = useState<ParseError | null>(null);

  // dispatch ref — 親が memoize していない実装でも debounce が再 attach
  // されないように、 useEffect の依存性から外す。
  const dispatchRef = useRef(dispatch);
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  // upstream (= reducer 側の packet) が変わった時、 こちらが dirty で
  // なければ textarea を同期する。 dirty 中の上書きは編集中の text を
  // 飛ばすので避ける。 form view から戻ってきた時、 undo / redo / preset
  // 切替で upstream が変わった時、 dirty=false ならクリーンに sync される。
  useEffect(() => {
    if (!dirty) setText(upstreamText);
  }, [upstreamText, dirty]);

  // debounce で parse + dispatch。 dirty=true の時のみ走るので、 dispatch
  // 後の upstream sync が同じ effect を再起動して無限ループする経路はない。
  useEffect(() => {
    if (!dirty) return;
    const handle = window.setTimeout(() => {
      try {
        const next = decodeSource(text);
        setParseError(null);
        dispatchRef.current({ type: "replace-packet", packet: next });
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
  }, [text, dirty]);

  const handleTextChange = useCallback((next: string) => {
    setText(next);
    setDirty(true);
  }, []);

  /**
   * Discard — 未保存編集を捨てて upstream packet (= studio reducer の最新)
   * を再 encode した text に巻き戻す。 dirty / parseError 状態を解除する。
   */
  const handleDiscardLocal = useCallback(() => {
    setText(encodeSource(packet));
    setDirty(false);
    setParseError(null);
  }, [packet]);

  // mount 時に textarea にカーソルを置く。 GUI ↔ Source 切替直後に
  // すぐ書き始められる。
  const textareaWrapperRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const ta = textareaWrapperRef.current?.querySelector("textarea");
    ta?.focus();
  }, []);

  const canDiscard = dirty || parseError !== null;

  return (
    <section aria-label="PSML source editor" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-fg-muted uppercase tracking-wider font-bold">
          PSML source (YAML)
        </span>
        <button
          type="button"
          onClick={handleDiscardLocal}
          disabled={!canDiscard}
          aria-label="Discard unsaved source changes"
          className="text-xs px-2 py-1 rounded border"
          style={{
            borderColor: "var(--border)",
            background: "var(--bg-subtle)",
            opacity: canDiscard ? 1 : 0.5,
            cursor: canDiscard ? "pointer" : "not-allowed",
          }}
        >
          Discard
        </button>
      </div>
      <div className="min-h-[360px]" ref={textareaWrapperRef}>
        <SourceTextarea
          id="psml-source-pane"
          ariaLabel="PSML YAML source"
          value={text}
          onChange={handleTextChange}
          errorLine={parseError?.line ?? null}
        />
      </div>
      {parseError ? (
        <p
          role="alert"
          aria-live="polite"
          className="text-xs px-2 py-1 rounded border whitespace-pre-wrap"
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
          編集を {DEBOUNCE_MS}ms 静止すると上の diagram に反映されます。
        </p>
      )}
    </section>
  );
}
