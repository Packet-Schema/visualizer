"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
 * PSML 直編集 pane — issue #87 の「Markdown エディタ風」 二分割 UI を
 * Custom Packet Studio の dispatch 経路に乗せた実装。
 *
 * 主要設計
 * --------
 * - YAML / JSON 切替。 YAML を default にして `data/presets/*.psml.yaml`
 *   と同じ書き味で authoring できるようにする。 JSON は import/export
 *   drawer と同じ on-wire shape (`format`/`version`) を吐く。
 * - 左 textarea (行番号付き) + 右 mini diagram preview の二分割。
 * - 入力に対して 200ms debounce で `replace-packet` を dispatch。 失敗中は
 *   最後に成功した packet/layout を preview に残し、 typo の度に diagram
 *   が消える regression を防ぐ。
 *
 * dispatch ループ防止のメカニズム
 * ----------------------------------
 * - `dirty` フラグで「ユーザーの編集による text change」 と 「upstream
 *   packet 変化 → text 再 encode」 を区別する。
 * - upstream sync は `if (!dirty)` ガードを置くので、 dispatch → reducer
 *   → packet 変化 → setText → dispatch のループが切れる。
 * - format toggle は明示的に dirty=false にして、 toggle 由来の text
 *   変更が dispatch を発火させないようにする (Round 1 P0 #1 対策)。
 *
 * a11y
 * ----
 * - format toggle は radiogroup として実装し、 ArrowLeft / ArrowRight の
 *   keyboard navigation を備える (WAI-ARIA APG 準拠)。
 * - mount 時に textarea へ自動 focus。
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

  // dispatch ref — 親が memoize していない実装でも debounce が再 attach
  // されないように、 useEffect の依存性から外す (Round 1 P0 #3 対策)。
  // `dispatch` は React の useReducer / useCallback で安定参照になる前提
  // だが、 useRef で間接化することで「親が誤って再生成しても本コンポー
  // ネントの debounce が壊れない」 という不変条件を担保する。
  const dispatchRef = useRef(dispatch);
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  // upstream (= reducer 側の packet) が変わった時、こちらが dirty で
  // なければ textarea を同期する。 dirty 中に上書きすると編集中の text
  // が飛ぶので避ける。 undo / redo / form 編集 / preset 切替で upstream
  // が変わった時、 dirty=false ならクリーンに sync される。
  useEffect(() => {
    if (!dirty) setText(upstreamText);
  }, [upstreamText, dirty]);

  // debounce で parse + dispatch。 dirty=true の時のみ走るので、 dispatch
  // 後の upstream sync が同じ effect を再起動して無限ループする経路はない。
  useEffect(() => {
    if (!dirty) return;
    const handle = window.setTimeout(() => {
      try {
        const next = decodeSource(text, format);
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
  }, [text, dirty, format]);

  // live preview 用の layout 計算。 dirty 中で parse 成功している場合は
  // text 由来の最新 packet を preview に渡す (= dispatch 完了を待たずに
  // diagram が更新)。 dirty=false なら upstream packet を使う。
  //
  // 副作用 (`previewRef.current = next`) は useEffect ではなく useMemo
  // の戻り値経由で React の通常 reconciliation に乗せる: 旧実装は useMemo
  // 内で ref を mutate していて StrictMode 二重 invocation で挙動が
  // 怪しかった (Round 1 P0 #2)。 ここでは ref を「直近成功 preview の
  // fallback cache」 として扱い、 計算自体は純粋に保つ。
  const previewRef = useRef<{
    packet: PsmlPacket;
    layout: ResolvedLayout;
  } | null>(null);
  const preview = useMemo(() => {
    const source = dirty ? safeDecode(text, format) : packet;
    if (source) {
      const layout = computeLayoutSafe(source);
      if (layout) return { packet: source, layout };
    }
    return previewRef.current;
  }, [text, format, dirty, packet]);
  // useMemo の戻り値を ref に反映する副作用は useEffect で行う。 React
  // 19 で useMemo の評価回数が変わってもこの synchronization は保たれる。
  useEffect(() => {
    if (preview) previewRef.current = preview;
  }, [preview]);

  // 初回マウント時の preview cache 充填。 upstream packet を layout に
  // 通せる前提で計算 (`validatePsmlPacket` を通った packet が渡されている
  // 前提)。
  const initialPreview = useMemo(() => {
    if (previewRef.current) return previewRef.current;
    const layout = computeLayoutSafe(packet);
    return layout ? { packet, layout } : null;
    // 初回 only — packet 変化は上の useMemo が処理する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const renderedPreview = preview ?? initialPreview;

  /**
   * format toggle ハンドラ — Round 1 P0 #1 / P1 #6 の race を畳んで処理する。
   *
   * - dirty=true (ユーザー編集中): まず pending debounce を強制発火して
   *   reducer に最新を確定させ、 dirty=false にしてから text を新 format
   *   で再 encode する。 こうすると「古い text が古い format で stale
   *   decode される」 race も「format toggle で未保存編集が消える」 race
   *   も両方起きない。
   * - dirty=false: そのまま upstream packet を新 format で encode して
   *   setText。
   * - parse error 中: text を据え置きにし、 format だけ切替。 ユーザーが
   *   未確定の編集を持ち続けられるようにする。
   */
  const handleFormatChange = useCallback(
    (next: SourceFormat) => {
      if (next === format) return;
      if (parseError) {
        setFormat(next);
        return;
      }
      const source = dirty ? safeDecode(text, format) : packet;
      if (!source) {
        // dirty だが decode 失敗 — まれ (parseError null かつ source null)。
        // text/dirty 据え置きで format だけ切替。
        setFormat(next);
        return;
      }
      if (dirty) {
        // 未保存編集を確定 — pending debounce timer は dispatch 後に
        // dirty=false になる前提だが、 ここで先に dispatch しておくと
        // 「toggle 直後に debounce が古い text を decode して再 dispatch
        // する」 race を防げる。
        dispatchRef.current({ type: "replace-packet", packet: source });
      }
      setText(encodeSource(source, next));
      setDirty(false);
      setFormat(next);
    },
    [format, parseError, dirty, text, packet],
  );

  const handleTextChange = useCallback((next: string) => {
    setText(next);
    setDirty(true);
  }, []);

  // a11y: ArrowLeft / ArrowRight で format toggle の隣項目に focus を移し、
  // Space / Enter で選択する。 role="radio" の WAI-ARIA APG に従う。
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const handleRadioKeyDown = useCallback(
    (
      e: React.KeyboardEvent<HTMLButtonElement>,
      idx: number,
      value: SourceFormat,
    ) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        const total = radioRefs.current.length;
        const nextIdx = (idx + dir + total) % total;
        const target = radioRefs.current[nextIdx];
        target?.focus();
        // APG の radio はフォーカス移動で値も切替えるパターンを採用する
        // (= "tab into selects" 動作)。 ここでは value も同時に変える。
        const formats: SourceFormat[] = ["yaml", "json"];
        handleFormatChange(formats[nextIdx]);
        return;
      }
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        handleFormatChange(value);
      }
    },
    [handleFormatChange],
  );

  // mount 時に textarea にカーソルを置く。 ユーザーが Edit source を
  // 押した直後にキー入力できる状態にする。
  const textareaWrapperRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const ta = textareaWrapperRef.current?.querySelector("textarea");
    ta?.focus();
  }, []);

  return (
    <section
      aria-label="PSML source pane"
      className="rounded-[10px] border px-4 py-3.5 mt-4"
      style={{
        background: "var(--bg-elevated)",
        borderColor: "var(--border)",
        boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-xs m-0 uppercase tracking-wider font-bold text-fg-muted">
          PSML source
        </h2>
        <div
          role="radiogroup"
          aria-label="Source format"
          className="inline-flex rounded border text-xs overflow-hidden"
          style={{ borderColor: "var(--border)" }}
        >
          {(["yaml", "json"] as const).map((f, idx) => (
            <button
              key={f}
              type="button"
              role="radio"
              ref={(el) => {
                radioRefs.current[idx] = el;
              }}
              aria-checked={format === f}
              tabIndex={format === f ? 0 : -1}
              onClick={() => handleFormatChange(f)}
              onKeyDown={(e) => handleRadioKeyDown(e, idx, f)}
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 min-h-[260px] lg:min-h-[360px]">
        <div
          className="min-h-[260px] lg:min-h-[360px]"
          ref={textareaWrapperRef}
        >
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
          aria-label="Live PSML preview"
        >
          {renderedPreview ? (
            <PreviewPanel
              packet={renderedPreview.packet}
              layout={renderedPreview.layout}
            />
          ) : (
            <p className="text-xs text-fg-faint italic m-2">
              Preview will appear once the source parses successfully.
            </p>
          )}
        </div>
      </div>
      {parseError ? (
        <p
          role="alert"
          aria-live="polite"
          className="text-xs mt-2 px-2 py-1 rounded border whitespace-pre-wrap"
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
        <p className="text-xs text-fg-faint mt-2 m-0">
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
