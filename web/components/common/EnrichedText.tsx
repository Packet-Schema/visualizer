import { enrichDescriptionHtml } from "@/lib/enrich";

/**
 * 説明文を「RFC リンク + 略語注釈」付きの HTML として描画する共有コンポーネント。
 *
 * packet 全体の `description` と各 field の `doc` で表示挙動を揃えるため、
 * DetailPanel / PacketViewer / PreviewPanel など description を出す箇所で
 * 共用する。出力 HTML は curated な preset 由来の信頼テキストである前提で
 * `dangerouslySetInnerHTML` を使う（詳細は `lib/enrich.ts` を参照）。
 */
export function EnrichedText({ text }: { text: string }) {
  return (
    <span
      className="enriched-text"
      dangerouslySetInnerHTML={{ __html: enrichDescriptionHtml(text) }}
    />
  );
}
