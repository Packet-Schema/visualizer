import { enrichDescriptionHtml } from "@/lib/enrich";

/**
 * 説明文を「RFC リンク + 略語注釈」付きの HTML として描画する共有コンポーネント。
 *
 * packet 全体の `description` と各 field の `doc` で表示挙動を揃えるため、
 * DetailPanel / FieldPopover / PacketViewer / PreviewPanel など description を
 * 出す箇所で共用する。
 *
 * `dangerouslySetInnerHTML` を使うが、安全性は入力ソースの信頼性ではなく、
 * `enrichDescriptionHtml` が生テキストを HTML エスケープしてから RFC リンク /
 * 略語注釈を付与することに由来する。そのため SourceEditor で編集された
 * user-authored な `packet.description` を渡しても XSS にはならない
 * （詳細は `lib/enrich.ts` を参照）。
 */
export function EnrichedText({ text }: { text: string }) {
  return (
    <span
      className="enriched-text"
      dangerouslySetInnerHTML={{ __html: enrichDescriptionHtml(text) }}
    />
  );
}
