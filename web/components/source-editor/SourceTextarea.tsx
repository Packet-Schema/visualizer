"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ChangeEvent } from "react";

type Props = {
  id: string;
  value: string;
  onChange: (next: string) => void;
  /** 1-based error line — gutter で強調する。 */
  errorLine?: number | null;
  ariaLabel: string;
};

/**
 * 行番号付き monospace textarea。
 *
 * 構文ハイライトは入れていない (依存 bundle を増やさないため)。 textarea と
 * gutter を CSS grid で並べ、スクロールは textarea から gutter へ scrollTop
 * を同期させる。 後続で CodeMirror に差し替えたくなった時、ここのインター
 * フェースだけ維持すれば PreviewPanel 側は触らずに済む。
 */
export default function SourceTextarea({
  id,
  value,
  onChange,
  errorLine,
  ariaLabel,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const lineCount = useMemo(() => {
    // 空文字列でも 1 行扱いにする (gutter に "1" が出ないと寂しい)。
    const n = value.length === 0 ? 1 : value.split("\n").length;
    return n;
  }, [value]);

  // textarea 側のスクロール変化を gutter にミラーする。 React の state を
  // 経由するとフレーム落ちするので直 DOM 操作。
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    const gut = gutterRef.current;
    if (!ta || !gut) return;
    const sync = () => {
      gut.scrollTop = ta.scrollTop;
    };
    ta.addEventListener("scroll", sync, { passive: true });
    return () => ta.removeEventListener("scroll", sync);
  }, []);

  // 行数が変わった瞬間は scroll handler が発火しないので、明示同期。
  useEffect(() => {
    const ta = textareaRef.current;
    const gut = gutterRef.current;
    if (!ta || !gut) return;
    gut.scrollTop = ta.scrollTop;
  }, [lineCount]);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
  };

  return (
    <div
      className="grid grid-cols-[auto_1fr] h-full rounded border overflow-hidden bg-bg-subtle"
      style={{ borderColor: "var(--border)" }}
    >
      <div
        ref={gutterRef}
        aria-hidden="true"
        className="overflow-hidden select-none text-right px-2 py-2 text-xs leading-5 font-mono"
        style={{
          background: "var(--bg-elevated)",
          color: "var(--fg-faint)",
          borderRight: "1px solid var(--border)",
          minWidth: "3em",
        }}
      >
        {Array.from({ length: lineCount }, (_, i) => {
          const ln = i + 1;
          const isError = errorLine === ln;
          return (
            <div
              key={ln}
              className={isError ? "font-bold" : undefined}
              style={
                isError ? { color: "var(--field-rose, #b00020)" } : undefined
              }
            >
              {ln}
            </div>
          );
        })}
      </div>
      <textarea
        id={id}
        ref={textareaRef}
        aria-label={ariaLabel}
        spellCheck={false}
        wrap="off"
        value={value}
        onChange={handleChange}
        className="font-mono text-xs leading-5 p-2 outline-none resize-none bg-transparent text-fg"
        style={{
          tabSize: 2,
          minHeight: "100%",
        }}
      />
    </div>
  );
}
