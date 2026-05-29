"use client";

import { useEffect, useRef } from "react";

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { yaml } from "@codemirror/lang-yaml";
import { lintGutter, linter, type Diagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

import { lintSource } from "@/lib/psdl/source-format";

/**
 * PSDL (YAML) 用の構文ハイライトスタイル。 既存テーマ (CSS 変数) と
 * 噛み合わせるため `var(--category-*)` 系のトークンを直接当てている。
 * `@lezer/highlight` の tag は lang-yaml が emit するものに対応:
 *   - propertyName: マッピングのキー (`name:`, `body:` 等)
 *   - string / atom: スカラー値
 *   - number / bool: 数値・真偽値
 *   - keyword: アンカー (`*`/`&`) や document marker (`---`)
 *   - comment: コメント
 *   - punctuation: `:` / `-` / `,` / `[` / `]` / `{` / `}`
 */
const psdlYamlHighlight = HighlightStyle.define([
  {
    tag: [t.propertyName, t.tagName],
    color: "var(--accent, oklch(56% 0.16 250))",
    fontWeight: "600",
  },
  { tag: t.string, color: "var(--field-emerald, oklch(52% 0.13 145))" },
  {
    tag: [t.number, t.bool, t.null, t.atom],
    color: "var(--field-amber, oklch(55% 0.14 80))",
  },
  {
    tag: [t.keyword, t.modifier, t.definitionKeyword],
    color: "var(--field-violet, oklch(55% 0.16 295))",
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "var(--fg-faint, oklch(60% 0.02 260))",
    fontStyle: "italic",
  },
  {
    tag: [t.punctuation, t.separator, t.bracket],
    color: "var(--fg-muted, oklch(45% 0.02 260))",
  },
  { tag: t.invalid, color: "var(--field-rose, #b00020)" },
]);

type Props = {
  id: string;
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
  /** mount 直後に editor 内部にキャレットを置くか。 default true。 */
  autoFocus?: boolean;
};

/**
 * CodeMirror 6 で組んだ PSDL (YAML) エディタ。
 *
 * - `@codemirror/lang-yaml` で構文ハイライト + bracket matching + indent。
 * - `@codemirror/lint` 経由で `lintSource` を走らせ、 YAML syntax / PSDL
 *   schema / structural エラーをリアルタイム下線 + gutter マーカーで表示。
 * - controlled 風 API: 親が `value` を変えたら editor の doc を replace
 *   する。 ただし editor 内部で発生した変更 (= ユーザー入力) は onChange
 *   経由で親に通知し、 props.value と doc が一致したら no-op。
 *
 * SSR を回避するため "use client" を付けてある。 CodeMirror は完全に
 * browser-only。
 */
export default function SourceCodeMirror({
  id,
  value,
  onChange,
  ariaLabel,
  autoFocus = true,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // editor を一度だけ初期化。 props.value の変更は別 effect で同期する。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || viewRef.current) return;

    const editor = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          yaml(),
          // 構文ハイライト — yaml() は parser だけを供給するので、 token
          // を色に紐づける HighlightStyle を `syntaxHighlighting` で組み
          // 込まないと真っ黒のまま (Round 4 修正点)。
          syntaxHighlighting(psdlYamlHighlight),
          lintGutter(),
          linter((view) => buildDiagnostics(view.state.doc.toString())),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": ariaLabel,
            role: "textbox",
            id,
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              fontSize: "12px",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              background: "var(--bg-subtle)",
              color: "var(--fg)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
            },
            ".cm-scroller": {
              fontFamily: "inherit",
            },
            ".cm-gutters": {
              background: "var(--bg-elevated)",
              color: "var(--fg-faint)",
              border: "none",
              borderRight: "1px solid var(--border)",
            },
            ".cm-activeLineGutter, .cm-activeLine": {
              background: "transparent",
            },
          }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const next = u.state.doc.toString();
            onChangeRef.current(next);
          }),
        ],
      }),
    });
    viewRef.current = editor;
    if (autoFocus) {
      // mount 直後はまだ render が落ち着いていないので microtask に逃がす。
      Promise.resolve().then(() => {
        viewRef.current?.focus();
      });
    }
    return () => {
      editor.destroy();
      viewRef.current = null;
    };
    // 初期化は 1 回だけ。 ariaLabel / id 変更は実用上ありえないので依存に
    // 含めない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 親から `value` が変わったら editor の doc を replace。 ただし editor
  // 内部の text と一致する場合は no-op (= ユーザー入力 → onChange → 親 →
  // value 更新 の loop で diff が無い)。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return <div ref={hostRef} className="h-full min-h-[360px]" />;
}

/**
 * `lintSource` の結果を CodeMirror の `Diagnostic[]` に変換。 line 情報が
 * ある場合は当該行の先頭〜末尾、 無い場合 (= schema / structural error) は
 * doc 全体に gutter マーカーだけ出す。
 */
function buildDiagnostics(text: string): Diagnostic[] {
  const issues = lintSource(text);
  if (issues.length === 0) return [];
  return issues.map((issue) => {
    const { from, to } = rangeForLine(text, issue.line);
    return {
      from,
      to,
      severity: "error",
      message: issue.message,
      source: "PSDL",
    };
  });
}

function rangeForLine(
  text: string,
  line: number | null,
): {
  from: number;
  to: number;
} {
  if (line == null || line < 1)
    return { from: 0, to: Math.max(1, text.length) };
  // line は 1-based。 該当行の先頭 offset / 末尾 offset を求める。
  let lineNo = 1;
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (lineNo === line) break;
    if (text.charCodeAt(i) === 10 /* \n */) {
      lineNo++;
      lineStart = i + 1;
    }
  }
  let lineEnd = text.length;
  for (let i = lineStart; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lineEnd = i;
      break;
    }
  }
  // 空行のときは marker 幅 1 にして見えるようにする。
  if (lineEnd === lineStart) lineEnd = Math.min(text.length, lineStart + 1);
  return { from: lineStart, to: lineEnd };
}
